import assert from "node:assert/strict";
import test from "node:test";
import { BudgetExhaustedError } from "../src/service/procurement-service.js";
import { harness, seedStandardScenario, standardTerms } from "./helpers.js";

test("申请创建有期限占用，并计算三档压力区间", async () => {
  const h = harness();
  const { poolKey } = await seedStandardScenario(h);

  const res = await h.svc.submitProposal({
    idempotencyKey: "req-1",
    projectId: "PRJ-A",
    pool: { currency: "CNY", region: "APAC", contentType: "SERIES", period: "2026Q3" },
    terms: standardTerms(),
    forecastId: "F-1",
    submittedBy: "alice",
    ttlMs: 60_000,
  });

  assert.equal(res.reused, false);
  assert.equal(res.range.baseMinor, 6_500n); // 1000 + 500 + 5000
  assert.equal(res.range.downsideMinor, 5_500n);
  assert.equal(res.range.upsideMinor, 7_500n);

  const view = h.svc.poolView(poolKey, "base");
  assert.equal(view.totalMinor, 10_000n);
  assert.equal(view.signedMinor, 0n);
  assert.equal(view.heldMinor, 6_500n);
  assert.equal(view.availableMinor, 3_500n);
  assert.equal(view.holds[0].occupancyId, res.occupancyId);
  h.close();
});

test("相同申请重试沿用原占用（幂等），不重复扣减容量", async () => {
  const h = harness();
  const { poolKey } = await seedStandardScenario(h);
  const input = {
    idempotencyKey: "req-1",
    projectId: "PRJ-A",
    pool: { currency: "CNY", region: "APAC", contentType: "SERIES", period: "2026Q3" },
    terms: standardTerms(),
    forecastId: "F-1",
    submittedBy: "alice",
  };
  const first = await h.svc.submitProposal(input);
  const second = await h.svc.submitProposal({ ...input, submittedBy: "alice", ttlMs: 12345 });
  assert.equal(second.reused, true);
  assert.equal(second.occupancyId, first.occupancyId);
  assert.equal(second.proposalId, first.proposalId);

  const view = h.svc.poolView(poolKey, "base");
  assert.equal(view.heldMinor, 6_500n);
  h.close();
});

test("金额或条款变化形成新版本，旧版本容量经补偿事件释放", async () => {
  const h = harness();
  const { poolKey } = await seedStandardScenario(h);
  const baseInput = {
    idempotencyKey: "req-1",
    projectId: "PRJ-A",
    pool: { currency: "CNY", region: "APAC", contentType: "SERIES", period: "2026Q3" },
    forecastId: "F-1",
    submittedBy: "alice",
  };
  const v1 = await h.svc.submitProposal({ ...baseInput, terms: standardTerms({ guaranteeMinor: 1_000n }) });
  assert.equal(v1.version, 1);

  const v2 = await h.svc.submitProposal({
    ...baseInput,
    terms: standardTerms({ guaranteeMinor: 2_000n }),
  });
  assert.equal(v2.reused, false);
  assert.equal(v2.version, 2);
  assert.equal(v2.occupancyId, v1.occupancyId); // 同一占用链
  assert.equal(v2.range.baseMinor, 7_500n);

  // 已被替代的 v1 请求再次到达：不复活旧版本
  await assert.rejects(
    () => h.svc.submitProposal({ ...baseInput, terms: standardTerms({ guaranteeMinor: 1_000n }) }),
    /已终结|新版本替代|新版本/,
  );

  const history = h.svc.proposalHistory(v1.proposalId);
  assert.equal(history.versions.length, 2);
  assert.equal(history.versions[0].status, "RELEASED");
  assert.equal(history.versions[1].status, "HELD");

  const view = h.svc.poolView(poolKey, "base");
  assert.equal(view.heldMinor, 7_500n); // 只有当前版本占用
  h.close();
});

test("两个项目并发争用余额时只能一个成功", async () => {
  const h = harness();
  await seedStandardScenario(h, 7_000n);
  const dims = { currency: "CNY", region: "APAC", contentType: "SERIES", period: "2026Q3" };
  // 每个 base 档 6_500，池 7_000：第一个成功后仅剩 500，第二个必败
  const results = await Promise.allSettled([
    h.svc.submitProposal({
      idempotencyKey: "req-a",
      projectId: "PRJ-A",
      pool: dims,
      terms: standardTerms(),
      forecastId: "F-1",
      submittedBy: "alice",
    }),
    h.svc.submitProposal({
      idempotencyKey: "req-b",
      projectId: "PRJ-B",
      pool: dims,
      terms: standardTerms(),
      forecastId: "F-1",
      submittedBy: "bob",
    }),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  const reason = (rejected[0] as PromiseRejectedResult).reason;
  assert.ok(reason instanceof BudgetExhaustedError);
  assert.equal((reason as BudgetExhaustedError).shortfallMinor, 6_000n);
  h.close();
});

test("审批人不能批准自己提交的方案", async () => {
  const h = harness();
  await seedStandardScenario(h);
  const dims = { currency: "CNY", region: "APAC", contentType: "SERIES", period: "2026Q3" };
  const res = await h.svc.submitProposal({
    idempotencyKey: "req-1",
    projectId: "PRJ-A",
    pool: dims,
    terms: standardTerms(),
    forecastId: "F-1",
    submittedBy: "alice",
  });
  await assert.rejects(
    () => h.svc.approve(res.proposalId, "alice"),
    /职责分离/,
  );
  // 另一人可批准
  await h.svc.approve(res.proposalId, "carol");
  await h.svc.sign(res.proposalId);
  h.close();
});

test("占用到期自动释放（补偿事件），方案转为 EXPIRED", async () => {
  const h = harness();
  const { poolKey } = await seedStandardScenario(h);
  const dims = { currency: "CNY", region: "APAC", contentType: "SERIES", period: "2026Q3" };
  const res = await h.svc.submitProposal({
    idempotencyKey: "req-1",
    projectId: "PRJ-A",
    pool: dims,
    terms: standardTerms(),
    forecastId: "F-1",
    submittedBy: "alice",
    ttlMs: 60_000,
  });
  h.tick(59_999);
  await h.runDue();
  assert.equal(h.svc.poolView(poolKey, "base").heldMinor, 6_500n);
  h.tick(2);
  await h.runDue();
  const view = h.svc.poolView(poolKey, "base");
  assert.equal(view.heldMinor, 0n);
  assert.equal(view.availableMinor, 10_000n);
  const history = h.svc.proposalHistory(res.proposalId);
  assert.equal(history.proposal.status, "EXPIRED");
  h.close();
});

test("取消通过补偿事件释放容量", async () => {
  const h = harness();
  const { poolKey } = await seedStandardScenario(h);
  const dims = { currency: "CNY", region: "APAC", contentType: "SERIES", period: "2026Q3" };
  const res = await h.svc.submitProposal({
    idempotencyKey: "req-1",
    projectId: "PRJ-A",
    pool: dims,
    terms: standardTerms(),
    forecastId: "F-1",
    submittedBy: "alice",
  });
  await h.svc.cancel(res.proposalId, "谈判破裂");
  assert.equal(h.svc.poolView(poolKey, "base").heldMinor, 0n);
  assert.equal(h.svc.proposalHistory(res.proposalId).proposal.status, "CANCELLED");
  // 取消后原申请键不可复用
  await assert.rejects(() =>
    h.svc.submitProposal({
      idempotencyKey: "req-1",
      projectId: "PRJ-A",
      pool: dims,
      terms: standardTerms(),
      forecastId: "F-1",
      submittedBy: "alice",
    }),
  );
  h.close();
});

test("池级人工豁免允许超余额申请，看板可追溯豁免", async () => {
  const h = harness();
  const { poolKey } = await seedStandardScenario(h, 6_000n);
  const dims = { currency: "CNY", region: "APAC", contentType: "SERIES", period: "2026Q3" };
  const { waiverId } = await h.svc.grantWaiver({
    grantedBy: "cfo",
    reason: "战略内容破例",
    amountMinor: 1_000n,
    poolKey,
  });
  const res = await h.svc.submitProposal({
    idempotencyKey: "req-1",
    projectId: "PRJ-A",
    pool: dims,
    terms: standardTerms(), // base 6_500 > 6_000
    forecastId: "F-1",
    submittedBy: "alice",
    waiverIds: [waiverId],
  });
  assert.ok(res.flags.includes("COVERED_BY_POOL_WAIVER"));
  const view = h.svc.poolView(poolKey, "base");
  assert.equal(view.heldMinor, 6_500n);
  assert.equal(view.availableMinor, -500n);
  assert.equal(view.waivedHeadroomMinor, 500n); // 1000 授予，500 已消耗
  const history = h.svc.proposalHistory(res.proposalId);
  assert.deepEqual(history.waivers.map((w) => w.waiverId), [waiverId]);
  h.close();
});

test("豁免额度不足时申请仍然失败且不占用", async () => {
  const h = harness();
  const { poolKey } = await seedStandardScenario(h, 6_000n);
  const dims = { currency: "CNY", region: "APAC", contentType: "SERIES", period: "2026Q3" };
  const { waiverId } = await h.svc.grantWaiver({
    grantedBy: "cfo",
    reason: "小额破例",
    amountMinor: 100n,
    poolKey,
  });
  await assert.rejects(() =>
    h.svc.submitProposal({
      idempotencyKey: "req-1",
      projectId: "PRJ-A",
      pool: dims,
      terms: standardTerms(),
      forecastId: "F-1",
      submittedBy: "alice",
      waiverIds: [waiverId],
    }),
  );
  // 失败的申请不消耗豁免、不占用
  const view = h.svc.poolView(poolKey, "base");
  assert.equal(view.heldMinor, 0n);
  assert.equal(view.waivedHeadroomMinor, 100n);
  h.close();
});
