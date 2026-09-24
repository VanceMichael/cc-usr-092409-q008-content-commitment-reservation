/**
 * 内容采购承诺与容量占用 —— 领域模型
 *
 * 设计原则：
 *  - 所有状态变更都表达为不可变事件，事件日志只能追加，禁止倒改历史；
 *  - 谈判方案、占用、合同均按版本（version）保留，历史版本永久可查；
 *  - 已签合同冻结签署时的预算版本、预测版本、汇率版本（快照），
 *    预测替代 / 汇率变化 / 项目延期只触发未签约占用的重评。
 */

// ---------------------------------------------------------------------------
// 基础维度
// ---------------------------------------------------------------------------

/** 币种，ISO 4217 字母码，如 CNY / USD */
export type Currency = string;

/** 地区码，如 CN / APAC */
export type Region = string;

/** 内容类型码，如 drama / variety / sports */
export type ContentType = string;

/** 预算期间码，如 2026H1 / 2026Q1 */
export type Period = string;

/** 预算池维度键（同维度的预算池构成一条版本线） */
export interface PoolKey {
  currency: Currency;
  region: Region;
  contentType: ContentType;
  period: Period;
}

/** 压力场景标识 */
export type ScenarioCode = "base" | "downside" | "upside";

// ---------------------------------------------------------------------------
// 金额结构
// ---------------------------------------------------------------------------

/**
 * 单一币种金额。所有运算都以整数最小货币单位进行（如分），
 * 避免浮点误差；minorUnit 为该币种的小数位（CNY=2）。
 */
export interface Money {
  amount: number; // 以 minor unit 计的整数金额
  currency: Currency;
  minorUnit: number;
}

/** 三档压力场景下的承诺金额（均以预算池币种表示） */
export interface PressureBand {
  /** 保底部分（无论表现如何都必须支付） */
  guarantee: Money;
  /** 里程碑付款（按交付节点触发，此处为全额压力口径） */
  milestones: Money;
  /** 或有阶梯分成（仅在收入达到门槛时触发） */
  contingent: Money;
  /** guarantee + milestones + contingent */
  total: Money;
}

/** 完整压力区间：下行情景 / 基准情景 / 上行情景 */
export interface StressRange {
  downside: PressureBand;
  base: PressureBand;
  upside: PressureBand;
  /** 换算所用汇率版本号，供血缘追踪 */
  fxVersion: number;
}

// ---------------------------------------------------------------------------
// 谈判条款（申请输入）
// ---------------------------------------------------------------------------

/** 单一里程碑付款 */
export interface MilestoneTerm {
  code: string;
  /** 触发条件描述，如“母带交付” */
  trigger: string;
  /** 计划付款日期 ISO-8601 */
  dueDate: string;
  amount: Money;
}

/** 阶梯分成档：区间内收入 * rate，超过 threshold 后进入下一档 */
export interface RoyaltyTier {
  /** 进入该档的累计收入门槛（含），以预测币种表示；首档为 0 */
  threshold: number;
  /** 分成比例，0~1 之间 */
  rate: number;
}

/** 谈判方案的商务条款 */
export interface DealTerms {
  /** 保底金额（合同币种） */
  guarantee: Money;
  /** 里程碑付款（合同币种） */
  milestones: MilestoneTerm[];
  /** 或有阶梯分成，按收入从低到高排列 */
  royaltyTiers: RoyaltyTier[];
  /** 或有分成封顶；null 表示不封顶 */
  contingentCap: Money | null;
}

// ---------------------------------------------------------------------------
// 预测
// ---------------------------------------------------------------------------

/**
 * 已发布预测的关键假设（谈判方案必须引用并记录这些值）。
 * 这些数值是或有分成压力测算的输入：不同场景下收入假设不同。
 */
export interface ForecastAssumptions {
  /** 三档场景下的预测收入（以预测币种、minor unit 计整数） */
  revenueByScenario: Record<ScenarioCode, number>;
  /** 其他不可变假设，如留存率、广告负载等，只做存档与差异比对 */
  factors: Record<string, number>;
}

export interface ForecastVersion {
  forecastId: string;
  version: number;
  currency: Currency;
  minorUnit: number;
  /** 覆盖的期间 */
  periods: string[];
  assumptions: ForecastAssumptions;
  status: "published" | "superseded";
  /** 被哪个预测版本替代 */
  supersededBy?: { forecastId: string; version: number };
  publishedAt: string;
  publishedBy: string;
  /** 指纹：假设内容哈希，用于判断条款输入是否真正变化 */
  fingerprint: string;
}

// ---------------------------------------------------------------------------
// 汇率
// ---------------------------------------------------------------------------

export interface FxRate {
  /** 1 单位 from 货币兑换多少 to 货币 */
  rate: number;
  from: Currency;
  to: Currency;
}

export interface FxVersion {
  version: number;
  rates: FxRate[];
  publishedAt: string;
  publishedBy: string;
}

// ---------------------------------------------------------------------------
// 预算池
// ---------------------------------------------------------------------------

export interface PoolVersion {
  poolId: string;
  version: number;
  key: PoolKey;
  minorUnit: number;
  /** 该版本预算总额（minor unit 整数） */
  limit: number;
  status: "published" | "closed";
  publishedAt: string;
  publishedBy: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// 谈判方案与占用（申请聚合）
// ---------------------------------------------------------------------------

export type OccupancyStatus =
  | "pending_approval" // 已占用容量，等待审批
  | "approved" // 已批准，尚未签约
  | "rejected" // 审批拒绝（占用已释放）
  | "signed" // 已签约（转为合同，占用转为承诺）
  | "cancelled" // 申请取消（补偿事件释放）
  | "expired" // 占用到期未签约（补偿事件释放）
  | "terminated"; // 已签合同提前终止（补偿事件释放）

/** 一次申请所引用的依据 */
export interface ProposalBasis {
  poolId: string;
  poolVersion: number;
  forecastId: string;
  forecastVersion: number;
  /** 预测收入的币种与精度（血缘追踪与汇率相关性判断用） */
  forecastCurrency: Currency;
  forecastMinorUnit: number;
  fxVersion: number;
  /** 申请时刻冻结的关键假设副本 */
  assumptionsSnapshot: ForecastAssumptions;
}

/** 占用版本：每次创建或条款变化都形成一条不可变版本 */
export interface OccupancyVersion {
  version: number;
  proposalId: string;
  projectId: string;
  poolId: string;
  terms: DealTerms;
  basis: ProposalBasis;
  stress: StressRange;
  /** 容量口径：占用以“基准情景总额”在池中预留，
   *  风险口径额外展示下/上行差异 */
  reservedAmount: number;
  /** 占用有效期截止；到期未签约自动释放 */
  expiresAt: string;
  status: OccupancyStatus;
  submittedBy: string;
  submittedAt: string;
  /** 幂等键：相同申请重试沿用原占用 */
  idempotencyKey: string;
  /** 条款指纹：金额或条款变化时形成新版本 */
  termsFingerprint: string;
  /** 最近一次根据预测/汇率/延期重评的时间与结果 */
  lastReevaluation?: ReevaluationResult;
  /** 当前容量违约标记（重评不适配或预算池下调导致） */
  breach?: OccupancyBreach;
}

export interface ReevaluationResult {
  at: string;
  reason:
    | "forecast_superseded"
    | "fx_changed"
    | "project_delayed"
    | "pool_reduced";
  /** 触发事件所引用的新版本号 */
  triggerRef: string;
  /** 重评后三档压力（基准情景总额可能变化，触发余额调整） */
  stress: StressRange;
  reservedAmount: number;
  /** 相对上一版本预留金额的变化（正=需要更多容量） */
  delta: number;
  /** 重评时余额是否足以容纳新预留 */
  fits: boolean;
  /** fits=false 时，按新口径仍缺少的容量（minor unit） */
  shortfall?: number;
}

/**
 * 占用容量风险标记：重评或预算下调后当前预留无法覆盖新口径，
 * 必须追加预算、修改条款或取得人工豁免后才能签约。
 */
export interface OccupancyBreach {
  at: string;
  reason: ReevaluationResult["reason"];
  shortfall: number;
}

// ---------------------------------------------------------------------------
// 审批与豁免
// ---------------------------------------------------------------------------

export interface ApprovalRecord {
  proposalId: string;
  occupancyVersion: number;
  approver: string;
  decision: "approved" | "rejected";
  decidedAt: string;
  comment?: string;
  /** 审批人不能批准自己提交的方案，拒绝原因由服务强制 */
}

/**
 * 人工豁免：余额不足 / 重评不适配 / 风险缺口超限时，
 * 由被授权人人工放行，所有数字都必须能追到豁免记录。
 */
export interface Waiver {
  waiverId: string;
  proposalId: string;
  occupancyVersion: number;
  poolId: string;
  type: "insufficient_balance" | "reevaluation_override" | "gap_acceptance";
  amount: number; // 豁免涉及金额（池币种 minor unit）
  grantedBy: string;
  grantedAt: string;
  reason: string;
  revokedAt?: string;
}

// ---------------------------------------------------------------------------
// 合同（签约快照，不可倒改）
// ---------------------------------------------------------------------------

/**
 * 签约快照：合同一旦签署，预算版本、预测版本、汇率版本、
 * 条款与压力区间全部冻结。之后的任何变化都不得修改本记录，
 * 只能生成缺口处置提案。
 */
export interface ContractSnapshot {
  contractId: string;
  proposalId: string;
  projectId: string;
  poolId: string;
  signedAt: string;
  signedBy: string;
  /** 冻结的占用版本号 */
  occupancyVersion: number;
  terms: DealTerms;
  basis: ProposalBasis;
  stress: StressRange;
  /** 签署时冻结的承诺金额（池币种 minor unit） */
  committedAmount: number;
  status: "active" | "terminated";
  terminatedAt?: string;
  terminationReason?: string;
}

// ---------------------------------------------------------------------------
// 补偿事件（释放容量）
// ---------------------------------------------------------------------------

export interface CompensationEvent {
  eventId: string;
  proposalId: string;
  contractId?: string;
  poolId: string;
  kind: "cancellation" | "expiry" | "termination";
  /** 实际释放的容量（池币种 minor unit） */
  releasedAmount: number;
  at: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// 缺口处置提案
// ---------------------------------------------------------------------------

export type GapResolutionKind =
  | "renegotiate_contract" // 重谈合同
  | "transfer_budget" // 跨池调拨预算
  | "accept_via_waiver" // 管理层确认承接风险
  | "reduce_scope"; // 缩减采购范围

export type GapProposalStatus = "open" | "resolved" | "dismissed";

/**
 * 已签合同在其依据（预测/汇率/池预算）变化后产生的缺口提案。
 * 历史合同金额不动，缺口以“新口径 - 签署快照”的差额呈现。
 */
export interface GapProposal {
  gapId: string;
  contractId: string;
  proposalId: string;
  poolId: string;
  createdAt: string;
  reason: "forecast_superseded" | "fx_changed" | "pool_reduced" | "project_delayed";
  triggerRef: string;
  /** 按新口径重算的合同现值压力（仅用于对比，不回写合同） */
  currentStress: StressRange;
  /** 签署快照金额 */
  snapshotAmount: number;
  /** 新基准口径金额 */
  currentAmount: number;
  /** 缺口 = currentAmount - snapshotAmount（可能为负，即冗余） */
  gapAmount: number;
  suggestedResolution: GapResolutionKind;
  status: GapProposalStatus;
  resolution?: {
    kind: GapResolutionKind;
    waiverId?: string;
    resolvedBy: string;
    resolvedAt: string;
    note: string;
  };
}

// ---------------------------------------------------------------------------
// 异步重评任务（服务重启后续跑）
// ---------------------------------------------------------------------------

export type ReevaluationJobStatus = "pending" | "done" | "failed";

/**
 * 预测替代 / 汇率版本变化 / 项目延期时，为每个受影响的
 * 未签约占用创建重评任务。任务可在服务重启后继续执行。
 */
export interface ReevaluationJob {
  jobId: string;
  proposalId: string;
  occupancyVersion: number;
  reason: ReevaluationResult["reason"];
  triggerRef: string;
  status: ReevaluationJobStatus;
  attempts: number;
  createdAt: string;
  /** project_delayed 重评携带的修订输入（里程碑日期 / 目标期间） */
  input?: {
    revisedPeriod?: string;
    milestoneDueDates?: Record<string, string>;
    reason: string;
  };
  processedAt?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// 事件日志
// ---------------------------------------------------------------------------

export type DomainEvent =
  | { type: "PoolPublished"; payload: PoolVersion }
  | { type: "PoolClosed"; payload: { poolId: string; at: string } }
  | {
      type: "ForecastPublished";
      payload: ForecastVersion;
    }
  | {
      type: "ForecastSuperseded";
      payload: {
        forecastId: string;
        version: number;
        successor: { forecastId: string; version: number };
        at: string;
      };
    }
  | { type: "FxPublished"; payload: FxVersion }
  | {
      type: "ProposalSubmitted";
      payload: { occupancy: OccupancyVersion; reused: boolean };
    }
  | { type: "ProposalRejected"; payload: ApprovalRecord }
  | {
      type: "ProposalApproved";
      payload: ApprovalRecord & { waiverId?: string };
    }
  | { type: "ContractSigned"; payload: ContractSnapshot }
  | { type: "ContractTerminated"; payload: CompensationEvent }
  | { type: "ProposalCancelled"; payload: CompensationEvent }
  | { type: "ProposalExpired"; payload: CompensationEvent }
  | {
      type: "ReevaluationJobEnqueued";
      payload: ReevaluationJob;
    }
  | {
      type: "OccupancyReevaluated";
      payload: {
        /** 重评产生的新占用版本（旧版本原样保留，禁止倒改） */
        occupancy: OccupancyVersion;
        result: ReevaluationResult;
        /** 余额不足时附带的豁免（可为空，占用回到待审批风险状态） */
        waiverId?: string;
      };
    }
  | { type: "ReevaluationJobCompleted"; payload: ReevaluationJob }
  | { type: "ReevaluationJobFailed"; payload: ReevaluationJob }
  | { type: "WaiverGranted"; payload: Waiver }
  | { type: "WaiverRevoked"; payload: { waiverId: string; revokedAt: string } }
  | { type: "GapProposalCreated"; payload: GapProposal }
  | {
      type: "GapProposalResolved";
      payload: {
        gapId: string;
        resolution: GapProposal["resolution"];
      };
    };

export interface StoredEvent {
  seq: number;
  at: string;
  event: DomainEvent;
}
