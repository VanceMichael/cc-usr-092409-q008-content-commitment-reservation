/**
 * 领域服务：采购承诺与容量占用的全部命令逻辑。
 *
 * 不变量：
 *  1. 所有余额校验在预算池维度的键级锁内完成（检查与入账原子化）；
 *  2. 事件先落盘再更新投影，历史事件永不修改；
 *  3. 相同申请（幂等键）重试沿用原占用，条款变化产生新版本；
 *  4. 审批人不能审批自己提交的方案；
 *  5. 预测替代 / 汇率变化 / 项目延期 / 预算下调只重评未签约占用，
 *     已签合同只生成缺口处置提案，合同快照不可倒改；
 *  6. 取消、到期、合同终止以补偿事件释放容量；重评任务持久化，可续跑。
 */
import crypto from "node:crypto";
import { KeyedLock } from "./lock.js";
import {
  computeStress,
  fingerprint,
  reservedOf,
  termsFingerprint,
} from "./math.js";
import { Projection } from "./projections.js";
import { EventStore } from "./store.js";
import type {
  ApprovalRecord,
  ContractSnapshot,
  Currency,
  DealTerms,
  DomainEvent,
  ForecastAssumptions,
  ForecastVersion,
  FxVersion,
  GapProposal,
  MilestoneTerm,
  Money,
  OccupancyVersion,
  PoolKey,
  PoolVersion,
  ReevaluationJob,
  ReevaluationResult,
  StressRange,
  Waiver,
} from "./model.js";

export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
  }
}

const uuid = () => crypto.randomUUID();

export interface PoolInput {
  poolId?: string;
  key: PoolKey;
  minorUnit: number;
  limit: number;
  by: string;
  note?: string;
}

export interface ForecastInput {
  forecastId?: string;
  currency: string;
  minorUnit: number;
  periods: string[];
  assumptions: ForecastAssumptions;
  by: string;
}

export interface FxInput {
  rates: FxVersion["rates"];
  by: string;
}

export interface SubmitInput {
  proposalId?: string;
  idempotencyKey: string;
  projectId: string;
  poolId: string;
  forecastId: string;
  forecastVersion: number;
  terms: DealTerms;
  submittedBy: string;
  /** 占用有效期（小时），默认 14 天 */
  ttlHours?: number;
  expiresAt?: string;
}

export interface DelayInput {
  projectId: string;
  by: string;
  reason: string;
  revisedPeriod?: string;
  milestoneDueDates?: Record<string, string>;
}

export interface WaiverInput {
  proposalId: string;
  type: Waiver["type"];
  amount: number;
  grantedBy: string;
  reason: string;
}

const DEFAULT_TTL_HOURS = 14 * 24;

export class CommitmentService {
  private lock = new KeyedLock();

  constructor(
    private store: EventStore,
    private p: Projection,
  ) {}

  private now() {
    return new Date().toISOString();
  }

  private append<E extends DomainEvent>(event: E) {
    return this.store.append(event);
  }

  // ================================================================ 预算池

  publishPool(input: PoolInput): PoolVersion {
    if (!Number.isInteger(input.limit) || input.limit < 0) {
      throw new DomainError("INVALID_LIMIT", "预算总额必须是非负整数（minor unit）");
    }
    const existing = this.p.poolByDimensions(input.key);
    if (existing && input.minorUnit !== existing.minorUnit) {
      throw new DomainError("MINOR_UNIT_IMMUTABLE", "同一预算池维度线的币种精度不可改变");
    }
    const poolId = existing?.poolId ?? input.poolId ?? `pool-${uuid()}`;
    if (input.poolId && !existing && this.p.pool(input.poolId)) {
      throw new DomainError("POOL_ID_CONFLICT", `poolId ${input.poolId} 已被其他维度占用`);
    }
    const version = existing ? existing.version + 1 : 1;
    const pool: PoolVersion = {
      poolId,
      version,
      key: input.key,
      minorUnit: input.minorUnit,
      limit: input.limit,
      status: "published",
      publishedAt: this.now(),
      publishedBy: input.by,
      note: input.note,
    };
    this.append({ type: "PoolPublished", payload: pool });

    if (existing) {
      this.afterPoolChanged(pool, existing.limit);
      this.drainPendingJobsSync();
    }
    return pool;
  }

  closePool(poolId: string): void {
    const pool = this.requirePool(poolId);
    if (pool.status === "closed") return;
    this.append({ type: "PoolClosed", payload: { poolId, at: this.now() } });
  }

  /**
   * 预算池新版本发布后：
   *  - 未签约占用入队 pool_reduced 重评（按新限额重新判定余额）；
   *  - 已签合同总额超过新限额时，按承诺比例把缺口归因到每份合同并生成处置提案。
   *  历史合同金额不变。
   */
  private afterPoolChanged(pool: PoolVersion, oldLimit: number) {
    if (pool.limit >= oldLimit) return; // 预算上调不触发重评
    const at = this.now();
    for (const o of this.p.allOccupancies()) {
      if (o.poolId !== pool.poolId) continue;
      if (o.status === "pending_approval" || o.status === "approved") {
        this.enqueueJob(o, "pool_reduced", `pool:${pool.poolId}@v${pool.version}`, at);
      }
    }
    const activeContracts = [...this.p.contracts.values()].filter(
      (c) => c.poolId === pool.poolId && c.status === "active",
    );
    const signedTotal = activeContracts.reduce((s, c) => s + c.committedAmount, 0);
    const shortfall = signedTotal - pool.limit;
    if (shortfall > 0 && oldLimit !== pool.limit) {
      // 按合同承诺额比例分摊缺口，余数加到首份合同
      let attributed = 0;
      activeContracts.forEach((c, i) => {
        const share =
          i === activeContracts.length - 1
            ? shortfall - attributed
            : Math.round((c.committedAmount * shortfall) / signedTotal);
        attributed += share;
        this.createGap({
          contract: c,
          reason: "pool_reduced",
          triggerRef: `pool:${pool.poolId}@v${pool.version}`,
          currentStress: c.stress,
          currentAmount: c.committedAmount + share,
          suggested: "transfer_budget",
          at,
        });
      });
    }
  }

  // ================================================================ 预测

  publishForecast(input: ForecastInput): ForecastVersion {
    this.validateAssumptions(input.assumptions);
    const list = input.forecastId ? this.p.forecast(input.forecastId) : undefined;
    const forecastId = input.forecastId ?? `fc-${uuid()}`;
    const version = list ? list.version + 1 : 1;
    const forecast: ForecastVersion = {
      forecastId,
      version,
      currency: input.currency,
      minorUnit: input.minorUnit,
      periods: input.periods,
      assumptions: input.assumptions,
      status: "published",
      publishedAt: this.now(),
      publishedBy: input.by,
      fingerprint: fingerprint({
        revenue: input.assumptions.revenueByScenario,
        factors: input.assumptions.factors,
      }),
    };
    this.append({ type: "ForecastPublished", payload: forecast });
    // 同一条预测线发布新版本即“替代”：旧版置为 superseded 并触发重评
    if (list) {
      this.append({
        type: "ForecastSuperseded",
        payload: {
          forecastId,
          version: list.version,
          successor: { forecastId, version },
          at: this.now(),
        },
      });
      this.afterForecastReplaced(
        { forecastId, version: list.version },
        { forecastId, version },
      );
      this.drainPendingJobsSync();
    }
    return forecast;
  }

  /** 把一条已发布预测线整体替代到另一条（或同线的新版本） */
  supersedeForecast(
    oldId: string,
    successor: { forecastId: string; version: number },
  ): void {
    const old = this.p.forecast(oldId);
    if (!old) throw new DomainError("FORECAST_NOT_FOUND", `预测 ${oldId} 不存在`, 404);
    if (old.status !== "published") {
      throw new DomainError("FORECAST_NOT_PUBLISHED", `预测 ${oldId} 当前状态为 ${old.status}`);
    }
    const next = this.p.forecastAt(successor.forecastId, successor.version);
    if (!next || next.status !== "published") {
      throw new DomainError("SUCCESSOR_NOT_PUBLISHED", "替代预测版本不存在或未发布", 404);
    }
    this.append({
      type: "ForecastSuperseded",
      payload: {
        forecastId: oldId,
        version: old.version,
        successor,
        at: this.now(),
      },
    });
    this.afterForecastReplaced({ forecastId: oldId, version: old.version }, successor);
    this.drainPendingJobsSync();
  }

  private validateAssumptions(a: ForecastAssumptions) {
    for (const k of ["downside", "base", "upside"] as const) {
      if (!Number.isInteger(a.revenueByScenario[k]) || a.revenueByScenario[k] < 0) {
        throw new DomainError("INVALID_ASSUMPTION", `假设收入 ${k} 必须是非负整数`);
      }
    }
  }

  /** 预测替代的影响面：未签约占用 -> 重评任务；已签合同 -> 缺口提案 */
  private afterForecastReplaced(
    oldRef: { forecastId: string; version: number },
    newRef: { forecastId: string; version: number },
  ) {
    const at = this.now();
    const triggerRef = `${newRef.forecastId}@v${newRef.version}`;
    for (const o of this.p.allOccupancies()) {
      if (o.basis.forecastId !== oldRef.forecastId) continue;
      if (o.status === "pending_approval" || o.status === "approved") {
        this.enqueueJob(o, "forecast_superseded", triggerRef, at);
      }
    }
    for (const c of this.p.contracts.values()) {
      if (c.status !== "active" || c.basis.forecastId !== oldRef.forecastId) continue;
      const recomputed = this.recomputeContractStress(c, "forecast", newRef);
      const gapAmount = recomputed.base.total.amount - c.committedAmount;
      if (gapAmount > 0) {
        this.createGap({
          contract: c,
          reason: "forecast_superseded",
          triggerRef,
          currentStress: recomputed,
          currentAmount: recomputed.base.total.amount,
          suggested: "renegotiate_contract",
          at,
        });
      }
    }
  }

  // ================================================================ 汇率

  publishFx(input: FxInput): FxVersion {
    if (input.rates.some((r) => !(r.rate > 0) || !r.from || !r.to)) {
      throw new DomainError("INVALID_FX", "汇率必须是正值且标明币种对");
    }
    const version = this.p.latestFxVersion + 1;
    const fx: FxVersion = {
      version,
      rates: input.rates,
      publishedAt: this.now(),
      publishedBy: input.by,
    };
    this.append({ type: "FxPublished", payload: fx });
    if (version > 1) {
      this.afterFxChanged(version);
      this.drainPendingJobsSync();
    }
    return fx;
  }

  private afterFxChanged(version: number) {
    const at = this.now();
    const triggerRef = `fx@v${version}`;
    for (const o of this.p.allOccupancies()) {
      if (o.status !== "pending_approval" && o.status !== "approved") continue;
      // 汇率变化只影响真正跨币种的占用
      const pool = this.p.pool(o.poolId);
      if (!pool || !this.isCrossCurrency(o.terms, o.basis, pool)) continue;
      this.enqueueJob(o, "fx_changed", triggerRef, at);
    }
    // 已签合同按新汇率重估快照条款；只生成缺口，不改合同
    for (const c of this.p.contracts.values()) {
      if (c.status !== "active") continue;
      const recomputed = this.recomputeContractStress(c, "fx");
      const gapAmount = recomputed.base.total.amount - c.committedAmount;
      if (gapAmount > 0) {
        this.createGap({
          contract: c,
          reason: "fx_changed",
          triggerRef,
          currentStress: recomputed,
          currentAmount: recomputed.base.total.amount,
          suggested: "renegotiate_contract",
          at,
        });
      }
    }
  }

  private recomputeContractStress(
    c: ContractSnapshot,
    mode: "forecast" | "fx",
    ref?: { forecastId: string; version: number },
  ): StressRange {
    const pool = this.requirePool(c.poolId);
    if (mode === "fx") {
      // 纯同币种合同不受汇率版本影响，现值即签署快照
      if (
        c.terms.guarantee.currency === pool.key.currency &&
        c.basis.forecastCurrency === pool.key.currency
      ) {
        return c.stress;
      }
    }
    const forecast =
      mode === "forecast" && ref
        ? this.p.forecastAt(ref.forecastId, ref.version)
        : // 汇率变化时沿用签署时冻结的预测版本
          this.p.forecastAt(c.basis.forecastId, c.basis.forecastVersion);
    if (!forecast) {
      throw new DomainError("FORECAST_NOT_FOUND", "重算所需的预测版本不存在", 409);
    }
    const fx = this.requireLatestFx();
    return computeStress({
      terms: c.terms,
      assumptions: forecast.assumptions,
      fx,
      poolCurrency: pool.key.currency,
      poolMinorUnit: pool.minorUnit,
      forecastCurrency: forecast.currency,
      forecastMinorUnit: forecast.minorUnit,
    });
  }

  // ================================================================ 申请 / 占用

  submitProposal(input: SubmitInput): Promise<{
    proposalId: string;
    version: number;
    reused: boolean;
    occupancy: OccupancyVersion;
  }> {
    if (!input.idempotencyKey) {
      throw new DomainError("IDEMPOTENCY_REQUIRED", "申请必须携带幂等键");
    }
    this.validateTerms(input.terms);

    const knownId = this.p.idempotency.get(input.idempotencyKey);
    const proposalId = input.proposalId ?? knownId ?? `prop-${uuid()}`;
    if (knownId && input.proposalId && knownId !== input.proposalId) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "该幂等键已属于另一个方案",
        409,
      );
    }

    return this.lock.run(`pool:${input.poolId}`, () => {
      const pool = this.requirePool(input.poolId);
      if (pool.status === "closed") {
        throw new DomainError("POOL_CLOSED", `预算池 ${input.poolId} 已关闭`);
      }
      const forecast = this.p.forecastAt(input.forecastId, input.forecastVersion);
      if (!forecast) {
        throw new DomainError("FORECAST_NOT_FOUND", "引用的预测版本不存在", 404);
      }
      if (forecast.status !== "published") {
        throw new DomainError(
          "FORECAST_SUPERSEDED",
          "谈判方案只能引用已发布（未被替代）的预测版本",
          409,
        );
      }
      const fx = this.resolveFx([
        input.terms.guarantee.currency,
        pool.key.currency,
        forecast.currency,
      ]);

      const stress = computeStress({
        terms: input.terms,
        assumptions: forecast.assumptions,
        fx,
        poolCurrency: pool.key.currency,
        poolMinorUnit: pool.minorUnit,
        forecastCurrency: forecast.currency,
        forecastMinorUnit: forecast.minorUnit,
      });
      const reserved = reservedOf(stress);
      const fp = termsFingerprint(input.terms);

      const lineVersion = this.p.latestVersionOf(proposalId);
      const current =
        lineVersion !== undefined
          ? this.p.occupancyVersion(proposalId, lineVersion)
          : undefined;
      if (knownId && current && current.projectId !== input.projectId) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "幂等键已被其他项目使用", 409);
      }

      // 幂等重试：活跃占用且条款未变 -> 原样返回，不产生新事件、不重复占容量
      if (
        current &&
        (current.status === "pending_approval" || current.status === "approved") &&
        current.termsFingerprint === fp
      ) {
        return { proposalId, version: current.version, reused: true, occupancy: current };
      }

      // 终结/驳回状态下相同请求原样报错，保证幂等键语义稳定
      if (current && current.termsFingerprint === fp) {
        throw new DomainError(
          "PROPOSAL_TERMINAL",
          `方案当前状态为 ${current.status}；相同申请不可重试，调整条款或使用新幂等键发起新申请`,
          409,
        );
      }

      // 签约/终止合同不允许改条款
      if (current && (current.status === "signed" || current.status === "terminated")) {
        throw new DomainError(
          "PROPOSAL_TERMINAL",
          "方案已签约或终止，不能修改；请发起新方案",
          409,
        );
      }

      const othersReserved = this.p.reservedNetExcept(pool.poolId, proposalId);
      const signed = this.p.signedCommitted(pool.poolId);
      if (signed + othersReserved + reserved > pool.limit) {
        throw new DomainError(
          "INSUFFICIENT_BALANCE",
          "预算池余额不足，容量占用被拒绝",
          409,
          {
            poolLimit: pool.limit,
            signedCommitted: signed,
            otherOccupied: othersReserved,
            requested: reserved,
            available: pool.limit - signed - othersReserved,
          },
        );
      }

      const version = current ? current.version + 1 : 1;
      const expiresAt =
        input.expiresAt ??
        new Date(Date.now() + (input.ttlHours ?? DEFAULT_TTL_HOURS) * 3600_000).toISOString();
      const occupancy: OccupancyVersion = {
        version,
        proposalId,
        projectId: input.projectId,
        poolId: input.poolId,
        terms: input.terms,
        basis: {
          poolId: pool.poolId,
          poolVersion: pool.version,
          forecastId: forecast.forecastId,
          forecastVersion: forecast.version,
          forecastCurrency: forecast.currency,
          forecastMinorUnit: forecast.minorUnit,
          fxVersion: fx.version,
          assumptionsSnapshot: structuredClone(forecast.assumptions),
        },
        stress,
        reservedAmount: reserved,
        expiresAt,
        status: "pending_approval",
        submittedBy: input.submittedBy,
        submittedAt: this.now(),
        idempotencyKey: input.idempotencyKey,
        termsFingerprint: fp,
      };
      this.append({
        type: "ProposalSubmitted",
        payload: { occupancy, reused: false },
      });
      return {
        proposalId,
        version,
        reused: false,
        occupancy: this.p.occupancy(proposalId)!,
      };
    });
  }

  /** 审批（通过/拒绝）。审批人不能是提交人本人。 */
  decide(
    proposalId: string,
    approver: string,
    decision: "approved" | "rejected",
    comment?: string,
  ): ApprovalRecord {
    const occupancy = this.requireOccupancy(proposalId);
    if (occupancy.status !== "pending_approval" && occupancy.status !== "approved") {
      throw new DomainError(
        "PROPOSAL_NOT_OPEN",
        `方案当前状态 ${occupancy.status}，不可审批`,
        409,
      );
    }
    if (approver === occupancy.submittedBy) {
      throw new DomainError(
        "SELF_APPROVAL_FORBIDDEN",
        "审批人不能批准自己提交的方案",
        403,
      );
    }
    const record: ApprovalRecord = {
      proposalId,
      occupancyVersion: occupancy.version,
      approver,
      decision,
      decidedAt: this.now(),
      comment,
    };

    if (decision === "rejected") {
      this.append({ type: "ProposalRejected", payload: record });
      return record;
    }

    let resolvedWaiver: Waiver | undefined;
    if (occupancy.breach) {
      resolvedWaiver = this.requireCoveringWaiver(
        proposalId,
        occupancy.version,
        occupancy.breach.shortfall,
      );
    }
    this.append({
      type: "ProposalApproved",
      payload: resolvedWaiver ? { ...record, waiverId: resolvedWaiver.waiverId } : record,
    });
    return record;
  }

  /** 签约：冻结签署时的预算版本、预测版本、汇率版本、条款与压力区间 */
  sign(proposalId: string, signer: string): Promise<ContractSnapshot> {
    return this.lock.run(`pool:${this.requireOccupancy(proposalId).poolId}`, () => {
      const occupancy = this.requireOccupancy(proposalId);
      if (occupancy.status !== "approved") {
        throw new DomainError(
          "NOT_APPROVED",
          `方案当前状态 ${occupancy.status}，只有已批准方案可签约`,
          409,
        );
      }
      if (occupancy.breach) {
        this.requireCoveringWaiver(
          proposalId,
          occupancy.version,
          occupancy.breach.shortfall,
        );
      }
      const contract: ContractSnapshot = {
        contractId: `ctr-${uuid()}`,
        proposalId,
        projectId: occupancy.projectId,
        poolId: occupancy.poolId,
        signedAt: this.now(),
        signedBy: signer,
        occupancyVersion: occupancy.version,
        terms: structuredClone(occupancy.terms),
        basis: structuredClone(occupancy.basis),
        stress: structuredClone(occupancy.stress),
        committedAmount: occupancy.reservedAmount,
        status: "active",
      };
      this.append({ type: "ContractSigned", payload: contract });
      return this.p.contracts.get(contract.contractId)!;
    });
  }

  /** 取消未签约方案：补偿事件释放占用 */
  cancel(proposalId: string, reason: string) {
    return this.lock.run(`pool:${this.requireOccupancy(proposalId).poolId}`, () => {
      const o = this.requireOccupancy(proposalId);
      if (o.status !== "pending_approval" && o.status !== "approved") {
        throw new DomainError("PROPOSAL_NOT_OPEN", "只有未签约方案可取消", 409);
      }
      const compensation = {
        eventId: `cmp-${uuid()}`,
        proposalId,
        poolId: o.poolId,
        kind: "cancellation" as const,
        releasedAmount: o.reservedAmount,
        at: this.now(),
        reason,
      };
      this.append({ type: "ProposalCancelled", payload: compensation });
      return compensation;
    });
  }

  /** 终止已签合同：补偿事件释放承诺容量（合同记录保留终止状态，不删除） */
  terminate(contractId: string, reason: string) {
    const c = this.p.contracts.get(contractId);
    if (!c) throw new DomainError("CONTRACT_NOT_FOUND", "合同不存在", 404);
    if (c.status !== "active") {
      throw new DomainError("CONTRACT_NOT_ACTIVE", "合同已终止", 409);
    }
    return this.lock.run(`pool:${c.poolId}`, () => {
      const compensation = {
        eventId: `cmp-${uuid()}`,
        proposalId: c.proposalId,
        contractId: c.contractId,
        poolId: c.poolId,
        kind: "termination" as const,
        releasedAmount: c.committedAmount,
        at: this.now(),
        reason,
      };
      this.append({ type: "ContractTerminated", payload: compensation });
      return compensation;
    });
  }

  // ================================================================ 项目延期

  /**
   * 项目延期：未签约占用入 project_delayed 重评任务（携带修订的里程碑日期/
   * 目标期间）；已签合同生成重谈类缺口提案，金额快照不动。
   */
  projectDelay(input: DelayInput): { jobs: number; gaps: number } {
    const at = this.now();
    let jobs = 0;
    let gaps = 0;
    for (const o of this.p.allOccupancies()) {
      if (o.projectId !== input.projectId) continue;
      if (o.status === "pending_approval" || o.status === "approved") {
        this.enqueueJob(o, "project_delayed", `project:${input.projectId}:delay`, at, {
          revisedPeriod: input.revisedPeriod,
          milestoneDueDates: input.milestoneDueDates,
          reason: input.reason,
        });
        jobs++;
      }
    }
    for (const c of this.p.contracts.values()) {
      if (c.status !== "active" || c.projectId !== input.projectId) continue;
      // 已签合同不因延期倒改金额：生成重谈类缺口提案
      this.createGap({
        contract: c,
        reason: "project_delayed",
        triggerRef: `project:${input.projectId}:delay`,
        currentStress: c.stress,
        currentAmount: c.committedAmount,
        suggested: "renegotiate_contract",
        at,
      });
      gaps++;
    }
    this.drainPendingJobsSync();
    return { jobs, gaps };
  }

  // ================================================================ 豁免与缺口

  grantWaiver(input: WaiverInput): Waiver {
    const o = this.p.occupancy(input.proposalId);
    if (!o) throw new DomainError("PROPOSAL_NOT_FOUND", "方案不存在", 404);
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new DomainError("INVALID_WAIVER", "豁免金额必须是正整数");
    }
    const waiver: Waiver = {
      waiverId: `wvr-${uuid()}`,
      proposalId: input.proposalId,
      occupancyVersion: o.version,
      poolId: o.poolId,
      type: input.type,
      amount: input.amount,
      grantedBy: input.grantedBy,
      grantedAt: this.now(),
      reason: input.reason,
    };
    this.append({ type: "WaiverGranted", payload: waiver });
    return this.p.waivers.get(waiver.waiverId)!;
  }

  revokeWaiver(waiverId: string): void {
    const w = this.p.waivers.get(waiverId);
    if (!w) throw new DomainError("WAIVER_NOT_FOUND", "豁免不存在", 404);
    if (w.revokedAt) return;
    this.append({
      type: "WaiverRevoked",
      payload: { waiverId, revokedAt: this.now() },
    });
  }

  private requireCoveringWaiver(
    proposalId: string,
    version: number,
    shortfall: number,
  ): Waiver {
    const candidates = [...this.p.waivers.values()].filter(
      (w) =>
        w.proposalId === proposalId &&
        !w.revokedAt &&
        w.occupancyVersion === version &&
        w.amount >= shortfall &&
        (w.type === "insufficient_balance" || w.type === "reevaluation_override"),
    );
    if (candidates.length === 0) {
      throw new DomainError(
        "WAIVER_REQUIRED",
        "重评后容量不足，必须取得覆盖缺口的有效人工豁免后才能审批/签约",
        409,
        { shortfall },
      );
    }
    return candidates[0];
  }

  resolveGap(
    gapId: string,
    kind: GapProposal["suggestedResolution"],
    by: string,
    note: string,
    waiverId?: string,
  ): GapProposal {
    const gap = this.p.gaps.find((g) => g.gapId === gapId);
    if (!gap) throw new DomainError("GAP_NOT_FOUND", "缺口提案不存在", 404);
    if (gap.status !== "open") {
      throw new DomainError("GAP_NOT_OPEN", "缺口提案已处理", 409);
    }
    let resolvedWaiver: Waiver | undefined;
    if (kind === "accept_via_waiver") {
      if (!waiverId) throw new DomainError("WAIVER_REQUIRED", "承接风险必须提供豁免");
      const w = this.p.waivers.get(waiverId);
      if (
        !w ||
        w.revokedAt ||
        w.proposalId !== gap.proposalId ||
        w.type !== "gap_acceptance" ||
        w.amount < gap.gapAmount
      ) {
        throw new DomainError("WAIVER_INVALID", "豁免不存在、已撤销或金额不足", 409);
      }
      resolvedWaiver = w;
    }
    const resolution = {
      kind,
      waiverId: resolvedWaiver?.waiverId,
      resolvedBy: by,
      resolvedAt: this.now(),
      note,
    };
    this.append({
      type: "GapProposalResolved",
      payload: { gapId, resolution },
    });
    return this.p.gaps.find((g) => g.gapId === gapId)!;
  }

  private createGap(params: {
    contract: ContractSnapshot;
    reason: GapProposal["reason"];
    triggerRef: string;
    currentStress: StressRange;
    currentAmount: number;
    suggested: GapProposal["suggestedResolution"];
    at: string;
  }): GapProposal {
    // 同一合同 + 同一触发源只生成一份未结提案，避免重复事件刷屏
    const duplicate = this.p.gaps.some(
      (g) =>
        g.contractId === params.contract.contractId &&
        g.status === "open" &&
        g.triggerRef === params.triggerRef,
    );
    if (duplicate) return this.p.gaps.find((g) => g.contractId === params.contract.contractId)!;
    const gap: GapProposal = {
      gapId: `gap-${uuid()}`,
      contractId: params.contract.contractId,
      proposalId: params.contract.proposalId,
      poolId: params.contract.poolId,
      createdAt: params.at,
      reason: params.reason,
      triggerRef: params.triggerRef,
      currentStress: params.currentStress,
      snapshotAmount: params.contract.committedAmount,
      currentAmount: params.currentAmount,
      gapAmount: params.currentAmount - params.contract.committedAmount,
      suggestedResolution: params.suggested,
      status: "open",
    };
    this.append({ type: "GapProposalCreated", payload: gap });
    return this.p.gaps.find((g) => g.gapId === gap.gapId)!;
  }

  // ================================================================ 重评任务

  private enqueueJob(
    o: OccupancyVersion,
    reason: ReevaluationResult["reason"],
    triggerRef: string,
    at: string,
    input?: ReevaluationJob["input"],
  ): ReevaluationJob {
    // 同一占用版本 + 同一触发源不重复入队
    const dup = [...this.p.jobs.values()].find(
      (j) =>
        j.proposalId === o.proposalId &&
        j.occupancyVersion === o.version &&
        j.triggerRef === triggerRef &&
        j.status === "pending",
    );
    if (dup) return dup;
    const job: ReevaluationJob = {
      jobId: `job-${uuid()}`,
      proposalId: o.proposalId,
      occupancyVersion: o.version,
      reason,
      triggerRef,
      status: "pending",
      attempts: 0,
      createdAt: at,
      input,
    };
    this.append({ type: "ReevaluationJobEnqueued", payload: job });
    return this.p.jobs.get(job.jobId)!;
  }

  /**
   * 同步排空当前全部待处理任务（触发命令内调用）：
   * Node 单线程内同步执行到完成，期间不会插入其他申请；
   * 单个任务失败保留 pending 并记录 attempts，交由维护/重启续跑。
   */
  private drainPendingJobsSync(): { processed: number; deferred: number } {
    let processed = 0;
    let deferred = 0;
    const pending = this.p.pendingJobs();
    for (const job of pending) {
      try {
        this.runOneJob(job.jobId);
        processed++;
      } catch (err) {
        deferred++;
        const current = this.p.jobs.get(job.jobId)!;
        const retry: ReevaluationJob = {
          ...current,
          status: "pending",
          attempts: current.attempts + 1,
          error: err instanceof Error ? err.message : String(err),
        };
        this.append({ type: "ReevaluationJobFailed", payload: retry });
      }
    }
    return { processed, deferred };
  }

  /**
   * 处理全部待处理重评任务（启动恢复时与定时维护时调用）。
   * 每个任务在所属预算池锁内执行；意外错误标记后保留 pending 待续跑。
   */
  async processReevaluationJobs(): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;
    for (const job of this.p.pendingJobs()) {
      const o = this.p.occupancy(job.proposalId);
      const poolId = o?.poolId ?? "";
      try {
        await this.lock.run(`pool:${poolId}`, () => {
          this.runOneJob(job.jobId);
        });
        processed++;
      } catch (err) {
        failed++;
        const failedJob: ReevaluationJob = {
          ...this.p.jobs.get(job.jobId)!,
          status: "pending", // 保留待处理，重启/下轮续跑
          attempts: this.p.jobs.get(job.jobId)!.attempts + 1,
          error: err instanceof Error ? err.message : String(err),
        };
        this.append({ type: "ReevaluationJobFailed", payload: failedJob });
      }
    }
    return { processed, failed };
  }

  private runOneJob(jobId: string) {
    const job = this.p.jobs.get(jobId);
    if (!job || job.status !== "pending") return;
    const o = this.p.occupancy(job.proposalId);
    if (!o) {
      this.completeJob(job, "占用已不存在");
      return;
    }
    // 只重评尚未签约且未终结的占用；期间已签约/取消/到期则直接完成任务
    if (o.status !== "pending_approval" && o.status !== "approved") {
      this.completeJob(job);
      return;
    }

    const pool = this.requirePool(o.poolId);
    let terms = structuredClone(o.terms);
    let basis = structuredClone(o.basis);

    if (job.reason === "forecast_superseded") {
      const atIndex = job.triggerRef.lastIndexOf("@v");
      const successorId = job.triggerRef.slice(0, atIndex);
      const successorVersion = Number(job.triggerRef.slice(atIndex + 2));
      const forecast = this.p.forecastAt(successorId, successorVersion);
      if (!forecast || forecast.status !== "published") {
        throw new DomainError(
          "SUCCESSOR_NOT_READY",
          `替代预测 ${job.triggerRef} 尚不可用，任务延后重试`,
          409,
        );
      }
      const fx = this.fxForBasis(forecast.currency, pool.key.currency, terms, basis.fxVersion);
      basis = {
        ...basis,
        poolVersion: pool.version,
        forecastId: forecast.forecastId,
        forecastVersion: forecast.version,
        forecastCurrency: forecast.currency,
        forecastMinorUnit: forecast.minorUnit,
        fxVersion: fx.version,
        assumptionsSnapshot: structuredClone(forecast.assumptions),
      };
    } else if (job.reason === "fx_changed") {
      const forecast = this.currentForecastFor(basis.forecastId);
      const fx = this.fxForBasis(forecast.currency, pool.key.currency, terms, basis.fxVersion);
      basis = {
        ...basis,
        poolVersion: pool.version,
        forecastId: forecast.forecastId,
        forecastVersion: forecast.version,
        forecastCurrency: forecast.currency,
        forecastMinorUnit: forecast.minorUnit,
        fxVersion: fx.version,
        assumptionsSnapshot: structuredClone(forecast.assumptions),
      };
    } else if (job.reason === "project_delayed") {
      if (job.input?.milestoneDueDates) {
        terms = {
          ...terms,
          milestones: terms.milestones.map((m: MilestoneTerm) =>
            job.input!.milestoneDueDates![m.code]
              ? { ...m, dueDate: job.input!.milestoneDueDates![m.code] }
              : m,
          ),
        };
      }
      const forecast = this.currentForecastFor(basis.forecastId);
      const fx = this.fxForBasis(forecast.currency, pool.key.currency, terms, basis.fxVersion);
      basis = {
        ...basis,
        poolVersion: pool.version,
        forecastId: forecast.forecastId,
        forecastVersion: forecast.version,
        forecastCurrency: forecast.currency,
        forecastMinorUnit: forecast.minorUnit,
        fxVersion: fx.version,
        assumptionsSnapshot: structuredClone(forecast.assumptions),
      };
    } else if (job.reason === "pool_reduced") {
      basis = { ...basis, poolVersion: pool.version };
    }

    const forecast = this.p.forecastAt(basis.forecastId, basis.forecastVersion)!;
    const fx = this.requireFxVersion(basis.fxVersion);
    const stress = computeStress({
      terms,
      assumptions: basis.assumptionsSnapshot,
      fx,
      poolCurrency: pool.key.currency,
      poolMinorUnit: pool.minorUnit,
      forecastCurrency: forecast.currency,
      forecastMinorUnit: forecast.minorUnit,
    });
    const reserved = reservedOf(stress);
    const delta = reserved - o.reservedAmount;
    const othersReserved = this.p.reservedNetExcept(pool.poolId, o.proposalId);
    const fits = this.p.signedCommitted(pool.poolId) + othersReserved + reserved <= pool.limit;
    const result: ReevaluationResult = {
      at: this.now(),
      reason: job.reason,
      triggerRef: job.triggerRef,
      stress,
      reservedAmount: reserved,
      delta,
      fits,
      shortfall: fits
        ? undefined
        : this.p.signedCommitted(pool.poolId) + othersReserved + reserved - pool.limit,
    };

    const next: OccupancyVersion = {
      ...o,
      version: o.version + 1,
      terms,
      basis,
      stress,
      reservedAmount: reserved,
      // 依据变化后，原批准不再代表当前口径：已批准方案打回待审批
      status: o.status === "approved" ? "pending_approval" : o.status,
      submittedAt: this.now(),
      termsFingerprint: termsFingerprint(terms),
      lastReevaluation: result,
      breach: fits
        ? undefined
        : { at: result.at, reason: job.reason, shortfall: result.shortfall! },
    };
    this.append({ type: "OccupancyReevaluated", payload: { occupancy: next, result } });
    this.completeJob(job);
  }

  private completeJob(job: ReevaluationJob, _note?: string) {
    const done: ReevaluationJob = {
      ...this.p.jobs.get(job.jobId)!,
      status: "done",
      processedAt: this.now(),
    };
    this.append({ type: "ReevaluationJobCompleted", payload: done });
  }

  /** 到期扫描：超过有效期仍未签约的占用通过补偿事件释放 */
  async scanExpiries(asOf = new Date().toISOString()): Promise<number> {
    const due = this.p
      .allOccupancies()
      .filter(
        (o) =>
          (o.status === "pending_approval" || o.status === "approved") &&
          o.expiresAt <= asOf,
      );
    const results = await Promise.all(
      due.map((o) =>
        this.lock.run(`pool:${o.poolId}`, (): boolean => {
          // 双重检查：拿到锁后状态可能已变
          const latest = this.p.occupancy(o.proposalId);
          if (
            !latest ||
            (latest.status !== "pending_approval" && latest.status !== "approved") ||
            latest.expiresAt > asOf
          ) {
            return false;
          }
          this.append({
            type: "ProposalExpired",
            payload: {
              eventId: `cmp-${uuid()}`,
              proposalId: latest.proposalId,
              poolId: latest.poolId,
              kind: "expiry",
              releasedAmount: latest.reservedAmount,
              at: this.now(),
              reason: `占用有效期截止 ${latest.expiresAt}`,
            },
          });
          return true;
        }),
      ),
    );
    return results.filter(Boolean).length;
  }

  // ================================================================ 校验/取数

  private requirePool(poolId: string): PoolVersion {
    const pool = this.p.pool(poolId);
    if (!pool) throw new DomainError("POOL_NOT_FOUND", `预算池 ${poolId} 不存在`, 404);
    return pool;
  }

  private requireOccupancy(proposalId: string): OccupancyVersion {
    const o = this.p.occupancy(proposalId);
    if (!o) throw new DomainError("PROPOSAL_NOT_FOUND", `方案 ${proposalId} 不存在`, 404);
    return o;
  }

  private requireLatestFx(): FxVersion {
    const fx = this.p.latestFx();
    if (fx) return fx;
    // 无跨币种换算时允许使用空汇率表的 0 号版本
    return { version: 0, rates: [], publishedAt: new Date(0).toISOString(), publishedBy: "system" };
  }

  private requireFxVersion(version: number): FxVersion {
    if (version === 0) {
      return { version: 0, rates: [], publishedAt: new Date(0).toISOString(), publishedBy: "system" };
    }
    const fx = this.p.fx(version);
    if (!fx) throw new DomainError("FX_NOT_FOUND", `汇率版本 ${version} 不存在`, 409);
    return fx;
  }

  /**
   * 沿 forecast 线的替代链找到当前 published 版本；
   * 被跨线替代时跟随 supersededBy。
   */
  private currentForecastFor(forecastId: string): ForecastVersion {
    let current = this.p.forecast(forecastId);
    if (!current) {
      throw new DomainError("FORECAST_NOT_FOUND", `预测 ${forecastId} 不存在`, 409);
    }
    const guard = new Set<string>();
    while (current.status === "superseded" && current.supersededBy) {
      const ref = current.supersededBy;
      const key = `${ref.forecastId}@v${ref.version}`;
      if (guard.has(key)) break;
      guard.add(key);
      const next = this.p.forecastAt(ref.forecastId, ref.version);
      if (!next) break;
      current = next;
    }
    return current;
  }

  /**
   * 选择重评使用的汇率版本：涉及跨币种时必须用最新汇率版本；
   * 全部同币种则沿用原依据版本（通常为 0）。
   */
  private fxForBasis(
    forecastCurrency: string,
    poolCurrency: string,
    terms: DealTerms,
    currentFxVersion: number,
  ): FxVersion {
    const contractCurrency = terms.guarantee.currency;
    const sameCurrency =
      forecastCurrency === poolCurrency && contractCurrency === poolCurrency;
    if (sameCurrency) return this.requireFxVersion(currentFxVersion);
    return this.requireLatestFx();
  }

  /** 占用是否真正涉及跨币种换算（否则汇率版本变化与其无关） */
  private isCrossCurrency(
    terms: DealTerms,
    basis: { forecastCurrency: Currency },
    pool: PoolVersion,
  ): boolean {
    const contractCurrency = terms.guarantee.currency;
    return (
      contractCurrency !== pool.key.currency ||
      basis.forecastCurrency !== pool.key.currency
    );
  }

  /** 涉及跨币种时必须存在已发布汇率版本 */
  private resolveFx(currencies: string[]): FxVersion {
    const unique = [...new Set(currencies)];
    const fx = this.p.latestFx();
    if (unique.length === 1) {
      return fx ?? {
        version: 0,
        rates: [],
        publishedAt: new Date(0).toISOString(),
        publishedBy: "system",
      };
    }
    if (!fx) {
      throw new DomainError("FX_REQUIRED", "跨币种申请前必须先发布汇率版本", 409);
    }
    return fx;
  }

  private validateTerms(terms: DealTerms) {
    const ccy = terms.guarantee.currency;
    const check = (m: Money, label: string) => {
      if (m.currency !== ccy) {
        throw new DomainError("CURRENCY_MISMATCH", `${label} 币种必须与保底币种 ${ccy} 一致`);
      }
      if (!Number.isInteger(m.amount) || m.amount < 0) {
        throw new DomainError("INVALID_AMOUNT", `${label} 金额必须是非负整数`);
      }
    };
    check(terms.guarantee, "保底");
    if (terms.contingentCap) check(terms.contingentCap, "分成封顶");
    for (const m of terms.milestones) {
      check(m.amount, `里程碑 ${m.code}`);
      if (Number.isNaN(Date.parse(m.dueDate))) {
        throw new DomainError("INVALID_DATE", `里程碑 ${m.code} 日期非法`);
      }
    }
    const codes = new Set(terms.milestones.map((m) => m.code));
    if (codes.size !== terms.milestones.length) {
      throw new DomainError("DUPLICATE_MILESTONE", "里程碑编码不能重复");
    }
    for (const t of terms.royaltyTiers) {
      if (!Number.isInteger(t.threshold) || t.threshold < 0) {
        throw new DomainError("INVALID_TIER", "分成门槛必须是非负整数（合同币种 minor unit）");
      }
      if (t.rate < 0 || t.rate > 1) {
        throw new DomainError("INVALID_TIER", "分成比例必须在 0~1 之间");
      }
    }
  }
}
