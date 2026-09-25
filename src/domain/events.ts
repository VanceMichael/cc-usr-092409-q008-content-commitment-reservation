import type {
  ContractSnapshot,
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

export interface WaiverUse {
  waiverId: string;
  amountMinor: bigint;
}

/**
 * 全部状态变更都以事件落盘，服务重启后通过重放恢复。
 * 金额字段为 bigint，序列化时由 store 层标记为 {"$bi": "字符串"}。
 */

export type ReleaseReason =
  | "CANCELLED"
  | "REJECTED"
  | "EXPIRED"
  | "TERMINATED"
  | "REEVALUATED"
  | "SUPERSEDED_BY_VERSION";

export type ReassessKind = "FORECAST" | "FX" | "DELAY";

export interface TaskPayloadMap {
  EXPIRE: { occupancyId: string; version: number };
  RELEASE: { occupancyId: string; reason: ReleaseReason; detail?: string };
  REASSESS:
    | {
        taskId: string;
        kind: "FORECAST";
        forecastId: string;
        oldVersion: number;
        newVersion: number;
      }
    | { taskId: string; kind: "FX"; fxVersion: string }
    | { taskId: string; kind: "DELAY"; projectId: string; periods: number };
}

export type TaskType = keyof TaskPayloadMap;

export interface DomainEvent {
  seq: number;
  at: number;
  type:
    | "PoolCreated"
    | "PoolVersioned"
    | "ForecastPublished"
    | "FxVersionDefined"
    | "FxActivated"
    | "WaiverGranted"
    | "ProposalSubmitted"
    | "ProposalApproved"
    | "ProposalSigned"
    | "OccupancyReevaluated"
    | "OccupancyReleased"
    | "ProposalTerminated"
    | "GapOpened"
    | "GapResolved"
    | "TaskEnqueued"
    | "TaskFinished";
  data: Record<string, unknown>;
}

export interface EventData {
  PoolCreated: {
    poolKey: string;
    dims: PoolDimensions;
    totalMinor: bigint;
    poolVersion: number;
  };
  PoolVersioned: { poolKey: string; poolVersion: number; totalMinor: bigint };
  ForecastPublished: { forecast: ForecastRecord };
  FxVersionDefined: { version: string; rates: Record<string, bigint> };
  FxActivated: { version: string };
  WaiverGranted: { waiver: WaiverRecord };
  ProposalSubmitted: {
    proposalId: string;
    version: number;
    occupancyId: string;
    idempotencyKey: string;
    projectId: string;
    poolKey: string;
    dims: PoolDimensions;
    poolVersionAtSubmit: number;
    terms: NegotiationTerms;
    forecastRef: OccupancyState["forecastRef"];
    fxVersion: string;
    range: StressRange;
    submittedBy: string;
    createdAt: number;
    expiresAt: number;
    replacesOccupancyId: string | null;
    shortfallMinor: bigint;
    flags: string[];
    waiverUses: WaiverUse[];
  };
  ProposalApproved: {
    proposalId: string;
    version: number;
    approverId: string;
    waiverId: string | null;
    /** 重评产生缺口时，本次批准动用的豁免额度。 */
    waiverUse: WaiverUse | null;
  };
  ProposalSigned: { proposalId: string; version: number; snapshot: ContractSnapshot };
  OccupancyReevaluated: {
    occupancyId: string;
    reason: GapReason;
    range: StressRange;
    terms: NegotiationTerms;
    forecastRef: OccupancyState["forecastRef"];
    fxVersion: string;
    poolKey: string;
    dims: PoolDimensions;
    addedFlags: string[];
    targetPoolKey: string | null;
    shortfallMinor: bigint;
  };
  OccupancyReleased: {
    occupancyId: string;
    reason: ReleaseReason;
    detail?: string;
    /** 取消/驳回/到期同步翻转的方案状态（终止走 ProposalTerminated）。 */
    proposalStatus?: Extract<
      ProposalStatus,
      "CANCELLED" | "REJECTED" | "EXPIRED"
    >;
  };
  ProposalTerminated: { proposalId: string };
  GapOpened: { gap: GapProposal; dedupKey: string };
  GapResolved: {
    gapId: string;
    status: GapProposal["status"];
    note: string;
    waiverId: string | null;
  };
  TaskEnqueued: {
    taskId: string;
    taskType: string;
    payload: TaskPayloadMap[TaskType];
    runAt: number;
  };
  TaskFinished: { taskId: string; result: string };
}

export type TypedEvent<T extends DomainEvent["type"]> = {
  seq: number;
  at: number;
  type: T;
  data: EventData[T];
};
