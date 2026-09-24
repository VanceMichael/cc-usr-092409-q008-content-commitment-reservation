/**
 * 金额与压力区间计算。
 *
 * 所有金额一律使用各币种最小单位（minor unit）的整数运算，
 * 禁止在对外口径中使用浮点金额；比例运算后四舍五入到整数。
 */
import crypto from "node:crypto";
import type {
  DealTerms,
  ForecastAssumptions,
  FxVersion,
  Money,
  PressureBand,
  ScenarioCode,
  StressRange,
} from "./model.js";

export const SCENARIOS: ScenarioCode[] = ["downside", "base", "upside"];

export function money(amount: number, currency: string, minorUnit: number): Money {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`金额必须是非负整数（${currency} minor unit），收到: ${amount}`);
  }
  return { amount, currency, minorUnit };
}

/** 稳定序列化：对象键排序后输出，供指纹使用 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function fingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

// ---------------------------------------------------------------------------
// 汇率换算
// ---------------------------------------------------------------------------

/**
 * 在给定汇率版本中把 from 货币金额换算为 to 货币的 minor unit 整数。
 * 支持正向汇率与反向推算；找不到汇率对时抛错。
 */
export function convert(
  amount: number,
  from: string,
  to: string,
  fx: FxVersion,
  minorUnits: { from: number; to: number },
): number {
  if (from === to) return amount;
  const direct = fx.rates.find((r) => r.from === from && r.to === to);
  const inverse = fx.rates.find((r) => r.from === to && r.to === from);
  let rate: number;
  if (direct) rate = direct.rate;
  else if (inverse) rate = 1 / inverse.rate;
  else throw new Error(`汇率版本 ${fx.version} 缺少 ${from}->${to} 的汇率`);

  const major = amount / 10 ** minorUnits.from;
  const targetMajor = major * rate;
  return Math.round(targetMajor * 10 ** minorUnits.to);
}

// ---------------------------------------------------------------------------
// 或有阶梯分成
// ---------------------------------------------------------------------------

/**
 * 按累计收入门槛分档计算分成。
 * 档 i 覆盖收入区间 [threshold_i, threshold_{i+1})，末档上不封顶。
 * 所有金额均为同一币种 minor unit 整数。
 */
export function tieredRoyalty(revenue: number, tiers: DealTerms["royaltyTiers"]): number {
  if (tiers.length === 0 || revenue <= 0) return 0;
  const sorted = [...tiers].sort((a, b) => a.threshold - b.threshold);
  let royalty = 0;
  for (let i = 0; i < sorted.length; i++) {
    const lower = sorted[i].threshold;
    const upper = i + 1 < sorted.length ? sorted[i + 1].threshold : Infinity;
    if (revenue <= lower) break;
    const portion = Math.min(revenue, upper) - lower;
    royalty += Math.round(portion * sorted[i].rate);
  }
  return royalty;
}

// ---------------------------------------------------------------------------
// 压力区间
// ---------------------------------------------------------------------------

export interface StressInput {
  terms: DealTerms;
  assumptions: ForecastAssumptions;
  fx: FxVersion;
  /** 池币种与其小数位 —— 压力区间统一换算到池币种 */
  poolCurrency: string;
  poolMinorUnit: number;
  /** 预测币种与其小数位 */
  forecastCurrency: string;
  forecastMinorUnit: number;
}

/** 单场景压力（合同币种 -> 池币种） */
function bandForScenario(
  input: StressInput,
  scenario: ScenarioCode,
): PressureBand {
  const { terms, assumptions, fx } = input;
  const contractCcy = terms.guarantee.currency;
  const contractMinor = terms.guarantee.minorUnit;

  // 1) 保底与里程碑为固定承诺（合同币种）
  const guaranteeContract = terms.guarantee.amount;
  const milestonesContract = terms.milestones.reduce((sum, m) => sum + m.amount.amount, 0);

  // 2) 预测收入先换算到合同币种，再套阶梯分成
  const revenueForecast = assumptions.revenueByScenario[scenario] ?? 0;
  const revenueContract = convert(
    revenueForecast,
    input.forecastCurrency,
    contractCcy,
    fx,
    { from: input.forecastMinorUnit, to: contractMinor },
  );
  let contingentContract = tieredRoyalty(revenueContract, terms.royaltyTiers);
  if (terms.contingentCap) {
    contingentContract = Math.min(contingentContract, terms.contingentCap.amount);
  }

  // 3) 全部换算到池币种
  const toPool = (amount: number) =>
    convert(amount, contractCcy, input.poolCurrency, fx, {
      from: contractMinor,
      to: input.poolMinorUnit,
    });

  const guarantee = toPool(guaranteeContract);
  const milestones = toPool(milestonesContract);
  const contingent = toPool(contingentContract);
  return {
    guarantee: money(guarantee, input.poolCurrency, input.poolMinorUnit),
    milestones: money(milestones, input.poolCurrency, input.poolMinorUnit),
    contingent: money(contingent, input.poolCurrency, input.poolMinorUnit),
    total: money(guarantee + milestones + contingent, input.poolCurrency, input.poolMinorUnit),
  };
}

/** 计算三档压力区间 */
export function computeStress(input: StressInput): StressRange {
  return {
    downside: bandForScenario(input, "downside"),
    base: bandForScenario(input, "base"),
    upside: bandForScenario(input, "upside"),
    fxVersion: input.fx.version,
  };
}

/** 容量预留口径：基准情景总承诺 */
export function reservedOf(stress: StressRange): number {
  return stress.base.total.amount;
}

/** 条款指纹：金额或条款变化即可识别（不含引用依据，依据变化走重评） */
export function termsFingerprint(terms: DealTerms): string {
  return fingerprint({
    guarantee: terms.guarantee,
    milestones: terms.milestones,
    royaltyTiers: terms.royaltyTiers,
    contingentCap: terms.contingentCap,
  });
}
