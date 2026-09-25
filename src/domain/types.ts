import type { Currency } from "./money.js";

/** 预算池维度：币种、地区、内容类型、期间（期间格式见 period.ts）。 */
export interface PoolDimensions {
  currency: Currency;
  region: string;
  contentType: string;
  period: string;
}

export interface MilestoneTerm {
  id: string;
  amountMinor: bigint;
  duePeriod: string;
}

export interface ContingentTerm {
  /** 分成比例，万分位（2500 = 25%）。 */
  bips: number;
  /** 参与分成的预测期间集合。 */
  periods: string[];
}

export interface NegotiationTerms {
  currency: Currency;
  guaranteeMinor: bigint;
  milestones: MilestoneTerm[];
  contingent: ContingentTerm;
}

export type ScenarioBand = "downside" | "base" | "upside";

/** 压力区间（已换算为预算池币种的最小单位整数）。 */
export interface StressRange {
  guaranteeMinor: bigint;
  milestonesMinor: bigint;
  contingentDownsideMinor: bigint;
  contingentBaseMinor: bigint;
  contingentUpsideMinor: bigint;
  downsideMinor: bigint;
  baseMinor: bigint;
  upsideMinor: bigint;
  fxVersion: string;
}

export interface ForecastPeriod {
  period: string;
  downsideMinor: bigint;
  baseMinor: bigint;
  upsideMinor: bigint;
}

export interface ForecastRecord {
  forecastId: string;
  version: number;
  supersedesVersion: number | null;
  currency: Currency;
  assumptions: Readonly<Record<string, number>>;
  assumptionHash: string;
  periods: ForecastPeriod[];
  publishedAt: number;
}

export type OccupancyStatus = "HELD" | "SIGNED" | "RELEASED";

export interface AmountsInOriginal {
  currency: Currency;
  guaranteeMinor: bigint;
  milestonesMinor: bigint;
}

export interface OccupancyState {
  occupancyId: string;
  proposalId: string;
  version: number;
  projectId: string;
  poolKey: string;
  dims: PoolDimensions;
  status: OccupancyStatus;
  /** 最近一次计算（提交或重评）时使用的预测引用与汇率版本。 */
  forecastRef: { forecastId: string; version: number; assumptionHash: string };
  fxVersion: string;
  range: StressRange;
  /** 当前生效条款（延期重评会平移期间后更新）；原始固定金额另存 original。 */
  terms: NegotiationTerms;
  original: AmountsInOriginal;
  submittedBy: string;
  approverId: string | null;
  flags: string[];
  waiverIds: string[];
  /** 建立该版本时实际动用的池级豁免额度（按池币种最小单位）。 */
  waiverUses: import("./events.js").WaiverUse[];
  /** 最近一次重评后，base 档相对当时可用余额超出的金额（未超出为 0）。 */
  shortfallMinor: bigint;
  createdAt: number;
  expiresAt: number;
  signedAt: number | null;
  releasedAt: number | null;
}

export type ProposalStatus =
  | "SUBMITTED"
  | "APPROVED"
  | "SIGNED"
  | "REJECTED"
  | "CANCELLED"
  | "EXPIRED"
  | "TERMINATED";

export interface ContractSnapshot {
  proposalId: string;
  version: number;
  occupancyId: string;
  signedAt: number;
  submittedBy: string;
  approverId: string;
  /** 签署时预算池版本（金额与维度），历史不可倒改。 */
  pool: {
    key: string;
    dims: PoolDimensions;
    poolVersion: number;
    totalMinor: bigint;
  };
  /** 签署时预测全文（含关键假设与口径）。 */
  forecast: ForecastRecord;
  /** 签署时汇率版本与费率表快照。 */
  fx: { version: string; rates: Record<string, bigint> };
  terms: NegotiationTerms;
  range: StressRange;
}

export type GapReason = "FORECAST_REPLACED" | "FX_CHANGED" | "PROJECT_DELAY";

export interface GapProposal {
  gapId: string;
  reason: GapReason;
  proposalId: string;
  occupancyId: string;
  projectId: string;
  poolKey: string;
  createdAt: number;
  status: "OPEN" | "WAIVED" | "RENEGOTIATED" | "TOPPED_UP" | "DISMISSED";
  /** 若延期导致占用跨池，记录目标池。 */
  targetPoolKey: string | null;
  /** 签署快照口径（不变）。 */
  snapshot: { downsideMinor: bigint; baseMinor: bigint; upsideMinor: bigint };
  /** 按当前预测/汇率/进度重算的“假设现在重签”口径，仅供处置参考，不过账。 */
  projected: { downsideMinor: bigint; baseMinor: bigint; upsideMinor: bigint };
  /** 各场景缺口（projected 相对快照的增量或目标池可用余额缺口）。 */
  gap: { downsideMinor: bigint; baseMinor: bigint; upsideMinor: bigint };
  detail: string;
  resolvedAt: number | null;
  resolutionNote: string | null;
  waiverId: string | null;
}

export interface WaiverRecord {
  waiverId: string;
  grantedBy: string;
  reason: string;
  amountMinor: bigint | null;
  /** 适用预算池；amountMinor 非空且 occupancyId/gapId 均为空时为池级通用豁免。 */
  poolKey: string | null;
  occupancyId: string | null;
  gapId: string | null;
  grantedAt: number;
}
