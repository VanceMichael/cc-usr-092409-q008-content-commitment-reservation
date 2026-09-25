import assert from "node:assert/strict";
import test from "node:test";
import { convert, FX_SCALE, parseDecimal, divRound } from "../src/domain/money.js";
import { periodCompare, shiftPeriod } from "../src/domain/period.js";
import { buildForecast, computeStressRange } from "../src/domain/stress.js";

test("parseDecimal 按缩放比例解析并四舍五入", () => {
  assert.equal(parseDecimal("7.14", FX_SCALE), 7_140_000n);
  assert.equal(parseDecimal("7", FX_SCALE), 7_000_000n);
  assert.equal(parseDecimal("0.0000007", FX_SCALE), 1n); // 0.7 微单位四舍五入
  assert.equal(parseDecimal("0.0000004", FX_SCALE), 0n);
  assert.throws(() => parseDecimal("abc", FX_SCALE));
});

test("divRound 四舍五入", () => {
  assert.equal(divRound(5n, 2n), 3n);
  assert.equal(divRound(4n, 2n), 2n);
  assert.equal(divRound(1n, 3n), 0n);
  assert.equal(divRound(2n, 3n), 1n);
});

test("多币种换算：USD 金额按汇率折为 CNY", () => {
  // 内部约定 rate[CCY] = 每 1 单位 CCY 兑基准币种的数量 × 1e6：
  // rate[USD]=7_140_000 表示 1 USD = 7.14 CNY。
  const rates = { CNY: FX_SCALE, USD: 7_140_000n };
  assert.equal(convert(1_000n, "USD", "CNY", rates), 7_140n);
  // 反向换算四舍五入
  assert.equal(convert(7_140n, "CNY", "USD", rates), 1_000n);
  assert.equal(convert(5n, "USD", "CNY", rates), 36n); // 35.7 -> 36
  assert.throws(() => convert(1n, "EUR", "CNY", rates));
});

test("期间比较与延期平移", () => {
  assert.equal(periodCompare("2026Q1", "2026Q4"), -1);
  assert.equal(periodCompare("2026Q4", "2027Q1"), -1);
  assert.equal(shiftPeriod("2026Q4", 1), "2027Q1");
  assert.equal(shiftPeriod("2026Q1", 5), "2027Q2");
  assert.equal(shiftPeriod("2026-11", 3), "2027-02");
  assert.throws(() => periodCompare("2026Q1", "2026-01"));
});

test("压力区间：保底+里程碑+或有分成在三档预测下计算", () => {
  const forecast = buildForecast({
    forecastId: "F",
    version: 1,
    supersedesVersion: null,
    currency: "CNY",
    assumptions: { x: 1 },
    periods: [
      { period: "2026Q3", downsideMinor: 40_000n, baseMinor: 50_000n, upsideMinor: 60_000n },
    ],
    publishedAt: 0,
  });
  const range = computeStressRange({
    terms: {
      currency: "CNY",
      guaranteeMinor: 1_000n,
      milestones: [{ id: "m1", amountMinor: 500n, duePeriod: "2026Q3" }],
      contingent: { bips: 1_000, periods: ["2026Q3"] }, // 10%
    },
    forecast,
    rates: { CNY: FX_SCALE },
    fxVersion: "fx-1",
    poolCurrency: "CNY",
    poolPeriod: "2026Q3",
  });
  assert.equal(range.guaranteeMinor, 1_000n);
  assert.equal(range.milestonesMinor, 500n);
  assert.equal(range.contingentDownsideMinor, 4_000n);
  assert.equal(range.contingentBaseMinor, 5_000n);
  assert.equal(range.contingentUpsideMinor, 6_000n);
  assert.equal(range.downsideMinor, 5_500n);
  assert.equal(range.baseMinor, 6_500n);
  assert.equal(range.upsideMinor, 7_500n);
});

test("压力区间跨币种：USD 条款 + CNY 预测在 CNY 池中合并", () => {
  const forecast = buildForecast({
    forecastId: "F",
    version: 1,
    supersedesVersion: null,
    currency: "CNY",
    assumptions: {},
    periods: [
      { period: "2026Q3", downsideMinor: 71_400n, baseMinor: 71_400n, upsideMinor: 71_400n },
    ],
    publishedAt: 0,
  });
  const range = computeStressRange({
    terms: {
      currency: "USD",
      guaranteeMinor: 1_000n,
      milestones: [],
      contingent: { bips: 0, periods: [] },
    },
    forecast,
    rates: { CNY: FX_SCALE, USD: 7_140_000n },
    fxVersion: "fx-1",
    poolCurrency: "CNY",
    poolPeriod: "2026Q3",
  });
  assert.equal(range.guaranteeMinor, 7_140n);
});
