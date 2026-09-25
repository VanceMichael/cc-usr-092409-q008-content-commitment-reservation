import assert from "node:assert/strict";
import test from "node:test";
import { harness, seedStandardScenario, standardTerms } from "./helpers.js";

const DIMS = { currency: "CNY", region: "APAC", contentType: "SERIES", period: "2026Q3" };

test("里程碑到期期间不属于池期间时拒绝，要求按期间分别申请", async () => {
  const h = harness();
  await seedStandardScenario(h);
  await assert.rejects(
    () =>
      h.svc.submitProposal({
        idempotencyKey: "req-1",
        projectId: "PRJ-A",
        pool: DIMS,
        terms: {
          currency: "CNY",
          guaranteeMinor: 1_000n,
          milestones: [{ id: "m-late", amountMinor: 500n, duePeriod: "2026Q4" }],
          contingent: { bips: 1_000, periods: ["2026Q3"] },
        },
        forecastId: "F-1",
        submittedBy: "alice",
      }),
    /请按期间分别申请/,
  );
  h.close();
});

test("新汇率版本必须覆盖在用币种，否则拒绝定义", async () => {
  const h = harness();
  await h.svc.createPool({ ...DIMS, totalMinor: 100_000n });
  await h.svc.defineFxVersion({ version: "fx-1", base: "CNY", rates: { USD: "7.14" } });
  await h.svc.activateFx("fx-1");
  await h.svc.publishForecast({
    forecastId: "F-1",
    currency: "CNY",
    assumptions: { x: 1 },
    periods: [{ period: "2026Q3", downsideMinor: 0n, baseMinor: 0n, upsideMinor: 0n }],
  });
  await h.svc.submitProposal({
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
  await assert.rejects(
    () => h.svc.defineFxVersion({ version: "fx-2", base: "CNY", rates: { EUR: "1.2" } }),
    /缺少在用币种 USD/,
  );
  // 补齐 USD 后可以定义
  await h.svc.defineFxVersion({ version: "fx-2", base: "CNY", rates: { USD: "7.30", EUR: "1.2" } });
  h.close();
});

test("延期后目标池余额不足：未签占用保留并挂风险缺口，看板可见可钻取", async () => {
  const h = harness();
  await h.svc.createPool({ ...DIMS, period: "2026Q3", totalMinor: 10_000n });
  await h.svc.createPool({ ...DIMS, period: "2026Q4", totalMinor: 2_000n });
  await h.svc.defineFxVersion({ version: "fx-1", base: "CNY", rates: {} });
  await h.svc.activateFx("fx-1");
  await h.svc.publishForecast({
    forecastId: "F-1",
    currency: "CNY",
    assumptions: { x: 1 },
    periods: [
      { period: "2026Q3", downsideMinor: 40_000n, baseMinor: 50_000n, upsideMinor: 60_000n },
      { period: "2026Q4", downsideMinor: 44_000n, baseMinor: 56_000n, upsideMinor: 70_000n },
    ],
  });
  // 延期到 Q4 后 base = 1000+500+10%*56_000 = 7_100，Q4 池仅 2_000
  const res = await h.svc.submitProposal({
    idempotencyKey: "req-1",
    projectId: "PRJ-A",
    pool: { ...DIMS, period: "2026Q3" },
    terms: standardTerms({ periods: ["2026Q3"] }),
    forecastId: "F-1",
    submittedBy: "alice",
  });
  await h.svc.delayProject("PRJ-A", 1);
  await h.runDue();

  const q4 = h.svc.listPools().find((p) => p.dims.period === "2026Q4")!;
  assert.equal(q4.heldMinor, 7_100n);
  assert.equal(q4.availableMinor, 2_000n - 7_100n);
  assert.ok(q4.riskGapMinor >= 5_100n);
  const hold = q4.holds[0];
  assert.ok(hold.flags.includes("INSUFFICIENT_BUDGET"));
  assert.ok(hold.flags.includes("PROJECT_DELAY"));
  assert.equal(hold.shortfallMinor, 5_100n);

  // 从风险数字钻取：占用 → 方案版本 → 预测依据
  const history = h.svc.proposalHistory(res.proposalId);
  const moved = history.versions.at(-1)!;
  assert.equal(moved.dims.period, "2026Q4");
  assert.equal(moved.forecast.forecastId, "F-1");
  assert.equal(moved.range.baseMinor, 7_100n);

  // 三场景对比：Q4 在各档的占用与缺口
  const comparison = h.svc.scenarioComparison().find((c) => c.base.dims.period === "2026Q4")!;
  assert.equal(comparison.base.heldMinor, 7_100n);
  assert.equal(comparison.base.riskGapMinor, 5_100n);
  assert.equal(comparison.downside.heldMinor, 5_900n); // 1500 + 10%*44_000
  assert.equal(comparison.upside.heldMinor, 8_500n); // 1500 + 10%*70_000
  h.close();
});

test("不同申请键提交同一内容形成两个独立占用（无幂等串用）", async () => {
  const h = harness();
  const { poolKey } = await seedStandardScenario(h, 20_000n);
  const args = {
    projectId: "PRJ-A",
    pool: DIMS,
    terms: standardTerms(),
    forecastId: "F-1",
    submittedBy: "alice",
  };
  const a = await h.svc.submitProposal({ ...args, idempotencyKey: "req-a" });
  const b = await h.svc.submitProposal({ ...args, idempotencyKey: "req-b" });
  assert.notEqual(a.occupancyId, b.occupancyId);
  assert.equal(h.svc.poolView(poolKey, "base").heldMinor, 13_000n);
  h.close();
});

test("驳回释放容量且方案不可重复审批", async () => {
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
  await h.svc.reject(res.proposalId, "条款不合规");
  assert.equal(h.svc.poolView(poolKey, "base").heldMinor, 0n);
  assert.equal(h.svc.proposalHistory(res.proposalId).proposal.status, "REJECTED");
  await assert.rejects(() => h.svc.approve(res.proposalId, "carol"));
  h.close();
});

test("预算池不能创建重复维度", async () => {
  const h = harness();
  await seedStandardScenario(h);
  await assert.rejects(() =>
    h.svc.createPool({ ...DIMS, totalMinor: 1n }),
  );
  h.close();
});

test("重评缺口必须凭足额豁免才能批准，批准后看板风险清零", async () => {
  const h = harness();
  await h.svc.createPool({ ...DIMS, period: "2026Q3", totalMinor: 10_000n });
  await h.svc.createPool({ ...DIMS, period: "2026Q4", totalMinor: 2_000n });
  await h.svc.defineFxVersion({ version: "fx-1", base: "CNY", rates: {} });
  await h.svc.activateFx("fx-1");
  await h.svc.publishForecast({
    forecastId: "F-1",
    currency: "CNY",
    assumptions: { x: 1 },
    periods: [
      { period: "2026Q3", downsideMinor: 40_000n, baseMinor: 50_000n, upsideMinor: 60_000n },
      { period: "2026Q4", downsideMinor: 44_000n, baseMinor: 56_000n, upsideMinor: 70_000n },
    ],
  });
  const res = await h.svc.submitProposal({
    idempotencyKey: "req-1",
    projectId: "PRJ-A",
    pool: { ...DIMS, period: "2026Q3" },
    terms: standardTerms({ periods: ["2026Q3"] }),
    forecastId: "F-1",
    submittedBy: "alice",
  });
  await h.svc.delayProject("PRJ-A", 1);
  await h.runDue();

  // 无豁免批准被拒
  await assert.rejects(() => h.svc.approve(res.proposalId, "carol"), /风险缺口/);

  const q4 = h.svc.listPools().find((p) => p.dims.period === "2026Q4")!;
  const { waiverId } = await h.svc.grantWaiver({
    grantedBy: "cfo",
    reason: "战略项目延期破例",
    amountMinor: 5_100n,
    poolKey: q4.poolKey,
  });
  await h.svc.approve(res.proposalId, "carol", waiverId);
  await h.svc.sign(res.proposalId);

  const after = h.svc.poolView(q4.poolKey, "base");
  assert.equal(after.riskGapMinor, 0n);
  assert.equal(after.signedMinor, 7_100n);
  assert.equal(after.waivedHeadroomMinor, 0n); // 5100 全额动用
  const history = h.svc.proposalHistory(res.proposalId);
  assert.ok(history.waivers.some((w) => w.waiverId === waiverId));
  assert.equal(history.signedSnapshot!.approverId, "carol");
  h.close();
});

test("缺口提案去重：同一触发重复执行不产生重复缺口", async () => {
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
  await h.svc.publishForecast({
    forecastId: "F-1",
    currency: "CNY",
    assumptions: { ad_growth: 0.3 },
    periods: [
      { period: "2026Q3", downsideMinor: 60_000n, baseMinor: 80_000n, upsideMinor: 100_000n },
      { period: "2026Q4", downsideMinor: 70_000n, baseMinor: 90_000n, upsideMinor: 110_000n },
    ],
  });
  await h.runDue();
  // 再次发布 v3（基于 v2 也会对已签合同再评估一次）
  await h.svc.publishForecast({
    forecastId: "F-1",
    currency: "CNY",
    assumptions: { ad_growth: 0.35 },
    periods: [
      { period: "2026Q3", downsideMinor: 62_000n, baseMinor: 82_000n, upsideMinor: 105_000n },
      { period: "2026Q4", downsideMinor: 72_000n, baseMinor: 92_000n, upsideMinor: 115_000n },
    ],
  });
  await h.runDue();
  // 每次替代各产生至多一个缺口，共 2 个
  const gaps = h.svc.listGaps("OPEN");
  assert.equal(gaps.length, 2);
  for (const g of gaps) assert.equal(g.proposalId, res.proposalId);
  h.close();
});
