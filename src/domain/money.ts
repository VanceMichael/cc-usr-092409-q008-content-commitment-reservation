/**
 * 金额一律使用币种最小单位的整数（bigint），禁止浮点参与金额运算。
 * 汇率以 1e6 为缩放比例存储整数：rates[CCY] 表示每 1e6 单位 CCY 兑换多少基准币种。
 */

export const FX_SCALE = 1_000_000n;

export type Currency = string;

export interface Money {
  readonly minor: bigint;
  readonly currency: Currency;
}

export function money(minor: bigint | number | string, currency: Currency): Money {
  return { minor: BigInt(minor), currency };
}

/** 四舍五入整数除法（仅用于非负数）。 */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("除数为零");
  const negative = numerator < 0n;
  const a = negative ? -numerator : numerator;
  const q = a / denominator;
  const r = a % denominator;
  const result = r * 2n >= denominator ? q + 1n : q;
  return negative ? -result : result;
}

/**
 * 解析十进制字符串为按 scale 缩放的整数，例如 parseDecimal("7.12", 1_000_000n) = 7_120_000n。
 * 超过缩放精度的部分四舍五入。
 */
export function parseDecimal(input: string | number, scale: bigint = FX_SCALE): bigint {
  const s = String(input).trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!match) throw new Error(`非法十进制数值: ${input}`);
  const [, sign, intPart, fracRaw = ""] = match;
  const digits = scale.toString().length - 1;
  if (fracRaw.length > 15) throw new Error(`小数位过多: ${input}`);
  let fracValue: bigint;
  if (fracRaw.length <= digits) {
    fracValue = BigInt(fracRaw.padEnd(digits, "0") || "0");
  } else {
    // 超出缩放精度：按剩余首位四舍五入（head+1 等于 scale 时自然进位到整数部分）
    const head = BigInt(fracRaw.slice(0, digits) || "0");
    fracValue = head + (Number(fracRaw[digits]) >= 5 ? 1n : 0n);
  }
  const scaled = BigInt(intPart) * scale + fracValue;
  return sign === "-" ? -scaled : scaled;
}

export type FxRates = Readonly<Record<Currency, bigint>>;

/**
 * 按汇率表把 from 币种金额换算为 to 币种最小单位。
 * 汇率表以同一基准币种计价：amount_to = round(amount_from * rate_from / rate_to)。
 */
export function convert(
  amountMinor: bigint,
  from: Currency,
  to: Currency,
  rates: FxRates,
): bigint {
  if (from === to) return amountMinor;
  const rateFrom = rates[from];
  const rateTo = rates[to];
  if (rateFrom === undefined || rateTo === undefined) {
    throw new Error(`缺少汇率: ${from} -> ${to}`);
  }
  return divRound(amountMinor * rateFrom, rateTo);
}

export function sumBigint(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}
