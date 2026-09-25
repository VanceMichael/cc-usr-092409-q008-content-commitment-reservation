import { createHash, randomUUID } from "node:crypto";
import type { DomainEvent, EventData, TaskPayloadMap, WaiverUse } from "../domain/events.js";
import { FX_SCALE, parseDecimal } from "../domain/money.js";
import { shiftPeriod } from "../domain/period.js";
import { assertForecastCovers, buildForecast, computeStressRange } from "../domain/stress.js";
import type {
  ContractSnapshot,
  ForecastPeriod,
  ForecastRecord,
  GapProposal,
  GapReason,
  NegotiationTerms,
  OccupancyState,
  PoolDimensions,
  ProposalStatus,
  StressRange,
  WaiverRecord,
} from "../domain/types.js";
import { EventStore } from "../store/event-store.js";
import { TaskScheduler } from "../store/task-scheduler.js";

const ZERO = 0n;

export interface PoolInput extends PoolDimensions {
  totalMinor: bigint;
}

export interface FxVersionInput {
  version: string;
  /**
   * 十进制汇率，口径为“每 1 单位外币兑换多少基准币种”，如 base=CNY 时 {"USD":"7.14"}。
   * 基准币种无需提供（按 1）。
   */
  rates: Record<string, string>;
  base?: string;
}

export interface SubmitInput {
  idempotencyKey: string;
  projectId: string;
  pool: PoolDimensions;
  terms: NegotiationTerms;
  forecastId: string;
  forecastVersion?: number;
  submittedBy: string;
  ttlMs?: number;
  /** 显式指定用于抵减缺口的池级豁免。 */
  waiverIds?: string[];
}

export interface SubmitResult {
  proposalId: string;
  occupancyId: string;
  version: number;
  reused: boolean;
  range: StressRange;
  shortfallMinor: bigint;
  flags: string[];
  waiverUses: WaiverUse[];
}

interface PoolState {
  key: string;
  dims: PoolDimensions;
  versions: { version: number; totalMinor: bigint; at: number }[];
}

interface IdemRecord {
  occupancyId: string;
  fingerprints: Map<string, number>; // 请求指纹 -> 版本
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export class BudgetExhaustedError extends Error {
  constructor(
    readonly poolKey: string,
    readonly availableMinor: bigint,
    readonly requestedMinor: bigint,
    readonly shortfallMinor: bigint,
  ) {
    super(
      `预算池 ${poolKey} 余额不足：可用 ${availableMinor}，申请 ${requestedMinor}，缺口 ${shortfallMinor}`,
    );
    this.name = "BudgetExhaustedError";
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 20);
}

function stableStringify(value: unknown): string {
  if (typeof value === "bigint") return `b:${value.toString()}`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

type Band = "downside" | "base" | "upside";

export class ProcurementService {
  private pools = new Map<string, PoolState>();
  private poolsByDims = new Map<string, string>();
  private forecasts = new Map<string, Map<number, ForecastRecord>>();
  private fx = new Map<string, Record<string, bigint>>();
  private activeFx: string | null = null;
  private occupancies = new Map<string, OccupancyState>();
  private proposals = new Map<
    string,
    {
      proposalId: string;
      projectId: string;
      status: ProposalStatus;
      occupancyId: string;
      version: number;
      submittedBy: string;
    }
  >();
  private occupancyVersions = new Map<string, OccupancyState[]>();
  private idemIndex = new Map<string, IdemRecord>();
  private waivers = new Map<string, WaiverRecord>();
  private gaps: GapProposal[] = [];
  private gapDedup = new Set<string>();
  private snapshots = new Map<string, ContractSnapshot>();
  private readonly scheduler: TaskScheduler;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: EventStore,
    private readonly clock: () => number = Date.now,
    automaticTasks = true,
  ) {
    // 先重放建立状态，再挂实时监听；命令路径的事件由监听者统一投影。
    store.replay((event) => this.apply(event));
    store.onEvent((event) => this.apply(event));
    this.scheduler = new TaskScheduler(
      store,
      clock,
      (type, payload) =>
        this.exclusive(() =>
          this.handleTask(type, payload as TaskPayloadMap["EXPIRE" | "REASSESS"]),
        ),
      automaticTasks,
    );
  }

  start(): void {
    this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
  }

  /** 测试辅助：立即执行所有已到期的后台任务（handler 自身已走互斥链）。 */
  runDueTasks(): Promise<void> {
    return this.scheduler.runDue(this.clock());
  }

  // ---------- 互斥：所有命令与后台任务串行化，并发争用只可能一个成功 ----------

  private exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ---------- 基础数据：预算池 / 预测 / 汇率 / 豁免 ----------

  createPool(input: PoolInput): Promise<{ poolKey: string; version: number }> {
    return this.exclusive(() => {
      const dims: PoolDimensions = {
        currency: input.currency,
        region: input.region,
        contentType: input.contentType,
        period: input.period,
      };
      if (this.poolsByDims.has(stableStringify(dims))) throw new Error("预算池维度已存在");
      if (input.totalMinor < ZERO) throw new Error("预算池总额不能为负");
      const poolKey = `pool_${fingerprint(stableStringify(dims))}`;
      this.store.append("PoolCreated", {
        poolKey,
        dims,
        totalMinor: input.totalMinor,
        poolVersion: 1,
      });
      return { poolKey, version: 1 };
    });
  }

  /** 预算池版本化：新版本立即生效，历史版本随事件保留。 */
  publishPoolVersion(poolKey: string, totalMinor: bigint): Promise<number> {
    return this.exclusive(() => {
      const pool = this.requirePool(poolKey);
      if (totalMinor < ZERO) throw new Error("预算池总额不能为负");
      const version = pool.versions.length + 1;
      this.store.append("PoolVersioned", { poolKey, poolVersion: version, totalMinor });
      return version;
    });
  }

  publishForecast(input: {
    forecastId: string;
    currency: string;
    assumptions: Record<string, number>;
    periods: ForecastPeriod[];
    supersedesVersion?: number | null;
  }): Promise<{ version: number }> {
    return this.exclusive(() => {
      const existing = this.forecasts.get(input.forecastId);
      const version = existing ? existing.size + 1 : 1;
      const supersedes = input.supersedesVersion ?? (version > 1 ? version - 1 : null);
      if (supersedes !== null) {
        const prior = existing?.get(supersedes);
        if (!prior) throw new Error(`被替代的预测版本 ${supersedes} 不存在`);
        if (fingerprint(prior.assumptions) === buildForecast({
          forecastId: input.forecastId,
          version,
          supersedesVersion: supersedes,
          currency: input.currency,
          assumptions: input.assumptions,
          periods: input.periods,
          publishedAt: 0,
        }).assumptionHash) {
          throw new Error("新预测关键假设与被替代版本完全相同，不应发布为替代版本");
        }
      }
      const forecast = buildForecast({
        forecastId: input.forecastId,
        version,
        supersedesVersion: supersedes,
        currency: input.currency,
        assumptions: input.assumptions,
        periods: input.periods,
        publishedAt: this.clock(),
      });
      this.store.append("ForecastPublished", { forecast });
      // 重评只针对尚未签约的占用；已签合同走缺口提案。任务持久化，重启续跑。
      this.scheduler.enqueue(
        "REASSESS",
        {
          taskId: `reassess-forecast-${input.forecastId}-v${version}`,
          kind: "FORECAST",
          forecastId: input.forecastId,
          oldVersion: supersedes ?? 0,
          newVersion: version,
        },
        this.clock(),
      );
      return { version };
    });
  }

  defineFxVersion(input: FxVersionInput): Promise<void> {
    return this.exclusive(() => {
      if (this.fx.has(input.version)) throw new Error(`汇率版本 ${input.version} 已存在`);
      const base = input.base ?? "CNY";
      const rates: Record<string, bigint> = { [base]: FX_SCALE };
      for (const [ccy, decimal] of Object.entries(input.rates)) {
        const parsed = parseDecimal(decimal, FX_SCALE);
        if (parsed <= ZERO) throw new Error(`汇率必须为正: ${ccy}`);
        rates[ccy] = parsed;
      }
      // 新汇率表必须覆盖当前所有在用币种，否则后台重评会因缺汇率无法完成
      for (const ccy of this.currenciesInUse()) {
        if (rates[ccy] === undefined) throw new Error(`汇率版本 ${input.version} 缺少在用币种 ${ccy}`);
      }
      this.store.append("FxVersionDefined", { version: input.version, rates });
    });
  }

  private currenciesInUse(): Set<string> {
    const ccy = new Set<string>();
    for (const occ of this.occupancies.values()) {
      if (occ.status === "RELEASED") continue;
      ccy.add(occ.terms.currency);
      const f = this.forecasts.get(occ.forecastRef.forecastId)?.get(occ.forecastRef.version);
      if (f) ccy.add(f.currency);
    }
    if (this.activeFx) for (const c of Object.keys(this.fx.get(this.activeFx)!)) ccy.add(c);
    return ccy;
  }

  activateFx(version: string): Promise<void> {
    return this.exclusive(() => {
      if (!this.fx.has(version)) throw new Error(`汇率版本 ${version} 未定义`);
      if (this.activeFx === version) return;
      this.store.append("FxActivated", { version });
      this.scheduler.enqueue(
        "REASSESS",
        { taskId: `reassess-fx-${version}`, kind: "FX", fxVersion: version },
        this.clock(),
      );
    });
  }

  grantWaiver(input: {
    grantedBy: string;
    reason: string;
    amountMinor?: bigint;
    poolKey?: string;
    occupancyId?: string;
    gapId?: string;
  }): Promise<{ waiverId: string }> {
    return this.exclusive(() => {
      if (input.poolKey && !this.pools.has(input.poolKey)) throw new Error("豁免引用的预算池不存在");
      if (input.occupancyId && !this.occupancies.has(input.occupancyId)) {
        throw new Error("豁免引用的占用不存在");
      }
      const waiverId = `wv_${randomUUID().slice(0, 12)}`;
      const waiver: WaiverRecord = {
        waiverId,
        grantedBy: input.grantedBy,
        reason: input.reason,
        amountMinor: input.amountMinor ?? null,
        poolKey: input.poolKey ?? null,
        occupancyId: input.occupancyId ?? null,
        gapId: input.gapId ?? null,
        grantedAt: this.clock(),
      };
      this.store.append("WaiverGranted", { waiver });
      return { waiverId };
    });
  }

  // ---------- 申请 / 审批 / 签署 ----------

  submitProposal(input: SubmitInput): Promise<SubmitResult> {
    return this.exclusive(() => this.doSubmit(input));
  }

  private doSubmit(input: SubmitInput): SubmitResult {
    const pool = this.lookupPool(input.pool);
    const forecast = this.resolveForecast(input.forecastId, input.forecastVersion);
    const fxVersion = this.requireActiveFx();
    const rates = this.fx.get(fxVersion)!;
    assertForecastCovers(forecast, input.terms, pool.dims.period);
    if (!rates[input.terms.currency]) throw new Error(`汇率表缺少币种 ${input.terms.currency}`);
    if (!rates[forecast.currency]) throw new Error(`汇率表缺少预测币种 ${forecast.currency}`);

    const range = computeStressRange({
      terms: input.terms,
      forecast,
      rates,
      fxVersion,
      poolCurrency: pool.dims.currency,
      poolPeriod: pool.dims.period,
    });

    const requestFingerprint = this.requestFingerprint(
      input.projectId,
      pool.dims,
      input.terms,
      forecast.forecastId,
      forecast.version,
    );

    // 幂等：相同申请重试沿用原占用；金额或条款变化形成新版本
    const idem = this.idemIndex.get(input.idempotencyKey);
    if (idem) {
      const historicalVersion = idem.fingerprints.get(requestFingerprint);
      if (historicalVersion !== undefined) {
        const hit = (this.occupancyVersions.get(idem.occupancyId) ?? []).find(
          (o) => o.version === historicalVersion,
        )!;
        const proposal = this.proposals.get(hit.proposalId)!;
        // 只有命中的版本当前仍生效（未签且 HELD）才算重试；被替代/取消/到期/签署的版本不复活
        if (hit.status === "HELD" && (proposal.status === "SUBMITTED" || proposal.status === "APPROVED")) {
          return {
            proposalId: hit.proposalId,
            occupancyId: hit.occupancyId,
            version: hit.version,
            reused: true,
            range: hit.range,
            shortfallMinor: hit.shortfallMinor,
            flags: [...hit.flags],
            waiverUses: [],
          };
        }
        throw new Error("该申请键对应的方案已终结，请使用新的申请键重新提交");
      }
      const current = this.occupancies.get(idem.occupancyId)!;
      const proposal = this.proposals.get(current.proposalId)!;
      if (current.status !== "HELD" || (proposal.status !== "SUBMITTED" && proposal.status !== "APPROVED")) {
        throw new Error("该申请键对应的方案已终结，请使用新的申请键重新提交");
      }
      return this.submitVersion(input, pool, forecast, fxVersion, range, requestFingerprint, current, idem);
    }

    const proposalId = `pp_${randomUUID().slice(0, 12)}`;
    const occupancyId = `oc_${randomUUID().slice(0, 12)}`;
    const createdAt = this.clock();
    const expiresAt = createdAt + (input.ttlMs ?? DEFAULT_TTL_MS);
    const admission = this.admit(pool.key, range, null, input.waiverIds ?? []);

    this.store.append("ProposalSubmitted", {
      proposalId,
      version: 1,
      occupancyId,
      idempotencyKey: input.idempotencyKey,
      projectId: input.projectId,
      poolKey: pool.key,
      dims: pool.dims,
      poolVersionAtSubmit: pool.versions.length,
      terms: input.terms,
      forecastRef: {
        forecastId: forecast.forecastId,
        version: forecast.version,
        assumptionHash: forecast.assumptionHash,
      },
      fxVersion,
      range,
      submittedBy: input.submittedBy,
      createdAt,
      expiresAt,
      replacesOccupancyId: null,
      shortfallMinor: ZERO,
      flags: admission.flags,
      waiverUses: admission.waiverUses,
    });
    this.enqueueExpiry(occupancyId, 1, expiresAt);
    const occ = this.occupancies.get(occupancyId)!;
    return this.toSubmitResult(occ, false, []);
  }

  private submitVersion(
    input: SubmitInput,
    pool: PoolState,
    forecast: ForecastRecord,
    fxVersion: string,
    range: StressRange,
    requestFingerprint: string,
    previous: OccupancyState,
    idem: IdemRecord,
  ): SubmitResult {
    // 先做余额校验（可能抛 BudgetExhaustedError），通过后才以补偿事件释放旧版本
    const admission = this.admit(pool.key, range, previous.occupancyId, input.waiverIds ?? []);
    const version = previous.version + 1;
    this.cancelTask(`expire:${previous.occupancyId}:v${previous.version}`);
    this.store.append("OccupancyReleased", {
      occupancyId: previous.occupancyId,
      reason: "SUPERSEDED_BY_VERSION",
      detail: `条款变化，升级为 v${version}`,
    });
    const createdAt = this.clock();
    const expiresAt = createdAt + (input.ttlMs ?? DEFAULT_TTL_MS);
    this.store.append("ProposalSubmitted", {
      proposalId: previous.proposalId,
      version,
      occupancyId: previous.occupancyId,
      idempotencyKey: input.idempotencyKey,
      projectId: input.projectId,
      poolKey: pool.key,
      dims: pool.dims,
      poolVersionAtSubmit: pool.versions.length,
      terms: input.terms,
      forecastRef: {
        forecastId: forecast.forecastId,
        version: forecast.version,
        assumptionHash: forecast.assumptionHash,
      },
      fxVersion,
      range,
      submittedBy: input.submittedBy,
      createdAt,
      expiresAt,
      replacesOccupancyId: previous.occupancyId,
      shortfallMinor: ZERO,
      flags: admission.flags,
      waiverUses: admission.waiverUses,
    });
    idem.fingerprints.set(requestFingerprint, version);
    this.enqueueExpiry(previous.occupancyId, version, expiresAt);
    const occ = this.occupancies.get(previous.occupancyId)!;
    return this.toSubmitResult(occ, false, admission.waiverUses);
  }

  private toSubmitResult(occ: OccupancyState, reused: boolean, waiverUses: WaiverUse[]): SubmitResult {
    return {
      proposalId: occ.proposalId,
      occupancyId: occ.occupancyId,
      version: occ.version,
      reused,
      range: occ.range,
      shortfallMinor: occ.shortfallMinor,
      flags: [...occ.flags],
      waiverUses,
    };
  }

  approve(proposalId: string, approverId: string, waiverId?: string): Promise<void> {
    return this.exclusive(() => {
      const proposal = this.requireProposal(proposalId);
      if (proposal.status !== "SUBMITTED") throw new Error(`方案状态 ${proposal.status} 不可审批`);
      const occ = this.occupancies.get(proposal.occupancyId)!;
      if (occ.version !== proposal.version) throw new Error("占用与方案版本不一致");
      // 审批人不能批准自己提交的方案
      if (occ.submittedBy === approverId) {
        throw new Error("职责分离：审批人不能批准自己提交的方案");
      }
      let waiver: WaiverRecord | null = null;
      if (waiverId) {
        waiver = this.waivers.get(waiverId) ?? null;
        if (!waiver) throw new Error("豁免不存在");
        if (waiver.occupancyId && waiver.occupancyId !== occ.occupancyId) {
          throw new Error("豁免与该占用不匹配");
        }
        if (!waiver.occupancyId && waiver.poolKey && waiver.poolKey !== occ.poolKey) {
          throw new Error("豁免与该预算池不匹配");
        }
      }
      // 重评后出现风险缺口的占用：批准必须以池级额度豁免覆盖缺口
      let waiverUse: WaiverUse | null = null;
      if (occ.shortfallMinor > ZERO) {
        if (!waiver || waiver.occupancyId || waiver.poolKey !== occ.poolKey || waiver.amountMinor === null) {
          throw new Error(
            `该占用存在 ${occ.shortfallMinor} 风险缺口，批准时必须提供足额的池级豁免`,
          );
        }
        if (this.waiverRemaining(waiver.waiverId) < occ.shortfallMinor) {
          throw new Error("豁免剩余额度不足以覆盖风险缺口");
        }
        waiverUse = { waiverId: waiver.waiverId, amountMinor: occ.shortfallMinor };
      }
      this.store.append("ProposalApproved", {
        proposalId,
        version: proposal.version,
        approverId,
        waiverId: waiverId ?? null,
        waiverUse,
      });
    });
  }

  sign(proposalId: string): Promise<{ signedAt: number }> {
    return this.exclusive(() => {
      const proposal = this.requireProposal(proposalId);
      if (proposal.status !== "APPROVED") throw new Error("只有已批准方案可签署");
      const occ = this.occupancies.get(proposal.occupancyId)!;
      if (occ.version !== proposal.version) throw new Error("占用与方案版本不一致");
      const pool = this.requirePool(occ.poolKey);
      const poolVersion = pool.versions[pool.versions.length - 1];
      const forecast = this.forecasts.get(occ.forecastRef.forecastId)?.get(occ.forecastRef.version);
      if (!forecast) throw new Error("签署时引用预测缺失");
      const fxRates = this.fx.get(occ.fxVersion);
      if (!fxRates) throw new Error("签署时引用汇率版本缺失");
      // 已签合同保留签署时的预算与预测快照，后续变化不能倒改历史
      const snapshot: ContractSnapshot = {
        proposalId,
        version: occ.version,
        occupancyId: occ.occupancyId,
        signedAt: this.clock(),
        submittedBy: occ.submittedBy,
        approverId: occ.approverId!,
        pool: {
          key: pool.key,
          dims: pool.dims,
          poolVersion: poolVersion.version,
          totalMinor: poolVersion.totalMinor,
        },
        forecast,
        fx: { version: occ.fxVersion, rates: { ...fxRates } },
        terms: occ.terms,
        range: occ.range,
      };
      this.cancelTask(`expire:${occ.occupancyId}:v${occ.version}`);
      this.store.append("ProposalSigned", { proposalId, version: occ.version, snapshot });
      return { signedAt: snapshot.signedAt };
    });
  }

  reject(proposalId: string, note?: string): Promise<void> {
    return this.exclusive(() => this.releaseOpenProposal(proposalId, "REJECTED", note));
  }

  cancel(proposalId: string, note?: string): Promise<void> {
    return this.exclusive(() => this.releaseOpenProposal(proposalId, "CANCELLED", note));
  }

  /** 合同终止：通过补偿事件释放已签容量；签署快照保留。 */
  terminateContract(proposalId: string, note?: string): Promise<void> {
    return this.exclusive(() => {
      const proposal = this.requireProposal(proposalId);
      if (proposal.status !== "SIGNED") throw new Error("只有已签合同可终止");
      this.store.append("OccupancyReleased", {
        occupancyId: proposal.occupancyId,
        reason: "TERMINATED",
        detail: note,
      });
      this.store.append("ProposalTerminated", { proposalId });
    });
  }

  private releaseOpenProposal(
    proposalId: string,
    reason: "CANCELLED" | "REJECTED",
    note?: string,
  ): void {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status !== "SUBMITTED" && proposal.status !== "APPROVED") {
      throw new Error(`方案状态 ${proposal.status} 不可取消/驳回`);
    }
    const occ = this.occupancies.get(proposal.occupancyId)!;
    this.cancelTask(`expire:${occ.occupancyId}:v${occ.version}`);
    this.store.append("OccupancyReleased", {
      occupancyId: occ.occupancyId,
      reason,
      detail: note,
      proposalStatus: reason === "REJECTED" ? "REJECTED" : "CANCELLED",
    });
  }

  /** 项目延期 n 个期间（季度/月按池期间族），仅重评未签占用；已签合同走缺口提案。 */
  delayProject(projectId: string, periods: number): Promise<void> {
    return this.exclusive(() => {
      if (periods <= 0) throw new Error("延期期间数必须为正");
      this.scheduler.enqueue(
        "REASSESS",
        {
          taskId: `reassess-delay-${projectId}-${periods}-${this.clock()}`,
          kind: "DELAY",
          projectId,
          periods,
        },
        this.clock(),
      );
    });
  }

  resolveGap(gapId: string, status: GapProposal["status"], note: string, waiverId?: string): Promise<void> {
    return this.exclusive(() => {
      const gap = this.gaps.find((g) => g.gapId === gapId);
      if (!gap) throw new Error("缺口提案不存在");
      if (gap.status !== "OPEN") throw new Error("缺口提案已处置");
      if (status === "WAIVED" && !waiverId) throw new Error("豁免处置必须提供豁免编号");
      if (waiverId) {
        const wv = this.waivers.get(waiverId);
        if (!wv) throw new Error("豁免不存在");
        if (wv.gapId && wv.gapId !== gapId) throw new Error("豁免与缺口提案不匹配");
      }
      this.store.append("GapResolved", { gapId, status, note, waiverId: waiverId ?? null });
    });
  }

  // ---------- 后台任务：到期释放与重评（重启后继续） ----------

  private handleTask(type: string, payload: TaskPayloadMap["EXPIRE" | "REASSESS"]): void {
    if (type === "EXPIRE") {
      const p = payload as TaskPayloadMap["EXPIRE"];
      this.expireOccupancy(p.occupancyId, p.version);
    } else {
      const p = payload as TaskPayloadMap["REASSESS"];
      if (p.kind === "FORECAST") this.reassessForecast(p.forecastId, p.oldVersion, p.newVersion);
      else if (p.kind === "FX") this.reassessFx(p.fxVersion);
      else this.reassessDelay(p.projectId, p.periods);
    }
  }

  private expireOccupancy(occupancyId: string, version: number): void {
    const occ = this.occupancies.get(occupancyId);
    if (!occ || occ.status !== "HELD" || occ.version !== version) return;
    const proposal = this.proposals.get(occ.proposalId);
    if (!proposal || (proposal.status !== "SUBMITTED" && proposal.status !== "APPROVED")) return;
    this.store.append("OccupancyReleased", {
      occupancyId,
      reason: "EXPIRED",
      proposalStatus: "EXPIRED",
    });
  }

  private reassessForecast(forecastId: string, oldVersion: number, newVersion: number): void {
    const next = this.forecasts.get(forecastId)?.get(newVersion);
    if (!next) return;
    // 链式替代：引用任何更旧版本（含任务积压时跨过的版本）的占用都直接向新版本重评
    for (const occ of [...this.occupancies.values()]) {
      if (occ.status !== "HELD") continue;
      if (occ.forecastRef.forecastId !== forecastId) continue;
      if (occ.forecastRef.version >= newVersion) continue;
      if (!this.forecastCoversTerms(next, occ.terms)) {
        // 新预测不覆盖分成期间（常见于先延期后换预测）：保留原区间并挂旗，不静默清零
        this.emitReevaluation(
          occ,
          "FORECAST_REPLACED",
          occ.range,
          this.forecasts.get(forecastId)!.get(oldVersion)!,
          occ.fxVersion,
          occ.poolKey,
          occ.dims,
          occ.terms,
          ["RECOMPUTE_SKIPPED_FORECAST_COVERAGE"],
        );
        continue;
      }
      const range = computeStressRange({
        terms: occ.terms,
        forecast: next,
        rates: this.fx.get(occ.fxVersion)!,
        fxVersion: occ.fxVersion,
        poolCurrency: occ.dims.currency,
        poolPeriod: occ.dims.period,
      });
      this.emitReevaluation(occ, "FORECAST_REPLACED", range, next, occ.fxVersion, occ.poolKey, occ.dims);
    }
    for (const snapshot of [...this.snapshots.values()]) {
      if (snapshot.forecast.forecastId !== forecastId) continue;
      if (snapshot.forecast.version >= newVersion) continue;
      if (this.occupancies.get(snapshot.occupancyId)?.status !== "SIGNED") continue;
      if (!this.forecastCoversTerms(next, snapshot.terms)) {
        // 无法按新预测重算分成：把签署时的或有口径整体挂为风险缺口
        this.openSignedGap({
          reason: "FORECAST_REPLACED",
          snapshot,
          projected: snapshot.range,
          targetPoolKey: null,
          detail: `预测 ${forecastId} v${newVersion} 不覆盖分成期间，或有口径无法重算（forecast=${next.assumptionHash}）`,
          dedupContext: `${forecastId}:v${newVersion}:coverage-gap`,
          forcedGap: {
            downsideMinor: snapshot.range.contingentDownsideMinor,
            baseMinor: snapshot.range.contingentBaseMinor,
            upsideMinor: snapshot.range.contingentUpsideMinor,
          },
        });
        continue;
      }
      const projected = computeStressRange({
        terms: snapshot.terms,
        forecast: next,
        rates: snapshot.fx.rates,
        fxVersion: snapshot.fx.version,
        poolCurrency: snapshot.pool.dims.currency,
        poolPeriod: snapshot.pool.dims.period,
      });
      this.openSignedGap({
        reason: "FORECAST_REPLACED",
        snapshot,
        projected,
        targetPoolKey: null,
        detail: `预测 ${forecastId} v${oldVersion} 被 v${newVersion} 替代（假设 ${next.assumptionHash}）`,
        dedupContext: `${forecastId}:v${newVersion}`,
      });
    }
  }

  private forecastCoversTerms(forecast: ForecastRecord, terms: NegotiationTerms): boolean {
    return terms.contingent.periods.every((p) =>
      forecast.periods.some((fp) => fp.period === p),
    );
  }

  private reassessFx(newFxVersion: string): void {
    const rates = this.fx.get(newFxVersion);
    if (!rates) return;
    for (const occ of [...this.occupancies.values()]) {
      if (occ.status !== "HELD" || occ.fxVersion === newFxVersion) continue;
      const forecast = this.forecasts.get(occ.forecastRef.forecastId)!.get(occ.forecastRef.version)!;
      if (!this.forecastCoversTerms(forecast, occ.terms)) {
        this.emitReevaluation(
          occ,
          "FX_CHANGED",
          occ.range,
          forecast,
          occ.fxVersion,
          occ.poolKey,
          occ.dims,
          occ.terms,
          ["RECOMPUTE_SKIPPED_FORECAST_COVERAGE"],
        );
        continue;
      }
      const range = computeStressRange({
        terms: occ.terms,
        forecast,
        rates,
        fxVersion: newFxVersion,
        poolCurrency: occ.dims.currency,
        poolPeriod: occ.dims.period,
      });
      this.emitReevaluation(occ, "FX_CHANGED", range, forecast, newFxVersion, occ.poolKey, occ.dims);
    }
    for (const snapshot of [...this.snapshots.values()]) {
      if (snapshot.fx.version === newFxVersion) continue;
      if (this.occupancies.get(snapshot.occupancyId)?.status !== "SIGNED") continue;
      const projected = computeStressRange({
        terms: snapshot.terms,
        forecast: snapshot.forecast,
        rates,
        fxVersion: newFxVersion,
        poolCurrency: snapshot.pool.dims.currency,
        poolPeriod: snapshot.pool.dims.period,
      });
      this.openSignedGap({
        reason: "FX_CHANGED",
        snapshot,
        projected,
        targetPoolKey: null,
        detail: `汇率版本 ${snapshot.fx.version} -> ${newFxVersion}`,
        dedupContext: `fx:${newFxVersion}`,
      });
    }
  }

  private reassessDelay(projectId: string, periods: number): void {
    // 未签占用：平移期间，跨池时以补偿事件把容量挪到目标池；无法重算则保留并打标
    for (const occ of [...this.occupancies.values()]) {
      if (occ.status !== "HELD" || occ.projectId !== projectId) continue;
      const shiftedTerms: NegotiationTerms = {
        ...occ.terms,
        contingent: {
          ...occ.terms.contingent,
          periods: occ.terms.contingent.periods.map((p) => shiftPeriod(p, periods)),
        },
        milestones: occ.terms.milestones.map((m) => ({
          ...m,
          duePeriod: shiftPeriod(m.duePeriod, periods),
        })),
      };
      const newPeriod = shiftPeriod(occ.dims.period, periods);
      const targetDims: PoolDimensions = { ...occ.dims, period: newPeriod };
      const targetPoolKey = this.poolsByDims.get(stableStringify(targetDims)) ?? null;
      const forecast = this.forecasts.get(occ.forecastRef.forecastId)?.get(occ.forecastRef.version);
      const forecastCovers =
        forecast &&
        shiftedTerms.contingent.periods.every((p) => forecast.periods.some((fp) => fp.period === p));

      if (forecastCovers && targetPoolKey) {
        const range = computeStressRange({
          terms: shiftedTerms,
          forecast,
          rates: this.fx.get(occ.fxVersion)!,
          fxVersion: occ.fxVersion,
          poolCurrency: targetDims.currency,
          poolPeriod: targetDims.period,
        });
        this.emitReevaluation(
          occ,
          "PROJECT_DELAY",
          range,
          forecast,
          occ.fxVersion,
          targetPoolKey,
          targetDims,
          shiftedTerms,
        );
      } else {
        const flags = [
          "PROJECT_DELAY",
          ...(targetPoolKey ? [] : ["TARGET_POOL_MISSING"]),
          ...(forecastCovers ? [] : ["FORECAST_NOT_COVERED_AFTER_DELAY"]),
        ];
        this.store.append("OccupancyReevaluated", {
          occupancyId: occ.occupancyId,
          reason: "PROJECT_DELAY",
          range: occ.range, // 无法重算，保留原压力区间并以标记明示
          terms: shiftedTerms,
          forecastRef: occ.forecastRef,
          fxVersion: occ.fxVersion,
          poolKey: occ.poolKey,
          dims: targetDims,
          addedFlags: flags,
          targetPoolKey: null,
          shortfallMinor: occ.shortfallMinor,
        });
      }
    }
    // 已签合同：不搬迁、不倒改，按目标池可用性生成缺口处置提案
    for (const snapshot of [...this.snapshots.values()]) {
      if (this.occupancies.get(snapshot.occupancyId)?.status !== "SIGNED") continue;
      if (this.proposals.get(snapshot.proposalId)!.projectId !== projectId) continue;
      const newPeriod = shiftPeriod(snapshot.pool.dims.period, periods);
      const targetDims: PoolDimensions = { ...snapshot.pool.dims, period: newPeriod };
      const targetPoolKey = this.poolsByDims.get(stableStringify(targetDims)) ?? null;
      if (!targetPoolKey) {
        this.openSignedGap({
          reason: "PROJECT_DELAY",
          snapshot,
          projected: snapshot.range,
          targetPoolKey: null,
          detail: `项目延期 ${periods} 个期间至 ${newPeriod}，目标预算池不存在`,
          dedupContext: `delay:${projectId}:${periods}:nopool`,
          forcedGap: {
            downsideMinor: snapshot.range.downsideMinor,
            baseMinor: snapshot.range.baseMinor,
            upsideMinor: snapshot.range.upsideMinor,
          },
        });
        continue;
      }
      const view = this.poolView(targetPoolKey, "base");
      const overflow =
        snapshot.range.baseMinor > view.availableMinor
          ? snapshot.range.baseMinor - view.availableMinor
          : ZERO;
      this.openSignedGap({
        reason: "PROJECT_DELAY",
        snapshot,
        projected: snapshot.range,
        targetPoolKey,
        detail: `项目延期 ${periods} 个期间至 ${newPeriod}，目标池可用 ${view.availableMinor}，需占用 ${snapshot.range.baseMinor}`,
        dedupContext: `delay:${projectId}:${periods}:${targetPoolKey}`,
        forcedGap: { downsideMinor: overflow, baseMinor: overflow, upsideMinor: overflow },
      });
    }
  }

  private emitReevaluation(
    occ: OccupancyState,
    reason: GapReason,
    range: StressRange,
    forecast: ForecastRecord,
    fxVersion: string,
    targetPoolKey: string,
    targetDims: PoolDimensions,
    terms?: NegotiationTerms,
    extraFlags: string[] = [],
  ): void {
    const moved = targetPoolKey !== occ.poolKey;
    const checkPool = moved ? targetPoolKey : occ.poolKey;
    // 重评是后台动作，不因余额不足回滚：以 shortfall+flags 暴露风险缺口
    const { shortfall, flags } = this.measureHeadroom(checkPool, range, occ.occupancyId, [
      reason,
      ...extraFlags,
    ]);
    this.store.append("OccupancyReevaluated", {
      occupancyId: occ.occupancyId,
      reason,
      range,
      terms: terms ?? occ.terms,
      forecastRef: {
        forecastId: forecast.forecastId,
        version: forecast.version,
        assumptionHash: forecast.assumptionHash,
      },
      fxVersion,
      poolKey: targetPoolKey,
      dims: targetDims,
      addedFlags: flags,
      targetPoolKey: moved ? targetPoolKey : null,
      shortfallMinor: shortfall,
    });
  }

  private openSignedGap(input: {
    reason: GapReason;
    snapshot: ContractSnapshot;
    projected: StressRange;
    targetPoolKey: string | null;
    detail: string;
    dedupContext: string;
    forcedGap?: { downsideMinor: bigint; baseMinor: bigint; upsideMinor: bigint };
  }): void {
    const { snapshot, projected } = input;
    const dedupKey = `${snapshot.proposalId}:${input.reason}:${input.dedupContext}`;
    if (this.gapDedup.has(dedupKey)) return;
    const gap = input.forcedGap ?? {
      downsideMinor: projected.downsideMinor - snapshot.range.downsideMinor,
      baseMinor: projected.baseMinor - snapshot.range.baseMinor,
      upsideMinor: projected.upsideMinor - snapshot.range.upsideMinor,
    };
    const positive = (v: bigint) => (v > ZERO ? v : ZERO);
    if (positive(gap.downsideMinor) + positive(gap.baseMinor) + positive(gap.upsideMinor) === ZERO) {
      return;
    }
    const record: GapProposal = {
      gapId: `gap_${randomUUID().slice(0, 12)}`,
      reason: input.reason,
      proposalId: snapshot.proposalId,
      occupancyId: snapshot.occupancyId,
      projectId: this.proposals.get(snapshot.proposalId)!.projectId,
      poolKey: snapshot.pool.key,
      createdAt: this.clock(),
      status: "OPEN",
      targetPoolKey: input.targetPoolKey,
      snapshot: {
        downsideMinor: snapshot.range.downsideMinor,
        baseMinor: snapshot.range.baseMinor,
        upsideMinor: snapshot.range.upsideMinor,
      },
      projected: {
        downsideMinor: projected.downsideMinor,
        baseMinor: projected.baseMinor,
        upsideMinor: projected.upsideMinor,
      },
      gap: {
        downsideMinor: positive(gap.downsideMinor),
        baseMinor: positive(gap.baseMinor),
        upsideMinor: positive(gap.upsideMinor),
      },
      detail: input.detail,
      resolvedAt: null,
      resolutionNote: null,
      waiverId: null,
    };
    this.store.append("GapOpened", { gap: record, dedupKey });
  }

  // ---------- 容量与余额 ----------

  private activeHolds(poolKey: string): OccupancyState[] {
    return [...this.occupancies.values()].filter((o) => o.poolKey === poolKey && o.status === "HELD");
  }

  private activeSigned(poolKey: string): ContractSnapshot[] {
    return [...this.snapshots.values()].filter((s) => {
      if (s.pool.key !== poolKey) return false;
      return this.occupancies.get(s.occupancyId)?.status === "SIGNED";
    });
  }

  private poolWaivers(poolKey: string): WaiverRecord[] {
    return [...this.waivers.values()].filter(
      (w) => w.poolKey === poolKey && w.occupancyId === null && w.gapId === null,
    );
  }

  /**
   * 豁免已用额度从“当前仍 HELD 的占用版本”派生：
   * 旧版本经补偿事件释放后其豁免自动退回；已签占用视为持续使用。
   */
  private waiverConsumedAmount(waiverId: string): bigint {
    let total = ZERO;
    for (const occ of this.occupancies.values()) {
      if (occ.status === "RELEASED") continue;
      for (const use of occ.waiverUses) {
        if (use.waiverId === waiverId) total += use.amountMinor;
      }
    }
    return total;
  }

  private waiverRemaining(waiverId: string): bigint {
    const wv = this.waivers.get(waiverId);
    if (!wv || wv.amountMinor === null) return ZERO;
    return wv.amountMinor - this.waiverConsumedAmount(waiverId);
  }

  /**
   * 申请准入：按 base 档占用余额。余额不足时，池级豁免可抵减缺口；
   * 豁免仍不足则抛 BudgetExhaustedError——并发争用下后到的申请直接失败。
   */
  private admit(
    poolKey: string,
    range: StressRange,
    ignoreOccupancyId: string | null,
    waiverIds: string[],
  ): { shortfall: bigint; flags: string[]; waiverUses: WaiverUse[] } {
    const { shortfall, flags } = this.measureHeadroom(poolKey, range, ignoreOccupancyId, []);
    if (shortfall === ZERO) return { shortfall, flags, waiverUses: [] };
    const usable: WaiverRecord[] = [];
    for (const id of waiverIds) {
      const wv = this.waivers.get(id);
      if (!wv) throw new Error(`豁免 ${id} 不存在`);
      if (wv.poolKey !== poolKey || wv.occupancyId || wv.gapId) {
        throw new Error(`豁免 ${id} 不可用于该预算池申请`);
      }
      const remaining = this.waiverRemaining(id);
      if (remaining > ZERO) usable.push(wv);
    }
    let covered = ZERO;
    const waiverUses: WaiverUse[] = [];
    for (const wv of usable.sort((a, b) => a.waiverId.localeCompare(b.waiverId))) {
      if (covered >= shortfall) break;
      const take = this.min2(shortfall - covered, this.waiverRemaining(wv.waiverId));
      if (take <= ZERO) continue;
      covered += take;
      waiverUses.push({ waiverId: wv.waiverId, amountMinor: take });
    }
    if (covered < shortfall) {
      const view = this.poolView(poolKey, "base", ignoreOccupancyId);
      throw new BudgetExhaustedError(poolKey, view.availableMinor, range.baseMinor, shortfall - covered);
    }
    for (const use of waiverUses) {
      // 仅记录到待提交事件；消耗额度由当前 HELD 占用派生，旧版本释放即退回。
      void use;
    }
    flags.push("COVERED_BY_POOL_WAIVER");
    return { shortfall: ZERO, flags, waiverUses };
  }

  private min2(a: bigint, b: bigint): bigint {
    return a < b ? a : b;
  }

  /** 测算缺口（后台重评与申请共用），不抛异常、不消耗豁免。 */
  private measureHeadroom(
    poolKey: string,
    range: StressRange,
    ignoreOccupancyId: string | null,
    seedFlags: string[],
  ): { shortfall: bigint; flags: string[] } {
    const view = this.poolView(poolKey, "base", ignoreOccupancyId);
    const flags = [...seedFlags];
    const shortfall =
      range.baseMinor > view.availableMinor ? range.baseMinor - view.availableMinor : ZERO;
    if (shortfall > ZERO) flags.push("INSUFFICIENT_BUDGET");
    if (range.upsideMinor > view.availableMinor) flags.push("UPSIDE_OVER_COMMITTED");
    return { shortfall, flags };
  }

  private enqueueExpiry(occupancyId: string, version: number, runAt: number): void {
    this.scheduler.enqueue(
      "EXPIRE",
      { taskId: `expire:${occupancyId}:v${version}`, occupancyId, version },
      runAt,
    );
  }

  private cancelTask(taskId: string): void {
    this.store.append("TaskFinished", { taskId, result: "superseded" });
  }

  // ---------- 查询 / 管理看板 ----------

  poolView(poolKey: string, band: Band = "base", ignoreOccupancyId: string | null = null) {
    const pool = this.requirePool(poolKey);
    const current = pool.versions[pool.versions.length - 1];
    const bandField = band === "downside" ? "downsideMinor" : band === "upside" ? "upsideMinor" : "baseMinor";
    const signed = this.activeSigned(poolKey);
    const holds = this.activeHolds(poolKey).filter((o) => o.occupancyId !== ignoreOccupancyId);
    const signedTotal = signed.reduce((acc, s) => acc + s.range[bandField], ZERO);
    const heldTotal = holds.reduce((acc, o) => acc + o.range[bandField], ZERO);
    const openGaps = this.gaps.filter(
      (g) => g.status === "OPEN" && (g.poolKey === poolKey || g.targetPoolKey === poolKey),
    );
    const riskFromGaps = openGaps.reduce((acc, g) => acc + g.gap[bandField], ZERO);
    const riskFromHolds = holds.reduce((acc, o) => acc + o.shortfallMinor, ZERO);
    const waiverList = this.poolWaivers(poolKey);
    const waivedHeadroom = waiverList.reduce(
      (acc, w) => acc + (w.amountMinor === null ? ZERO : this.waiverRemaining(w.waiverId)),
      ZERO,
    );
    return {
      poolKey,
      dims: pool.dims,
      poolVersion: current.version,
      band,
      totalMinor: current.totalMinor,
      signedMinor: signedTotal,
      heldMinor: heldTotal,
      availableMinor: current.totalMinor - signedTotal - heldTotal,
      waivedHeadroomMinor: waivedHeadroom,
      availableAfterWaiverMinor: current.totalMinor - signedTotal - heldTotal + waivedHeadroom,
      riskGapMinor: riskFromGaps + riskFromHolds,
      signed: signed.map((s) => ({
        proposalId: s.proposalId,
        version: s.version,
        occupancyId: s.occupancyId,
        signedAt: s.signedAt,
        amountMinor: s.range[bandField],
        forecastId: s.forecast.forecastId,
        forecastVersion: s.forecast.version,
        assumptionHash: s.forecast.assumptionHash,
        fxVersion: s.fx.version,
        approverId: s.approverId,
        submittedBy: s.submittedBy,
      })),
      holds: holds.map((o) => ({
        proposalId: o.proposalId,
        occupancyId: o.occupancyId,
        version: o.version,
        projectId: o.projectId,
        amountMinor: o.range[bandField],
        range: {
          downsideMinor: o.range.downsideMinor,
          baseMinor: o.range.baseMinor,
          upsideMinor: o.range.upsideMinor,
        },
        forecastId: o.forecastRef.forecastId,
        forecastVersion: o.forecastRef.version,
        assumptionHash: o.forecastRef.assumptionHash,
        fxVersion: o.fxVersion,
        approverId: o.approverId,
        shortfallMinor: o.shortfallMinor,
        flags: o.flags,
        waiverIds: o.waiverIds,
        expiresAt: o.expiresAt,
      })),
      waivers: waiverList.map((w) => ({
        waiverId: w.waiverId,
        grantedBy: w.grantedBy,
        reason: w.reason,
        amountMinor: w.amountMinor,
        remainingMinor: this.waiverRemaining(w.waiverId),
      })),
      openGaps: openGaps.map((g) => this.gapView(g)),
    };
  }

  private gapView(g: GapProposal) {
    return {
      gapId: g.gapId,
      reason: g.reason,
      proposalId: g.proposalId,
      occupancyId: g.occupancyId,
      projectId: g.projectId,
      status: g.status,
      targetPoolKey: g.targetPoolKey,
      snapshot: g.snapshot,
      projected: g.projected,
      gap: g.gap,
      detail: g.detail,
      waiverId: g.waiverId,
      resolutionNote: g.resolutionNote,
    };
  }

  /** 场景对比：每个预算池在 downside/base/upside 下的已签、占用、可用、风险缺口。 */
  scenarioComparison() {
    return [...this.pools.keys()].map((poolKey) => ({
      poolKey,
      downside: this.stripDetails(this.poolView(poolKey, "downside")),
      base: this.stripDetails(this.poolView(poolKey, "base")),
      upside: this.stripDetails(this.poolView(poolKey, "upside")),
    }));
  }

  private stripDetails(view: ReturnType<ProcurementService["poolView"]>) {
    return {
      poolKey: view.poolKey,
      dims: view.dims,
      poolVersion: view.poolVersion,
      totalMinor: view.totalMinor,
      signedMinor: view.signedMinor,
      heldMinor: view.heldMinor,
      availableMinor: view.availableMinor,
      waivedHeadroomMinor: view.waivedHeadroomMinor,
      riskGapMinor: view.riskGapMinor,
    };
  }

  /** 从任一数字追到合同版本、预测依据与人工豁免。 */
  proposalHistory(proposalId: string) {
    const proposal = this.requireProposal(proposalId);
    const versions = this.occupancyVersions.get(proposal.occupancyId) ?? [];
    const snapshot = this.snapshots.get(proposalId) ?? null;
    const gaps = this.gaps.filter((g) => g.proposalId === proposalId).map((g) => this.gapView(g));
    const waiverIds = new Set<string>();
    for (const v of versions) for (const id of v.waiverIds) waiverIds.add(id);
    for (const g of gaps) if (g.waiverId) waiverIds.add(g.waiverId);
    return {
      proposal: { ...proposal },
      versions: versions.map((o) => ({
        version: o.version,
        status: o.status,
        submittedBy: o.submittedBy,
        approverId: o.approverId,
        range: {
          downsideMinor: o.range.downsideMinor,
          baseMinor: o.range.baseMinor,
          upsideMinor: o.range.upsideMinor,
        },
        original: o.original,
        forecast: o.forecastRef,
        fxVersion: o.fxVersion,
        poolKey: o.poolKey,
        dims: o.dims,
        flags: o.flags,
        shortfallMinor: o.shortfallMinor,
        waiverIds: o.waiverIds,
        createdAt: o.createdAt,
        expiresAt: o.expiresAt,
        signedAt: o.signedAt,
        releasedAt: o.releasedAt,
      })),
      signedSnapshot: snapshot
        ? {
            version: snapshot.version,
            signedAt: snapshot.signedAt,
            submittedBy: snapshot.submittedBy,
            approverId: snapshot.approverId,
            pool: snapshot.pool,
            forecast: {
              forecastId: snapshot.forecast.forecastId,
              version: snapshot.forecast.version,
              assumptions: snapshot.forecast.assumptions,
              assumptionHash: snapshot.forecast.assumptionHash,
              periods: snapshot.forecast.periods,
            },
            fx: { version: snapshot.fx.version, rates: snapshot.fx.rates },
            terms: snapshot.terms,
            range: {
              downsideMinor: snapshot.range.downsideMinor,
              baseMinor: snapshot.range.baseMinor,
              upsideMinor: snapshot.range.upsideMinor,
            },
          }
        : null,
      gaps,
      waivers: [...waiverIds].map((id) => this.waivers.get(id)!),
    };
  }

  listGaps(status?: GapProposal["status"]) {
    return this.gaps.filter((g) => (status ? g.status === status : true)).map((g) => this.gapView(g));
  }

  listPools() {
    return [...this.pools.keys()].map((key) => this.poolView(key, "base"));
  }

  // ---------- 内部工具 ----------

  private requirePool(poolKey: string): PoolState {
    const pool = this.pools.get(poolKey);
    if (!pool) throw new Error(`预算池 ${poolKey} 不存在`);
    return pool;
  }

  private lookupPool(dims: PoolDimensions): PoolState {
    const key = this.poolsByDims.get(stableStringify(dims));
    if (!key) throw new Error(`没有匹配维度的预算池: ${JSON.stringify(dims)}`);
    return this.pools.get(key)!;
  }

  private resolveForecast(forecastId: string, versionWanted?: number): ForecastRecord {
    const map = this.forecasts.get(forecastId);
    if (!map) throw new Error(`预测 ${forecastId} 未发布`);
    const versions = [...map.keys()].sort((a, b) => a - b);
    const version = versionWanted ?? versions[versions.length - 1];
    const record = map.get(version);
    if (!record) throw new Error(`预测 ${forecastId} v${version} 不存在`);
    return record;
  }

  private requireActiveFx(): string {
    if (!this.activeFx) throw new Error("尚无已启用汇率版本");
    return this.activeFx;
  }

  private requireProposal(proposalId: string) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error("方案不存在");
    return proposal;
  }

  /** 幂等指纹：项目+池维度+条款+预测引用，不含申请人、TTL 等请求元数据。 */
  private requestFingerprint(
    projectId: string,
    dims: PoolDimensions,
    terms: NegotiationTerms,
    forecastId: string,
    version: number,
  ): string {
    return fingerprint({ projectId, pool: dims, terms, forecast: { id: forecastId, version } });
  }

  // ---------- 事件投影（重放与实时共用同一套逻辑） ----------

  private apply(event: DomainEvent): void {
    switch (event.type) {
      case "PoolCreated": {
        const d = event.data as EventData["PoolCreated"];
        this.pools.set(d.poolKey, {
          key: d.poolKey,
          dims: d.dims,
          versions: [{ version: 1, totalMinor: d.totalMinor, at: event.at }],
        });
        this.poolsByDims.set(stableStringify(d.dims), d.poolKey);
        break;
      }
      case "PoolVersioned": {
        const d = event.data as EventData["PoolVersioned"];
        this.pools.get(d.poolKey)!.versions.push({
          version: d.poolVersion,
          totalMinor: d.totalMinor,
          at: event.at,
        });
        break;
      }
      case "ForecastPublished": {
        const d = event.data as EventData["ForecastPublished"];
        const f = d.forecast;
        if (!this.forecasts.has(f.forecastId)) this.forecasts.set(f.forecastId, new Map());
        this.forecasts.get(f.forecastId)!.set(f.version, f);
        break;
      }
      case "FxVersionDefined": {
        const d = event.data as EventData["FxVersionDefined"];
        this.fx.set(d.version, d.rates);
        break;
      }
      case "FxActivated": {
        const d = event.data as EventData["FxActivated"];
        this.activeFx = d.version;
        break;
      }
      case "WaiverGranted": {
        const d = event.data as EventData["WaiverGranted"];
        this.waivers.set(d.waiver.waiverId, d.waiver);
        if (d.waiver.occupancyId) {
          const occ = this.occupancies.get(d.waiver.occupancyId);
          if (occ && !occ.waiverIds.includes(d.waiver.waiverId)) {
            occ.waiverIds.push(d.waiver.waiverId);
          }
        }
        break;
      }
      case "ProposalSubmitted": {
        const d = event.data as EventData["ProposalSubmitted"];
        const occ: OccupancyState = {
          occupancyId: d.occupancyId,
          proposalId: d.proposalId,
          version: d.version,
          projectId: d.projectId,
          poolKey: d.poolKey,
          dims: d.dims,
          status: "HELD",
          forecastRef: d.forecastRef,
          fxVersion: d.fxVersion,
          range: d.range,
          terms: d.terms,
          original: {
            currency: d.terms.currency,
            guaranteeMinor: d.terms.guaranteeMinor,
            milestonesMinor: d.terms.milestones.reduce((a, m) => a + m.amountMinor, ZERO),
          },
          submittedBy: d.submittedBy,
          approverId: null,
          flags: d.flags,
          waiverIds: d.waiverUses.map((u) => u.waiverId),
          waiverUses: d.waiverUses,
          shortfallMinor: d.shortfallMinor,
          createdAt: d.createdAt,
          expiresAt: d.expiresAt,
          signedAt: null,
          releasedAt: null,
        };
        this.occupancies.set(d.occupancyId, occ);
        if (!this.occupancyVersions.has(d.occupancyId)) {
          this.occupancyVersions.set(d.occupancyId, []);
        }
        this.occupancyVersions.get(d.occupancyId)!.push(occ);
        const existingIdem = this.idemIndex.get(d.idempotencyKey);
        const fp = this.requestFingerprint(
          d.projectId,
          d.dims,
          d.terms,
          d.forecastRef.forecastId,
          d.forecastRef.version,
        );
        if (existingIdem) {
          existingIdem.fingerprints.set(fp, d.version);
        } else {
          this.idemIndex.set(d.idempotencyKey, {
            occupancyId: d.occupancyId,
            fingerprints: new Map([[fp, d.version]]),
          });
        }
        for (const use of d.waiverUses) {
          void use; // 消耗由当前 HELD 占用派生（见 waiverConsumedAmount）
        }
        const existing = this.proposals.get(d.proposalId);
        if (existing) {
          existing.version = d.version;
          existing.status = "SUBMITTED";
        } else {
          this.proposals.set(d.proposalId, {
            proposalId: d.proposalId,
            projectId: d.projectId,
            status: "SUBMITTED",
            occupancyId: d.occupancyId,
            version: d.version,
            submittedBy: d.submittedBy,
          });
        }
        break;
      }
      case "ProposalApproved": {
        const d = event.data as EventData["ProposalApproved"];
        this.proposals.get(d.proposalId)!.status = "APPROVED";
        const occ = this.occupantOfProposal(d.proposalId, d.version);
        occ.approverId = d.approverId;
        if (d.waiverId && !occ.waiverIds.includes(d.waiverId)) occ.waiverIds.push(d.waiverId);
        if (d.waiverUse) {
          // 同一豁免可在提交与批准两个环节分别动用，额度按笔累加
          occ.waiverUses.push(d.waiverUse);
          if (!occ.waiverIds.includes(d.waiverUse.waiverId)) occ.waiverIds.push(d.waiverUse.waiverId);
          occ.shortfallMinor = ZERO; // 缺口已由豁免覆盖
        }
        break;
      }
      case "ProposalSigned": {
        const d = event.data as EventData["ProposalSigned"];
        this.proposals.get(d.proposalId)!.status = "SIGNED";
        const occ = this.occupantOfProposal(d.proposalId, d.version);
        occ.status = "SIGNED";
        occ.signedAt = d.snapshot.signedAt;
        this.snapshots.set(d.proposalId, d.snapshot);
        break;
      }
      case "OccupancyReevaluated": {
        const d = event.data as EventData["OccupancyReevaluated"];
        const current = this.occupancies.get(d.occupancyId)!;
        if (d.targetPoolKey) {
          // 跨池（延期）：旧占用状态对象封存为 RELEASED，建立新的 HELD 投影
          current.status = "RELEASED";
          current.releasedAt = event.at;
          const moved: OccupancyState = {
            ...current,
            status: "HELD",
            signedAt: null,
            releasedAt: null,
            poolKey: d.targetPoolKey,
            dims: d.dims,
            range: d.range,
            terms: d.terms,
            forecastRef: d.forecastRef,
            fxVersion: d.fxVersion,
            flags: [...new Set([...current.flags, ...d.addedFlags, "POOL_WAIVER_NOT_TRANSFERRED"])],
            shortfallMinor: d.shortfallMinor,
            approverId: current.approverId,
            waiverIds: [],
            // 池级豁免不随跨池搬迁转移；目标池余额不足以 shortfall/flags 暴露
            waiverUses: [],
          };
          this.occupancies.set(d.occupancyId, moved);
          this.occupancyVersions.get(d.occupancyId)!.push(moved);
        } else {
          current.range = d.range;
          current.terms = d.terms;
          current.forecastRef = d.forecastRef;
          current.fxVersion = d.fxVersion;
          current.shortfallMinor = d.shortfallMinor;
          for (const f of d.addedFlags) if (!current.flags.includes(f)) current.flags.push(f);
        }
        break;
      }
      case "OccupancyReleased": {
        const d = event.data as EventData["OccupancyReleased"];
        const occ = this.occupancies.get(d.occupancyId);
        if (occ && occ.status !== "RELEASED") {
          occ.status = "RELEASED";
          occ.releasedAt = event.at;
        }
        if (d.proposalStatus) {
          const proposal = this.proposals.get(occ?.proposalId ?? "");
          if (proposal && proposal.version === occ?.version) proposal.status = d.proposalStatus;
        }
        break;
      }
      case "ProposalTerminated": {
        const d = event.data as EventData["ProposalTerminated"];
        this.proposals.get(d.proposalId)!.status = "TERMINATED";
        break;
      }
      case "GapOpened": {
        const d = event.data as EventData["GapOpened"];
        this.gaps.push(d.gap);
        this.gapDedup.add(d.dedupKey);
        break;
      }
      case "GapResolved": {
        const d = event.data as EventData["GapResolved"];
        const gap = this.gaps.find((g) => g.gapId === d.gapId)!;
        gap.status = d.status;
        gap.resolutionNote = d.note;
        gap.waiverId = d.waiverId;
        gap.resolvedAt = event.at;
        break;
      }
      case "TaskEnqueued":
      case "TaskFinished":
        break;
    }
  }

  private occupantOfProposal(proposalId: string, version: number): OccupancyState {
    const p = this.proposals.get(proposalId)!;
    const occ = this.occupancies.get(p.occupancyId)!;
    if (occ.version !== version) throw new Error("版本不一致");
    return occ;
  }
}
