/**
 * 读模型分析视图：
 *  - 预算池台账：按压力场景给出已签 / 占用 / 可用 / 风险缺口；
 *  - 每个数字都可下钻到合同或占用版本、预测依据与人工豁免；
 *  - 多场景对比：按币种聚合各场景风险。
 */
import type {
  CompensationEvent,
  ContractSnapshot,
  GapProposal,
  OccupancyVersion,
  ScenarioCode,
  StressRange,
  Waiver,
} from "./model.js";
import type { EventStore } from "./store.js";
import type { Projection } from "./projections.js";
import { SCENARIOS } from "./math.js";

interface ScenarioAmounts {
  signed: number;
  occupied: number;
}

interface FullScenarioAmounts extends ScenarioAmounts {
  committed: number;
  available: number;
  riskGap: number;
}

interface CompareAmounts {
  signed: number;
  occupied: number;
  limit: number;
  available: number;
  riskGap: number;
}

/** 构成某一数字的可下钻条目 */
export interface LedgerItem {
  kind: "contract" | "occupancy";
  ref: string; // contractId / proposalId
  projectId: string;
  /** 占用/合同的全部版本号（历史可追） */
  versions: number[];
  status: string;
  amounts: Record<ScenarioCode, number>;
  /** 预测依据（版本 + 关键假设快照） */
  basis: {
    poolVersion: number;
    forecastId: string;
    forecastVersion: number;
    fxVersion: number;
    assumptionsSnapshot: OccupancyVersion["basis"]["assumptionsSnapshot"];
  };
  /** 关联的人工豁免（有效/已撤销均展示） */
  waivers: Waiver[];
  /** 占用当前容量违约（如有） */
  breach?: OccupancyVersion["breach"];
  /** 未结缺口提案（合同） */
  openGaps: GapProposal[];
}

export interface PoolLedger {
  poolId: string;
  currency: string;
  region: string;
  contentType: string;
  period: string;
  poolVersion: number;
  poolStatus: string;
  limit: number;
  scenarios: Record<ScenarioCode, FullScenarioAmounts>;
  /** 已被占用但重评不适配的容量缺口（必须豁免或改条款） */
  outstandingBreaches: number;
  /** 已签合同因依据变化产生的未结缺口 */
  openContractGaps: number;
  items: LedgerItem[];
}

export class Analytics {
  constructor(
    private p: Projection,
    private store: EventStore,
  ) {}

  // ------------------------------------------------------------- 单池台账

  poolLedger(poolId: string): PoolLedger | undefined {
    const pool = this.p.pool(poolId);
    if (!pool) return undefined;

    const items: LedgerItem[] = [];
    const totals = blankTotals();

    for (const c of this.p.contracts.values()) {
      if (c.poolId !== poolId || c.status !== "active") continue;
      const amounts = stressAmounts(c.stress);
      for (const s of SCENARIOS) totals[s].signed += amounts[s];
      items.push({
        kind: "contract",
        ref: c.contractId,
        projectId: c.projectId,
        versions: this.versionsOf(c.proposalId),
        status: c.status,
        amounts,
        basis: {
          poolVersion: c.basis.poolVersion,
          forecastId: c.basis.forecastId,
          forecastVersion: c.basis.forecastVersion,
          fxVersion: c.basis.fxVersion,
          assumptionsSnapshot: c.basis.assumptionsSnapshot,
        },
        waivers: this.waiversOf(c.proposalId),
        openGaps: this.p.gaps.filter(
          (g) => g.contractId === c.contractId && g.status === "open",
        ),
      });
    }

    for (const o of this.p.allOccupancies()) {
      if (o.poolId !== poolId) continue;
      if (o.status !== "pending_approval" && o.status !== "approved") continue;
      const amounts = stressAmounts(o.stress);
      for (const s of SCENARIOS) totals[s].occupied += amounts[s];
      items.push({
        kind: "occupancy",
        ref: o.proposalId,
        projectId: o.projectId,
        versions: this.versionsOf(o.proposalId),
        status: o.status,
        amounts,
        basis: {
          poolVersion: o.basis.poolVersion,
          forecastId: o.basis.forecastId,
          forecastVersion: o.basis.forecastVersion,
          fxVersion: o.basis.fxVersion,
          assumptionsSnapshot: o.basis.assumptionsSnapshot,
        },
        waivers: this.waiversOf(o.proposalId),
        breach: o.breach,
        openGaps: [],
      });
    }

    const scenarios = {} as Record<ScenarioCode, FullScenarioAmounts>;
    let outstandingBreaches = 0;
    for (const s of SCENARIOS) {
      const t = totals[s];
      const committed = t.signed + t.occupied;
      scenarios[s] = {
        signed: t.signed,
        occupied: t.occupied,
        committed,
        available: pool.limit - committed,
        riskGap: Math.max(0, committed - pool.limit),
      };
    }
    for (const o of this.p.allOccupancies()) {
      if (o.poolId === poolId && o.breach) outstandingBreaches += o.breach.shortfall;
    }
    const openContractGaps = this.p.gaps
      .filter((g) => g.poolId === poolId && g.status === "open")
      .reduce((sum, g) => sum + Math.max(0, g.gapAmount), 0);

    return {
      poolId,
      currency: pool.key.currency,
      region: pool.key.region,
      contentType: pool.key.contentType,
      period: pool.key.period,
      poolVersion: pool.version,
      poolStatus: pool.status,
      limit: pool.limit,
      scenarios,
      outstandingBreaches,
      openContractGaps,
      items,
    };
  }

  // ------------------------------------------------------------- 多场景对比

  /**
   * 场景对比：按币种聚合所有（或过滤后的）预算池，
   * 输出三档场景下的已签 / 占用 / 可用 / 风险缺口。
   */
  compareScenarios(filter?: {
    region?: string;
    contentType?: string;
    period?: string;
  }): Array<{
    currency: string;
    poolCount: number;
    scenarios: Record<ScenarioCode, CompareAmounts>;
    poolRisk: Array<{ poolId: string; riskGap: Record<ScenarioCode, number> }>;
  }> {
    const byCurrency = new Map<
      string,
      {
        pools: string[];
        acc: Record<ScenarioCode, { signed: number; occupied: number; limit: number }>;
        risk: Array<{ poolId: string; riskGap: Record<ScenarioCode, number> }>;
      }
    >();

    for (const list of this.p.pools.values()) {
      const pool = list.at(-1)!;
      if (filter?.region && pool.key.region !== filter.region) continue;
      if (filter?.contentType && pool.key.contentType !== filter.contentType) continue;
      if (filter?.period && pool.key.period !== filter.period) continue;
      const ledger = this.poolLedger(pool.poolId)!;
      let entry = byCurrency.get(pool.key.currency);
      if (!entry) {
        entry = { pools: [], acc: blankZeroAcc(), risk: [] };
        byCurrency.set(pool.key.currency, entry);
      }
      entry.pools.push(pool.poolId);
      const riskGap = {} as Record<ScenarioCode, number>;
      for (const s of SCENARIOS) {
        entry.acc[s].signed += ledger.scenarios[s].signed;
        entry.acc[s].occupied += ledger.scenarios[s].occupied;
        entry.acc[s].limit += pool.limit;
        riskGap[s] = ledger.scenarios[s].riskGap;
      }
      entry.risk.push({ poolId: pool.poolId, riskGap });
    }

    return [...byCurrency.entries()].map(([currency, e]) => {
      const scenarios = {} as Record<ScenarioCode, CompareAmounts>;
      for (const s of SCENARIOS) {
        const { signed, occupied, limit } = e.acc[s];
        scenarios[s] = {
          signed,
          occupied,
          limit,
          available: limit - signed - occupied,
          riskGap: Math.max(0, signed + occupied - limit),
        };
      }
      return { currency, poolCount: e.pools.length, scenarios, poolRisk: e.risk };
    });
  }

  // ------------------------------------------------------------- 血缘

  /** 任一方案/合同数字的完整血缘：版本、审批、豁免、缺口、补偿、事件 */
  lineage(proposalId: string) {
    const line = this.p.getLine(proposalId);
    const versions = line
      ? [...line.versions.values()].sort((a, b) => a.version - b.version)
      : [];
    const contract = this.p.contract(proposalId);
    const approvals = this.p.approvals.filter((a) => a.proposalId === proposalId);
    const waivers = [...this.p.waivers.values()].filter(
      (w) => w.proposalId === proposalId,
    );
    const gaps = contract
      ? this.p.gaps.filter((g) => g.contractId === contract.contractId)
      : [];
    const compensations: CompensationEvent[] = [];
    for (const s of this.p.compensations) {
      const e = s.event;
      if (
        (e.type === "ProposalCancelled" ||
          e.type === "ProposalExpired" ||
          e.type === "ContractTerminated") &&
        e.payload.proposalId === proposalId
      ) {
        compensations.push(e.payload as CompensationEvent);
      }
    }
    const jobs = [...this.p.jobs.values()].filter((j) => j.proposalId === proposalId);
    const eventTrail = this.store
      .all()
      .filter((s) => JSON.stringify(s.event).includes(proposalId))
      .map((s) => ({ seq: s.seq, at: s.at, type: s.event.type }));

    return {
      proposalId,
      projectId: versions.at(-1)?.projectId ?? contract?.projectId,
      versions: versions.map(versionView),
      currentStatus: versions.at(-1)?.status ?? (contract ? "signed" : undefined),
      contract: contract ? contractView(contract) : undefined,
      approvals,
      waivers,
      gapProposals: gaps,
      compensations,
      reevaluationJobs: jobs,
      eventTrail,
    };
  }

  // ------------------------------------------------------------- 工具

  private versionsOf(proposalId: string): number[] {
    const line = this.p.getLine(proposalId);
    return line ? [...line.versions.keys()].sort((a, b) => a - b) : [];
  }

  private waiversOf(proposalId: string): Waiver[] {
    return [...this.p.waivers.values()].filter((w) => w.proposalId === proposalId);
  }
}

function stressAmounts(stress: StressRange): Record<ScenarioCode, number> {
  return {
    downside: stress.downside.total.amount,
    base: stress.base.total.amount,
    upside: stress.upside.total.amount,
  };
}

function blankTotals(): Record<ScenarioCode, ScenarioAmounts> {
  return {
    downside: { signed: 0, occupied: 0 },
    base: { signed: 0, occupied: 0 },
    upside: { signed: 0, occupied: 0 },
  };
}

function blankZeroAcc(): Record<
  ScenarioCode,
  { signed: number; occupied: number; limit: number }
> {
  return {
    downside: { signed: 0, occupied: 0, limit: 0 },
    base: { signed: 0, occupied: 0, limit: 0 },
    upside: { signed: 0, occupied: 0, limit: 0 },
  };
}

function versionView(o: OccupancyVersion) {
  return {
    version: o.version,
    status: o.status,
    submittedAt: o.submittedAt,
    submittedBy: o.submittedBy,
    expiresAt: o.expiresAt,
    reservedAmount: o.reservedAmount,
    stress: o.stress,
    basis: o.basis,
    termsFingerprint: o.termsFingerprint,
    lastReevaluation: o.lastReevaluation,
    breach: o.breach,
  };
}

function contractView(c: ContractSnapshot) {
  return {
    contractId: c.contractId,
    signedAt: c.signedAt,
    signedBy: c.signedBy,
    occupancyVersion: c.occupancyVersion,
    committedAmount: c.committedAmount,
    status: c.status,
    terminatedAt: c.terminatedAt,
    terminationReason: c.terminationReason,
    /** 签署快照：后续任何变化不得修改这些值 */
    snapshot: {
      terms: c.terms,
      basis: c.basis,
      stress: c.stress,
    },
  };
}
