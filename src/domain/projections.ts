/**
 * 读模型（投影）：重放事件日志得到当前状态。
 *
 * 版本化实体（预算池、预测、谈判方案/占用）保留全部历史版本；
 * 占用的容量生命周期通过补偿事件严格对称记账：
 *   预留 +N（提交/批准），释放 -N（拒绝/取消/到期/终止/签约结转）。
 */
import type {
  ApprovalRecord,
  ContractSnapshot,
  DomainEvent,
  ForecastVersion,
  FxVersion,
  GapProposal,
  OccupancyVersion,
  PoolVersion,
  ReevaluationJob,
  StoredEvent,
  Waiver,
} from "./model.js";

interface OccupancyLine {
  /** 版本号 -> 版本内容（全部保留，不可倒改） */
  versions: Map<number, OccupancyVersion>;
  latest: number;
}

export class Projection {
  /** poolId -> 全部版本 */
  pools = new Map<string, PoolVersion[]>();
  /** (currency|region|type|period) -> poolId（当前版本线） */
  poolByKey = new Map<string, string>();

  forecasts = new Map<string, ForecastVersion[]>();
  fxVersions = new Map<number, FxVersion>();
  latestFxVersion = 0;

  occupancies = new Map<string, OccupancyLine>();
  /** idempotencyKey -> proposalId（相同申请重试沿用原占用） */
  idempotency = new Map<string, string>();

  contracts = new Map<string, ContractSnapshot>();
  /** proposalId -> contractId */
  contractByProposal = new Map<string, string>();

  waivers = new Map<string, Waiver>();
  compensations: StoredEvent[] = [];
  /** poolId -> 按发生顺序的容量流水（正数预留，负数释放） */
  reservations = new Map<string, Array<{ ref: string; amount: number }>>();

  gaps: GapProposal[] = [];
  gapByContract = new Map<string, string[]>();

  jobs = new Map<string, ReevaluationJob>();
  approvals: ApprovalRecord[] = [];

  // ------------------------------------------------------------------ 工具

  static poolKey(k: PoolVersion["key"]): string {
    return [k.currency, k.region, k.contentType, k.period].join("|");
  }

  pool(id: string): PoolVersion | undefined {
    return this.pools.get(id)?.at(-1);
  }

  currentPoolById(id: string): PoolVersion | undefined {
    return this.pool(id);
  }

  poolByDimensions(key: PoolVersion["key"]): PoolVersion | undefined {
    const id = this.poolByKey.get(Projection.poolKey(key));
    return id ? this.pool(id) : undefined;
  }

  forecast(id: string): ForecastVersion | undefined {
    return this.forecasts.get(id)?.at(-1);
  }

  forecastAt(id: string, version: number): ForecastVersion | undefined {
    return this.forecasts.get(id)?.find((f) => f.version === version);
  }

  fx(version: number): FxVersion | undefined {
    return this.fxVersions.get(version);
  }

  latestFx(): FxVersion | undefined {
    return this.latestFxVersion ? this.fxVersions.get(this.latestFxVersion) : undefined;
  }

  occupancy(proposalId: string): OccupancyVersion | undefined {
    const line = this.occupancies.get(proposalId);
    return line ? line.versions.get(line.latest) : undefined;
  }

  occupancyVersion(proposalId: string, version: number): OccupancyVersion | undefined {
    return this.occupancies.get(proposalId)?.versions.get(version);
  }

  allOccupancies(): OccupancyVersion[] {
    return [...this.occupancies.values()].map((l) => l.versions.get(l.latest)!);
  }

  getLine(proposalId: string) {
    return this.occupancies.get(proposalId);
  }

  latestVersionOf(proposalId: string): number | undefined {
    return this.occupancies.get(proposalId)?.latest;
  }

  /** 某方案自身在占用流水里的净预留（仅活跃占用有余额） */
  ownReserved(proposalId: string): number {
    const o = this.occupancy(proposalId);
    if (!o) return 0;
    if (o.status === "pending_approval" || o.status === "approved") {
      return o.reservedAmount;
    }
    return 0;
  }

  /** 除指定方案外其他方案的净占用 */
  reservedNetExcept(poolId: string, proposalId: string): number {
    return this.reservedNet(poolId) - this.ownReserved(proposalId);
  }

  contract(proposalId: string): ContractSnapshot | undefined {
    const cid = this.contractByProposal.get(proposalId);
    return cid ? this.contracts.get(cid) : undefined;
  }

  /** 占用预留净额（未被补偿/签约结转抵消的部分），版本更替时旧版需先释放 */
  reservedNet(poolId: string): number {
    const ledger = this.reservations.get(poolId);
    if (!ledger) return 0;
    return ledger.reduce((sum, e) => sum + e.amount, 0);
  }

  /** 已签承诺额：active 合同的签署快照金额之和 */
  signedCommitted(poolId: string): number {
    let sum = 0;
    for (const c of this.contracts.values()) {
      if (c.poolId === poolId && c.status === "active") sum += c.committedAmount;
    }
    return sum;
  }

  pendingJobs(): ReevaluationJob[] {
    return [...this.jobs.values()].filter((j) => j.status === "pending");
  }

  // ------------------------------------------------------------------ 折叠

  apply(stored: StoredEvent) {
    const { event } = stored;
    switch (event.type) {
      case "PoolPublished": {
        const p = event.payload;
        const list = this.pools.get(p.poolId) ?? [];
        list.push(p);
        this.pools.set(p.poolId, list);
        this.poolByKey.set(Projection.poolKey(p.key), p.poolId);
        break;
      }
      case "PoolClosed": {
        const closedList = this.pools.get(event.payload.poolId);
        const cur = closedList?.at(-1);
        if (cur && closedList) {
          closedList[closedList.length - 1] = { ...cur, status: "closed" };
        }
        break;
      }
      case "ForecastPublished": {
        const f = event.payload;
        const list = this.forecasts.get(f.forecastId) ?? [];
        list.push(f);
        this.forecasts.set(f.forecastId, list);
        break;
      }
      case "ForecastSuperseded": {
        const list = this.forecasts.get(event.payload.forecastId);
        const cur = list?.find((f) => f.version === event.payload.version);
        if (cur) {
          cur.status = "superseded";
          cur.supersededBy = event.payload.successor;
        }
        break;
      }
      case "FxPublished": {
        this.fxVersions.set(event.payload.version, event.payload);
        this.latestFxVersion = Math.max(this.latestFxVersion, event.payload.version);
        break;
      }
      case "ProposalSubmitted":
      case "OccupancyReevaluated": {
        const o =
          event.type === "ProposalSubmitted"
            ? event.payload.occupancy
            : event.payload.occupancy;
        const line = this.occupancies.get(o.proposalId) ?? {
          versions: new Map(),
          latest: 0,
        };
        const previous = line.versions.get(line.latest);
        line.versions.set(o.version, o);
        line.latest = o.version;
        this.occupancies.set(o.proposalId, line);
        this.idempotency.set(o.idempotencyKey, o.proposalId);

        // 容量账：新版本替换旧预留（旧版释放、新版入账）。
        // 仅当旧版本仍是活跃占用时冲账；rejected/cancelled/expired 的预留
        // 已分别通过拒绝/补偿事件释放，不能再冲一次（否则净额为负）；
        // signed/terminated 在服务层已禁止再提交。
        const ledger = this.reservations.get(o.poolId) ?? [];
        if (previous && (previous.status === "pending_approval" || previous.status === "approved")) {
          ledger.push({ ref: `v${previous.version}:superseded`, amount: -previous.reservedAmount });
        }
        ledger.push({ ref: `${o.proposalId}:v${o.version}`, amount: o.reservedAmount });
        this.reservations.set(o.poolId, ledger);

        if (event.type === "OccupancyReevaluated") {
          const latest = line.versions.get(line.latest)!;
          latest.lastReevaluation = event.payload.result;
          if (!event.payload.result.fits) {
            latest.breach = {
              at: event.payload.result.at,
              reason: event.payload.result.reason,
              shortfall: event.payload.result.shortfall ?? 0,
            };
          }
        }
        break;
      }
      case "ProposalApproved": {
        const { waiverId: _waiverId, ...record } = event.payload;
        this.approvals.push(record);
        const o = this.occupancy(record.proposalId);
        if (o) o.status = "approved";
        break;
      }
      case "ProposalRejected": {
        this.approvals.push(event.payload);
        const o = this.occupancy(event.payload.proposalId);
        if (o) {
          o.status = "rejected";
          const ledger = this.reservations.get(o.poolId)!;
          ledger.push({ ref: `${o.proposalId}:rejected`, amount: -o.reservedAmount });
        }
        break;
      }
      case "ContractSigned": {
        const c = event.payload;
        this.contracts.set(c.contractId, c);
        this.contractByProposal.set(c.proposalId, c.contractId);
        const o = this.occupancyVersion(c.proposalId, c.occupancyVersion);
        if (o) o.status = "signed";
        // 占用结转为已签承诺：占用账释放，承诺额由 contracts 投影统计
        const ledger = this.reservations.get(c.poolId) ?? [];
        ledger.push({ ref: `${c.proposalId}:signed`, amount: -c.committedAmount });
        this.reservations.set(c.poolId, ledger);
        break;
      }
      case "ProposalCancelled":
      case "ProposalExpired":
      case "ContractTerminated": {
        this.compensations.push(stored);
        const ev = event.payload as Extract<
          DomainEvent,
          { type: "ProposalCancelled" }
        >["payload"];
        if (event.type === "ProposalCancelled" || event.type === "ProposalExpired") {
          // 取消/到期释放的是未签约占用预留
          const ledger = this.reservations.get(ev.poolId) ?? [];
          ledger.push({ ref: `${ev.eventId}:release`, amount: -ev.releasedAmount });
          this.reservations.set(ev.poolId, ledger);
        }
        // 合同终止不触碰占用流水：signedCommitted 只统计 active 合同，
        // 状态置为 terminated 后承诺额自然释放。
        if (event.type === "ProposalCancelled") this.occupancy(ev.proposalId)!.status = "cancelled";
        if (event.type === "ProposalExpired") this.occupancy(ev.proposalId)!.status = "expired";
        if (event.type === "ContractTerminated") {
          const c = this.contracts.get(ev.contractId!)!;
          c.status = "terminated";
          c.terminatedAt = ev.at;
          c.terminationReason = ev.reason;
        }
        break;
      }
      case "ReevaluationJobEnqueued":
        this.jobs.set(event.payload.jobId, event.payload);
        break;
      case "ReevaluationJobCompleted":
      case "ReevaluationJobFailed":
        this.jobs.set(event.payload.jobId, event.payload);
        break;
      case "WaiverGranted":
        this.waivers.set(event.payload.waiverId, event.payload);
        break;
      case "WaiverRevoked": {
        const w = this.waivers.get(event.payload.waiverId);
        if (w) w.revokedAt = event.payload.revokedAt;
        break;
      }
      case "GapProposalCreated": {
        this.gaps.push(event.payload);
        const ids = this.gapByContract.get(event.payload.contractId) ?? [];
        ids.push(event.payload.gapId);
        this.gapByContract.set(event.payload.contractId, ids);
        break;
      }
      case "GapProposalResolved": {
        const g = this.gaps.find((x) => x.gapId === event.payload.gapId);
        if (g) {
          g.status = "resolved";
          g.resolution = event.payload.resolution;
        }
        break;
      }
    }
  }
}
