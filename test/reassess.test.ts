import assert from "node:assert/strict";
import test from "node:test";
import { fileHarness, harness, seedStandardScenario, standardTerms } from "./helpers.js";

const DIMS = { currency: "CNY", region: "APAC", contentType: "SERIES", period: "2026Q3" };

test("预测被替代：未签占用自动重评压力区间", async () => {
  const h = harness();
  const { poolKey } = await seedStandardScenario(h);
  const res = await h.svc.submitProposal({
    idempotencyKey: "req-1",
    projectId: "PRJ-A",
    pool: DIMS,
    terms: standardTerms(),
    forecastId: "F-1",
    submittedBy: "alice",
  });
  // 场景下调：Q3 base 50_000 -> 30_000
  await h.svc.publishForecast({
    forecastId: "F-1",
    currency: "CNY",
    assumptions: { ad_growth: 0.01, churn: 0.05 },
    periods: [
      { period: "2026Q3", downsideMinor: 20_000n, baseMinor: 30_000n, upsideMinor: 36_000n },
      { period: "2026Q4", downsideMinor: 22_000n, baseMinor: 33_000n, upsideMinor: 40_000n },
    ],
  });
  await h.runDue();

  const history = h.svc.proposalHistory(res.proposalId);
  const current = history.versions.at(-1)!;
  // 1000 + 500 + 10%*30_000 = 4_500
  assert.equal(current.range.baseMinor, 4_500n);
  assert.equal(current.forecast.version, 2);
  const view = h.svc.poolView(poolKey, "base");
  assert.equal(view.heldMinor, 4_500n);
  assert.equal(view.availableMinor, 5_500n);
  h.close();
});

test("预测被替代：已签合同保留签署快照并生成缺口处置提案，不倒改历史", async () => {
  const h = harness();
  await seedStandardScenario(h);
  const res = await h.svc.submitProposal({
    idempotencyKey: "req-1",
    projectId: "PRJ-A",
    pool: DIMS,
    terms: standardTerms(),
    forecastId: "F-1",
    submittedBy: "alice",
  });
  await h.svc.approve(res.proposalId, "carol");
  await h.svc.sign(res.proposalId);

  // 场景上调：Q3 base 50_000 -> 80_000
  await h.svc.publishForecast({
    forecastId: "F-1",
    currency: "CNY",
    assumptions: { ad_growth: 0.2, churn: 0.02 },
    periods: [
      { period: "2026Q3", downsideMinor: 60_000n, baseMinor: 80_000n, upsideMinor: 100_000n },
      { period: "2026Q4", downsideMinor: 66_000n, baseMinor: 90_000n, upsideMinor: 110_000n },
    ],
  });
  await h.runDue();

  const history = h.svc.proposalHistory(res.proposalId);
  // 签署快照保持 v1 预测与原口径
  assert.equal(history.signedSnapshot!.forecast.version, 1);
  assert.equal(history.signedSnapshot!.range.baseMinor, 6_500n);
  assert.equal(history.signedSnapshot!.forecast.assumptions.ad_growth, 0.08);

  const gaps = h.svc.listGaps("OPEN");
  assert.equal(gaps.length, 1);
  const gap = gaps[0];
  assert.equal(gap.reason, "FORECAST_REPLACED");
  // 10%*(80_000-50_000)=3_000
  assert.equal(gap.gap.baseMinor, 3_000n);
  assert.equal(gap.snapshot.baseMinor, 6_500n);
  assert.equal(gap.projected.baseMinor, 9_500n);

  // 处置：人工豁免
  const { waiverId } = await h.svc.grantWaiver({
    grantedBy: "cfo",
    reason: "上调场景确认可承接",
    gapId: gap.gapId,
  });
  await h.svc.resolveGap(gap.gapId, "WAIVED", "按 CFO 意见豁免", waiverId);
  assert.equal(h.svc.listGaps("OPEN").length, 0);
  const resolved = h.svc.proposalHistory(res.proposalId).gaps[0];
  assert.equal(resolved.status, "WAIVED");
  assert.equal(resolved.waiverId, waiverId);
  h.close();
});

test("汇率版本变化：未签占用按新汇率重算，已签合同出缺口", async () => {
  const h = harness();
  await h.svc.createPool({ ...DIMS, totalMinor: 100_000n });
  await h.svc.defineFxVersion({ version: "fx-1", base: "CNY", rates: { USD: "7.14" } });
  await h.svc.activateFx("fx-1");
  await h.svc.publishForecast({
    forecastId: "F-1",
    currency: "CNY",
    assumptions: { x: 1 },
    periods: [
      { period: "2026Q3", downsideMinor: 0n, baseMinor: 0n, upsideMinor: 0n },
    ],
  });
  const submitted = await h.svc.submitProposal({
    idempotencyKey: "req-1",
    projectId: "PRJ-A",
    pool: DIMS,
    terms: {
      currency: "USD",
      guaranteeMinor: 1_000n,
      milestones: [],
      contingent: { bips: 0, periods: [] },
    },
    forecastId: "F-1",
    submittedBy: "alice",
  });
  assert.equal(submitted.range.baseMinor, 7_140n);
  await h.svc.approve(submitted.proposalId, "carol");
  await h.svc.sign(submitted.proposalId);

  // 第二个未签 USD 方案
  const second = await h.svc.submitProposal({
    idempotencyKey: "req-2",
    projectId: "PRJ-B",
    pool: DIMS,
    terms: {
      currency: "USD",
      guaranteeMinor: 1_000n,
      milestones: [],
      contingent: { bips: 0, periods: [] },
    },
    forecastId: "F-1",
    submittedBy: "bob",
  });

  await h.svc.defineFxVersion({ version: "fx-2", base: "CNY", rates: { USD: "8.00" } });
  await h.svc.activateFx("fx-2");
  await h.runDue();

  const unsigned = h.svc.proposalHistory(second.proposalId).versions.at(-1)!;
  assert.equal(unsigned.range.baseMinor, 8_000n);
  assert.equal(unsigned.fxVersion, "fx-2");

  const gaps = h.svc.listGaps("OPEN");
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].reason, "FX_CHANGED");
  assert.equal(gaps[0].gap.baseMinor, 860n); // (8.00-7.14)*1000

  // 已签快照汇率不变
  const signedHistory = h.svc.proposalHistory(submitted.proposalId);
  assert.equal(signedHistory.signedSnapshot!.fx.version, "fx-1");
  assert.equal(signedHistory.signedSnapshot!.range.baseMinor, 7_140n);
  h.close();
});

test("项目延期：未签占用平移到下一期间池，已签合同生成缺口提案", async () => {
  const h = harness();
  const { poolKey: q3 } = await seedStandardScenario(h, 10_000n, "2026Q3");
  const { poolKey: q4 } = await h.svc.createPool({
    ...DIMS,
    period: "2026Q4",
    totalMinor: 10_000n,
  });

  // 未签方案
  const unsigned = await h.svc.submitProposal({
    idempotencyKey: "req-1",
    projectId: "PRJ-A",
    pool: { ...DIMS, period: "2026Q3" },
    terms: standardTerms({ periods: ["2026Q3"] }),
    forecastId: "F-1",
    submittedBy: "alice",
  });
  await h.svc.approve(unsigned.proposalId, "carol");
  await h.svc.sign(unsigned.proposalId);

  // 已签在 Q3；再起一个未签方案
  const open = await h.svc.submitProposal({
    idempotencyKey: "req-2",
    projectId: "PRJ-A",
    pool: { ...DIMS, period: "2026Q3" },
    terms: standardTerms({ guaranteeMinor: 200n, bips: 500, periods: ["2026Q3"] }),
    forecastId: "F-1",
    submittedBy: "dave",
  });
  // base = 200 + 500 + 5%*50_000 = 3_200
  assert.equal(open.range.baseMinor, 3_200n);
  assert.equal(h.svc.poolView(q3, "base").heldMinor, 3_200n);

  await h.svc.delayProject("PRJ-A", 1);
  await h.runDue();

  // 未签占用从 Q3 释放、转入 Q4：base = 200+500+5%*56_000 = 3_500
  assert.equal(h.svc.poolView(q3, "base").heldMinor, 0n);
  const q4view = h.svc.poolView(q4, "base");
  assert.equal(q4view.heldMinor, 3_500n);
  const moved = h.svc.proposalHistory(open.proposalId).versions.at(-1)!;
  assert.equal(moved.dims.period, "2026Q4");
  assert.ok(moved.flags.includes("PROJECT_DELAY"));

  // 已签合同未搬迁，产生延期缺口（Q4 池完全空闲，容量足够 → 无缺口）
  // Q4 可用 = 10_000-3_500 = 6_500，已签 base 6_500 恰好放下
  assert.equal(h.svc.listGaps("OPEN").length, 0);

  // 再来一个把 Q4 填满的延期：让 Q4 余额不足
  const h3 = harness();
  await h3.svc.createPool({ ...DIMS, period: "2026Q3", totalMinor: 10_000n });
  await h3.svc.createPool({ ...DIMS, period: "2026Q4", totalMinor: 5_000n });
  await h3.svc.defineFxVersion({ version: "fx-1", rates: {}, base: "CNY" });
  await h3.svc.activateFx("fx-1");
  await h3.svc.publishForecast({
    forecastId: "F-1",
    currency: "CNY",
    assumptions: { x: 1 },
    periods: [
      { period: "2026Q3", downsideMinor: 40_000n, baseMinor: 50_000n, upsideMinor: 60_000n },
      { period: "2026Q4", downsideMinor: 44_000n, baseMinor: 56_000n, upsideMinor: 70_000n },
    ],
  });
  const signed = await h3.svc.submitProposal({
    idempotencyKey: "req-1",
    projectId: "PRJ-A",
    pool: { ...DIMS, period: "2026Q3" },
    terms: standardTerms(),
    forecastId: "F-1",
    submittedBy: "alice",
  });
  await h3.svc.approve(signed.proposalId, "carol");
  await h3.svc.sign(signed.proposalId);
  await h3.svc.delayProject("PRJ-A", 1);
  await h3.runDue();
  const gaps2 = h3.svc.listGaps("OPEN");
  assert.equal(gaps2.length, 1);
  assert.equal(gaps2[0].reason, "PROJECT_DELAY");
  assert.ok(gaps2[0].targetPoolKey); // 指向 Q4 池
  // Q4 池 5_000，合同 base 6_500，缺口 1_500
  assert.equal(gaps2[0].gap.baseMinor, 1_500n);
  h3.close();
});

test("预算池版本化：新版本总额立即生效，签署快照保留旧版本金额", async () => {
  const h = harness();
  const { poolKey } = await seedStandardScenario(h, 10_000n);
  const res = await h.svc.submitProposal({
    idempotencyKey: "req-1",
    projectId: "PRJ-A",
    pool: DIMS,
    terms: standardTerms(),
    forecastId: "F-1",
    submittedBy: "alice",
  });
  await h.svc.approve(res.proposalId, "carol");
  await h.svc.sign(res.proposalId);
  await h.svc.publishPoolVersion(poolKey, 8_000n);
  const history = h.svc.proposalHistory(res.proposalId);
  assert.equal(history.signedSnapshot!.pool.poolVersion, 1);
  assert.equal(history.signedSnapshot!.pool.totalMinor, 10_000n);
  const view = h.svc.poolView(poolKey, "base");
  assert.equal(view.poolVersion, 2);
  assert.equal(view.totalMinor, 8_000n);
  h.close();
});

test("合同终止通过补偿事件释放已签容量，快照仍可追溯", async () => {
  const h = harness();
  const { poolKey } = await seedStandardScenario(h);
  const res = await h.svc.submitProposal({
    idempotencyKey: "req-1",
    projectId: "PRJ-A",
    pool: DIMS,
    terms: standardTerms(),
    forecastId: "F-1",
    submittedBy: "alice",
  });
  await h.svc.approve(res.proposalId, "carol");
  await h.svc.sign(res.proposalId);
  assert.equal(h.svc.poolView(poolKey, "base").signedMinor, 6_500n);
  await h.svc.terminateContract(res.proposalId, "内容未交付");
  const view = h.svc.poolView(poolKey, "base");
  assert.equal(view.signedMinor, 0n);
  assert.equal(view.availableMinor, 10_000n);
  const history = h.svc.proposalHistory(res.proposalId);
  assert.equal(history.proposal.status, "TERMINATED");
  assert.ok(history.signedSnapshot); // 快照保留
  h.close();
});

test("服务重启后继续到期释放与重评任务", async () => {
  const h = fileHarness(1_000_000, false);
  const dims = { currency: "CNY", region: "APAC", contentType: "SERIES", period: "2026Q3" };
  await h.svc.createPool({ ...dims, totalMinor: 10_000n });
  await h.svc.defineFxVersion({ version: "fx-1", rates: {}, base: "CNY" });
  await h.svc.activateFx("fx-1");
  await h.svc.publishForecast({
    forecastId: "F-1",
    currency: "CNY",
    assumptions: { x: 1 },
    periods: [
      { period: "2026Q3", downsideMinor: 40_000n, baseMinor: 50_000n, upsideMinor: 60_000n },
    ],
  });
  const res = await h.svc.submitProposal({
    idempotencyKey: "req-1",
    projectId: "PRJ-A",
    pool: dims,
    terms: standardTerms(),
    forecastId: "F-1",
    submittedBy: "alice",
    ttlMs: 60_000,
  });
  const poolKey = h.svc.listPools()[0].poolKey;

  // 推进时间越过到期点但不运行任务，随后“重启”为自动调度实例
  h.tick(60_001);
  const next = h.restart(true);
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(next.svc.poolView(poolKey, "base").heldMinor, 0n);
  assert.equal(next.svc.proposalHistory(res.proposalId).proposal.status, "EXPIRED");

  next.svc.stop();
  next.store.close();
  h.close();
});

test("服务重启后继续执行重评：重启期间发布的下调场景在恢复后生效", async () => {
  const h = fileHarness(1_000_000, false);
  const dims = { currency: "CNY", region: "APAC", contentType: "SERIES", period: "2026Q3" };
  await h.svc.createPool({ ...dims, totalMinor: 10_000n });
  await h.svc.defineFxVersion({ version: "fx-1", rates: {}, base: "CNY" });
  await h.svc.activateFx("fx-1");
  await h.svc.publishForecast({
    forecastId: "F-1",
    currency: "CNY",
    assumptions: { x: 1 },
    periods: [
      { period: "2026Q3", downsideMinor: 40_000n, baseMinor: 50_000n, upsideMinor: 60_000n },
    ],
  });
  const res = await h.svc.submitProposal({
    idempotencyKey: "req-1",
    projectId: "PRJ-A",
    pool: dims,
    terms: standardTerms(),
    forecastId: "F-1",
    submittedBy: "alice",
  });
  // 发布下调预测，重启前不执行任务
  await h.svc.publishForecast({
    forecastId: "F-1",
    currency: "CNY",
    assumptions: { x: 2 },
    periods: [
      { period: "2026Q3", downsideMinor: 20_000n, baseMinor: 30_000n, upsideMinor: 36_000n },
    ],
  });
  const next = h.restart(true);
  await new Promise((r) => setTimeout(r, 50));
  const current = next.svc.proposalHistory(res.proposalId).versions.at(-1)!;
  assert.equal(current.forecast.version, 2);
  assert.equal(current.range.baseMinor, 4_500n); // 1000+500+10%*30_000
  next.svc.stop();
  next.store.close();
  h.close();
});
