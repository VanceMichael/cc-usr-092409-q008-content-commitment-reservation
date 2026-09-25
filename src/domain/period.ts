/**
 * 期间支持两种词法可排序格式：季度 "YYYYQn"（2026Q3）与月份 "YYYY-MM"（2026-09）。
 * 同一池内的期间必须同族；延期在同族内平移。
 */

const QUARTER = /^(\d{4})Q([1-4])$/;
const MONTH = /^(\d{4})-(\d{2})$/;

export function periodKind(period: string): "quarter" | "month" {
  if (QUARTER.test(period)) return "quarter";
  if (MONTH.test(period)) return "month";
  throw new Error(`非法期间格式: ${period}`);
}

export function periodCompare(a: string, b: string): number {
  const ka = periodKind(a);
  const kb = periodKind(b);
  if (ka !== kb) throw new Error(`期间族不一致: ${a} vs ${b}`);
  if (ka === "quarter") {
    const [, ya, qa] = QUARTER.exec(a)!;
    const [, yb, qb] = QUARTER.exec(b)!;
    const ia = Number(ya) * 4 + Number(qa);
    const ib = Number(yb) * 4 + Number(qb);
    return Math.sign(ia - ib);
  }
  const [, ya, ma] = MONTH.exec(a)!;
  const [, yb, mb] = MONTH.exec(b)!;
  const ia = Number(ya) * 12 + Number(ma);
  const ib = Number(yb) * 12 + Number(mb);
  return Math.sign(ia - ib);
}

/** 将期间向后平移 n 个季度/月（延期 n 为正）。 */
export function shiftPeriod(period: string, n: number): string {
  if (n === 0) return period;
  const kind = periodKind(period);
  if (kind === "quarter") {
    const [, y, q] = QUARTER.exec(period)!;
    const total = Number(y) * 4 + (Number(q) - 1) + n;
    return `${Math.floor(total / 4)}Q${(total % 4) + 1}`;
  }
  const [, y, m] = MONTH.exec(period)!;
  const total = Number(y) * 12 + (Number(m) - 1) + n;
  return `${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export function minPeriod(a: string, b: string): string {
  return periodCompare(a, b) <= 0 ? a : b;
}

export function maxPeriod(a: string, b: string): string {
  return periodCompare(a, b) >= 0 ? a : b;
}
