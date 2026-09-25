import { createHash } from "node:crypto";
import { convert, type FxRates } from "./money.js";
import type {
  ForecastPeriod,
  ForecastRecord,
  NegotiationTerms,
  StressRange,
} from "./types.js";

export function hashAssumptions(assumptions: Readonly<Record<string, number>>): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(assumptions).sort(([a], [b]) => a.localeCompare(b))),
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function buildForecast(input: {
  forecastId: string;
  version: number;
  supersedesVersion: number | null;
  currency: string;
  assumptions: Record<string, number>;
  periods: ForecastPeriod[];
  publishedAt: number;
}): ForecastRecord {
  return { ...input, assumptionHash: hashAssumptions(input.assumptions) };
}

/**
 * 计算谈判条款在三档预测下的压力区间（输出为预算池币种整数）。
 *
 * 口径：
 * - 一个占用绑定一个池期间：仅 duePeriod === poolPeriod 的里程碑、分成期间 === poolPeriod 的或有分成计入该占用；
 *   覆盖多个期间的方案需对每个池分别提交占用。
 * - 保底为无条件付款，全额计入申请所指池期间；
 * - 里程碑在 downside 即视为全额触发；
 * - 或有分成 = 分成比例 × 该期间预测收入，分别套 downside/base/upside；
 * - downside = 保底 + 里程碑 + 或有(downside)，upside 同理；
 * - 固定部分（保底+里程碑）在申请提交时按条款币种换算；分成基数为预测币种，逐期间换算后求和。
 */
export function computeStressRange(input: {
  terms: NegotiationTerms;
  forecast: ForecastRecord;
  rates: FxRates;
  fxVersion: string;
  poolCurrency: string;
  poolPeriod: string;
}): StressRange {
  const { terms, forecast, rates, fxVersion, poolCurrency, poolPeriod } = input;

  const guarantee = convert(terms.guaranteeMinor, terms.currency, poolCurrency, rates);
  const milestones = terms.milestones
    .filter((m) => m.duePeriod === poolPeriod)
    .reduce(
      (acc, m) => acc + convert(m.amountMinor, terms.currency, poolCurrency, rates),
      0n,
    );

  const bips = BigInt(terms.contingent.bips);
  let cDown = 0n;
  let cBase = 0n;
  let cUp = 0n;
  for (const p of forecast.periods) {
    if (p.period !== poolPeriod) continue;
    if (!terms.contingent.periods.includes(p.period)) continue;
    cDown += divRoundBips(
      convert(p.downsideMinor, forecast.currency, poolCurrency, rates),
      bips,
    );
    cBase += divRoundBips(
      convert(p.baseMinor, forecast.currency, poolCurrency, rates),
      bips,
    );
    cUp += divRoundBips(
      convert(p.upsideMinor, forecast.currency, poolCurrency, rates),
      bips,
    );
  }

  return {
    guaranteeMinor: guarantee,
    milestonesMinor: milestones,
    contingentDownsideMinor: cDown,
    contingentBaseMinor: cBase,
    contingentUpsideMinor: cUp,
    downsideMinor: guarantee + milestones + cDown,
    baseMinor: guarantee + milestones + cBase,
    upsideMinor: guarantee + milestones + cUp,
    fxVersion,
  };
}

function divRoundBips(amount: bigint, bips: bigint): bigint {
  const half = 5_000n;
  return (amount * bips + (amount < 0n ? -half : half)) / 10_000n;
}

/**
 * 校验谈判方案与预测、池期间匹配。
 * 一个占用绑定一个池期间：里程碑到期期间与分成期间都必须等于该池期间；
 * 跨多期的合同须按池分别提交申请，避免保底被重复承诺或付款被静默漏掉。
 */
export function assertForecastCovers(
  forecast: ForecastRecord,
  terms: NegotiationTerms,
  poolPeriod: string,
): void {
  for (const wanted of terms.contingent.periods) {
    if (wanted !== poolPeriod) {
      throw new Error(`分成期间 ${wanted} 不属于池期间 ${poolPeriod}，请按期间分别申请`);
    }
    const hit = forecast.periods.find((p) => p.period === wanted);
    if (!hit) throw new Error(`预测 ${forecast.forecastId} 不覆盖分成期间 ${wanted}`);
    if (!(hit.downsideMinor <= hit.baseMinor && hit.baseMinor <= hit.upsideMinor)) {
      throw new Error(`预测期间 ${wanted} 收入档位不满足 downside<=base<=upside`);
    }
  }
  for (const m of terms.milestones) {
    if (m.amountMinor < 0n) throw new Error("里程碑金额不能为负");
    if (m.duePeriod !== poolPeriod) {
      throw new Error(`里程碑 ${m.id} 到期期间 ${m.duePeriod} 不属于池期间 ${poolPeriod}，请按期间分别申请`);
    }
  }
  if (terms.guaranteeMinor < 0n) throw new Error("保底金额不能为负");
  if (terms.contingent.bips < 0 || terms.contingent.bips > 10_000) {
    throw new Error("分成比例超出 0..10000 bps");
  }
}
