/**
 * 领域级端到端测试：版本化预算池 / 预测占用 / 压力区间 /
 * 并发争用 / 自审禁止 / 重评与快照不可倒改 / 补偿释放 / 重启恢复 / 分析血缘。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DealTerms, ForecastAssumptions } from "../src/domain/model.js";
import { createRuntime, type RuntimeHandle } from "../src/runtime.js";

const silent = { info() {}, error() {} };

async function newRuntime(): Promise<{ rt: RuntimeHandle; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfe-test-"));
  const rt = await createRuntime({ dataDir: dir, maintenanceIntervalMs: 0, logger: silent });
  return { rt, dir };
}

// 统一口径：CNY（minorUnit=2），金额单位为“分”
const CNY = "CNY";
const assumptions: ForecastAssumptions = {
  // 下行 3 亿分 / 基准 8 亿分 / 上行 15 亿分
  revenueByScenario: { downside: 300_000_000, base: 800_000_000, upside: 1_500_000_000 },
  factors: { retention: 0.72 },
};
const terms: DealTerms = {
  guarantee: { amount: 100_000_000, currency: CNY, minorUnit: 2 }, // 保底 100M
  milestones: [
    {
      code: "master_delivery",
      trigger: "母带交付",
      dueDate: "2026-06-30",
      amount: { amount: 50_000_000, currency: CNY, minorUnit: 2 },
    },
  ],
  // 0~5 亿分档 10%，5 亿分以上 20%
  royaltyTiers: [
    { threshold: 0, rate: 0.1 },
    { threshold: 500_000_000, rate: 0.2 },
  ],
  contingentCap: null,
};

async function seed() {
  const { rt, dir } = await newRuntime();
  const pool = rt.service.publishPool({
    poolId: "pool-1",
    key: { currency: CNY, region: "CN", contentType: "drama", period: "2026H1" },
    minorUnit: 2,
    limit: 1_000_000_000,
    by: "finance",
  });
  const forecast = rt.service.publishForecast({
    forecastId: "fc-1",
    currency: CNY,
    minorUnit: 2,
    periods: ["2026H1"],
    assumptions,
    by: "fp&a",
  });
  return { rt, dir, pool, forecast };
}

test("申请时计算保底/里程碑/或有分成的三档压力区间并占用容量", async () => {
  const { rt } = await seed();
  const result = await rt.service.submitProposal({
    idempotencyKey: "k-1",
    projectId: "prj-A",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms,
    submittedBy: "buyer.zhang",
  });
  assert.equal(result.reused, false);
  const s = result.occupancy.stress;
  // 下行：保底100M + 里程碑50M + 分成 300M*10%=30M = 180M
  assert.equal(s.downside.total.amount, 180_000_000);
  // 基准：150M + (500M*10% + 300M*20%)=110M -> 260M
  assert.equal(s.base.total.amount, 260_000_000);
  // 上行：150M + (50M + 1000M*20%=200M)=250M -> 400M
  assert.equal(s.upside.total.amount, 400_000_000);
  assert.equal(result.occupancy.reservedAmount, 260_000_000);

  const ledger = rt.analytics.poolLedger("pool-1")!;
  assert.equal(ledger.scenarios.base.occupied, 260_000_000);
  assert.equal(ledger.scenarios.base.signed, 0);
  assert.equal(ledger.scenarios.base.available, 740_000_000);
});

test("相同申请重试沿用原占用，不产生新版本也不重复占容量", async () => {
  const { rt } = await seed();
  const first = await rt.service.submitProposal({
    proposalId: "prop-x",
    idempotencyKey: "idem-x",
    projectId: "prj-A",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms,
    submittedBy: "buyer.zhang",
  });
  const eventsAfterFirst = rt.store.all().length;
  const retry = await rt.service.submitProposal({
    proposalId: "prop-x",
    idempotencyKey: "idem-x",
    projectId: "prj-A",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms,
    submittedBy: "buyer.zhang",
  });
  assert.equal(retry.reused, true);
  assert.equal(retry.version, 1);
  assert.equal(rt.store.all().length, eventsAfterFirst); // 没有新事件
  assert.equal(rt.projection.reservedNet("pool-1"), 260_000_000);
});

test("金额或条款变化形成新版本，旧预留被替换", async () => {
  const { rt } = await seed();
  await rt.service.submitProposal({
    proposalId: "prop-y",
    idempotencyKey: "idem-y",
    projectId: "prj-A",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms,
    submittedBy: "buyer.zhang",
  });
  const changed: DealTerms = {
    ...terms,
    guarantee: { amount: 120_000_000, currency: CNY, minorUnit: 2 },
  };
  const v2 = await rt.service.submitProposal({
    proposalId: "prop-y",
    idempotencyKey: "idem-y", // 同一幂等键、条款变化
    projectId: "prj-A",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms: changed,
    submittedBy: "buyer.zhang",
  });
  assert.equal(v2.reused, false);
  assert.equal(v2.version, 2);
  assert.equal(v2.occupancy.reservedAmount, 280_000_000);
  // 净占用只计新版本
  assert.equal(rt.projection.reservedNet("pool-1"), 280_000_000);
  // 历史版本仍可查
  assert.equal(rt.projection.occupancyVersion("prop-y", 1)!.reservedAmount, 260_000_000);
});

test("两个项目并发争用余额时恰好一个成功", async () => {
  const { rt } = await seed();
  // 把池限额调成只够一个方案（基准口径 260M）
  rt.service.publishPool({
    poolId: "pool-1",
    key: { currency: CNY, region: "CN", contentType: "drama", period: "2026H1" },
    minorUnit: 2,
    limit: 260_000_000,
    by: "finance",
  });
  const mk = (projectId: string, key: string) =>
    rt.service.submitProposal({
      idempotencyKey: key,
      projectId,
      poolId: "pool-1",
      forecastId: "fc-1",
      forecastVersion: 1,
      terms,
      submittedBy: "buyer.zhang",
    });
  const outcomes = await Promise.allSettled([mk("prj-A", "k-a"), mk("prj-B", "k-b")]);
  const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
  const rejected = outcomes.filter((o) => o.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(
    (rejected[0] as PromiseRejectedResult).reason.code,
    "INSUFFICIENT_BALANCE",
  );
  assert.equal(rt.projection.reservedNet("pool-1"), 260_000_000);
});

test("审批人不能批准自己提交的方案；他人可批准，拒绝释放容量", async () => {
  const { rt } = await seed();
  const submitted = await rt.service.submitProposal({
    proposalId: "prop-s",
    idempotencyKey: "idem-s",
    projectId: "prj-A",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms,
    submittedBy: "buyer.zhang",
  });
  assert.throws(
    () => rt.service.decide(submitted.proposalId, "buyer.zhang", "approved"),
    (err: Error) => err.message.includes("自己提交"),
  );

  // 第二个方案：审批拒绝 -> 容量通过补偿释放
  const rejectedProp = await rt.service.submitProposal({
    idempotencyKey: "idem-r",
    projectId: "prj-B",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms,
    submittedBy: "buyer.lin",
  });
  rt.service.decide(rejectedProp.proposalId, "manager.chen", "rejected", "条款不达标");
  assert.equal(rt.projection.occupancy(rejectedProp.proposalId)!.status, "rejected");
  const afterReject = rt.projection.reservedNet("pool-1");

  // 第一个方案由他人批准
  const approval = rt.service.decide(submitted.proposalId, "manager.chen", "approved");
  assert.equal(approval.approver, "manager.chen");
  assert.equal(rt.projection.occupancy(submitted.proposalId)!.status, "approved");
  // 拒绝的方案不占余额，只剩已批准的 260M
  assert.equal(afterReject + 0, 260_000_000);
  assert.equal(rt.projection.reservedNet("pool-1"), 260_000_000);
});

test("签约冻结快照；预测被替代只重评未签约占用，已签合同只生成缺口提案且不可倒改", async () => {
  const { rt } = await seed();
  // 方案 A 签约
  const a = await rt.service.submitProposal({
    proposalId: "prop-signed",
    idempotencyKey: "idem-signed",
    projectId: "prj-A",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms,
    submittedBy: "buyer.zhang",
  });
  rt.service.decide(a.proposalId, "manager.chen", "approved");
  const contract = await rt.service.sign(a.proposalId, "legal.zhou");
  assert.equal(contract.committedAmount, 260_000_000);

  // 方案 B 未签约
  const b = await rt.service.submitProposal({
    proposalId: "prop-open",
    idempotencyKey: "idem-open",
    projectId: "prj-B",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms,
    submittedBy: "buyer.lin",
  });

  // 发布预测 v2：基准收入上调到 12 亿分（或有分成增加）
  rt.service.publishForecast({
    forecastId: "fc-1",
    currency: CNY,
    minorUnit: 2,
    periods: ["2026H1"],
    assumptions: {
      revenueByScenario: { downside: 300_000_000, base: 1_200_000_000, upside: 2_000_000_000 },
      factors: { retention: 0.8 },
    },
    by: "fp&a",
  });

  // 未签约占用被重评：基准口径 150M + (50M + 700M*20%=140M)=190M -> 340M
  const reevaluated = rt.projection.occupancy(b.proposalId)!;
  assert.equal(reevaluated.version, 2);
  assert.equal(reevaluated.reservedAmount, 340_000_000);
  assert.equal(reevaluated.lastReevaluation?.reason, "forecast_superseded");
  assert.equal(reevaluated.basis.forecastVersion, 2);
  // 重评任务已完成
  assert.ok([...rt.projection.jobs.values()].every((j) => j.status === "done"));

  // 已签合同：金额快照不变
  const storedContract = rt.projection.contracts.get(contract.contractId)!;
  assert.equal(storedContract.committedAmount, 260_000_000);
  assert.equal(storedContract.stress.base.total.amount, 260_000_000);
  assert.equal(storedContract.basis.forecastVersion, 1);

  // 生成缺口处置提案，现值按新口径 340M，缺口 80M
  const gaps = rt.analytics
    .lineage(a.proposalId)
    .gapProposals.filter((g) => g.status === "open");
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].reason, "forecast_superseded");
  assert.equal(gaps[0].currentAmount, 340_000_000);
  assert.equal(gaps[0].gapAmount, 80_000_000);
  assert.equal(gaps[0].suggestedResolution, "renegotiate_contract");

  // 事件日志里的签约事件载荷也未被倒改
  const signedEvent = rt.store
    .all()
    .find((s) => s.event.type === "ContractSigned")!;
  assert.equal(
    (signedEvent.event as { payload: { committedAmount: number } }).payload.committedAmount,
    260_000_000,
  );
});

test("汇率版本变化只重评跨币种占用；同币种占用不受影响", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfe-fx-"));
  const rt = (
    await createRuntime({ dataDir: dir, maintenanceIntervalMs: 0, logger: silent })
  );
  rt.service.publishPool({
    poolId: "pool-usd",
    key: { currency: "USD", region: "NA", contentType: "drama", period: "2026H1" },
    minorUnit: 2,
    limit: 100_000_000,
    by: "finance",
  });
  rt.service.publishForecast({
    forecastId: "fc-usd",
    currency: "USD",
    minorUnit: 2,
    periods: ["2026H1"],
    assumptions: {
      revenueByScenario: { downside: 1_000_000, base: 8_000_000, upside: 20_000_000 },
      factors: {},
    },
    by: "fp&a",
  });
  // v1: 1 USD = 7 CNY；合同以 CNY 计价
  rt.service.publishFx({ rates: [{ from: "CNY", to: "USD", rate: 1 / 7 }], by: "treasury" });
  const cnyTerms: DealTerms = {
    guarantee: { amount: 7_000_000, currency: "CNY", minorUnit: 2 }, // 70,000 CNY = 10,000 USD
    milestones: [],
    royaltyTiers: [],
    contingentCap: null,
  };
  const submitted = await rt.service.submitProposal({
    idempotencyKey: "fx-1",
    projectId: "prj-fx",
    poolId: "pool-usd",
    forecastId: "fc-usd",
    forecastVersion: 1,
    terms: cnyTerms,
    submittedBy: "buyer.zhang",
  });
  const v1Base = submitted.occupancy.stress.base.total.amount;

  // v2: 1 USD = 7.2 CNY（人民币贬值 -> 同额 CNY 换算成 USD 变少）
  rt.service.publishFx({ rates: [{ from: "CNY", to: "USD", rate: 1 / 7.2 }], by: "treasury" });
  const after = rt.projection.occupancy(submitted.proposalId)!;
  assert.equal(after.version, 2);
  assert.equal(after.lastReevaluation?.reason, "fx_changed");
  assert.ok(after.reservedAmount < v1Base, "CNY 贬值后 USD 池占用应下降");
});

test("项目延期：未签约入重评任务，已签合同生成重谈缺口", async () => {
  const { rt } = await seed();
  const a = await rt.service.submitProposal({
    proposalId: "prop-delay-open",
    idempotencyKey: "d-1",
    projectId: "prj-delay",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms,
    submittedBy: "buyer.zhang",
  });
  rt.service.decide(a.proposalId, "manager.chen", "approved");
  const contract = await rt.service.sign(a.proposalId, "legal.zhou");

  const b = await rt.service.submitProposal({
    idempotencyKey: "d-2",
    projectId: "prj-delay",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms,
    submittedBy: "buyer.lin",
  });

  const outcome = rt.service.projectDelay({
    projectId: "prj-delay",
    by: "pm.office",
    reason: "拍摄排期延后一个季度",
    revisedPeriod: "2026H2",
    milestoneDueDates: { master_delivery: "2026-09-30" },
  });
  assert.equal(outcome.jobs, 1);
  assert.equal(outcome.gaps, 1);

  const open = rt.projection.occupancy(b.proposalId)!;
  assert.equal(open.version, 2);
  assert.equal(open.lastReevaluation?.reason, "project_delayed");
  assert.equal(open.terms.milestones[0].dueDate, "2026-09-30");
  // 原批准已随依据变化打回待审批
  assert.equal(open.status, "pending_approval");

  const signed = rt.projection.contracts.get(contract.contractId)!;
  assert.equal(signed.committedAmount, 260_000_000); // 快照不变
  const gap = rt.analytics.lineage(a.proposalId).gapProposals[0];
  assert.equal(gap.reason, "project_delayed");
});

test("取消、到期与合同终止通过补偿事件释放容量", async () => {
  const { rt } = await seed();
  const cancelProp = await rt.service.submitProposal({
    idempotencyKey: "cmp-cancel",
    projectId: "prj-c",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms,
    submittedBy: "buyer.zhang",
  });
  await rt.service.cancel(cancelProp.proposalId, "谈判破裂");  assert.equal(rt.projection.occupancy(cancelProp.proposalId)!.status, "cancelled");
  assert.equal(rt.projection.reservedNet("pool-1"), 0);

  // 到期：显式 expiresAt 已过期
  const expiryProp = await rt.service.submitProposal({
    idempotencyKey: "cmp-expiry",
    projectId: "prj-e",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms,
    submittedBy: "buyer.zhang",
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  const expired = await rt.service.scanExpiries();
  assert.equal(expired, 1);
  assert.equal(rt.projection.occupancy(expiryProp.proposalId)!.status, "expired");

  // 签约后终止
  const termProp = await rt.service.submitProposal({
    idempotencyKey: "cmp-term",
    projectId: "prj-t",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms,
    submittedBy: "buyer.zhang",
  });
  rt.service.decide(termProp.proposalId, "manager.chen", "approved");
  const contract = await rt.service.sign(termProp.proposalId, "legal.zhou");
  assert.equal(rt.analytics.poolLedger("pool-1")!.scenarios.base.signed, 260_000_000);
  await rt.service.terminate(contract.contractId, "内容方违约");
  assert.equal(rt.projection.contracts.get(contract.contractId)!.status, "terminated");
  assert.equal(rt.analytics.poolLedger("pool-1")!.scenarios.base.signed, 0);
  assert.equal(rt.analytics.poolLedger("pool-1")!.scenarios.base.available, 1_000_000_000);

  // 补偿事件齐全且释放金额正确
  const compensations = rt.projection.compensations
    .map((s) => s.event.payload as { kind: string; releasedAmount: number });
  assert.deepEqual(
    compensations.map((c) => c.kind).sort(),
    ["cancellation", "expiry", "termination"],
  );
  assert.ok(compensations.every((c) => c.releasedAmount === 260_000_000));
});

test("预算下调导致未签约占用违约：需人工豁免才能审批", async () => {
  const { rt } = await seed();
  const prop = await rt.service.submitProposal({
    idempotencyKey: "breach-1",
    projectId: "prj-breach",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms,
    submittedBy: "buyer.zhang",
  });
  // 池限额下调到 200M，当前基准口径 260M，缺口 60M
  rt.service.publishPool({
    poolId: "pool-1",
    key: { currency: CNY, region: "CN", contentType: "drama", period: "2026H1" },
    minorUnit: 2,
    limit: 200_000_000,
    by: "finance",
  });
  const o = rt.projection.occupancy(prop.proposalId)!;
  assert.equal(o.breach?.shortfall, 60_000_000);

  assert.throws(
    () => rt.service.decide(prop.proposalId, "manager.chen", "approved"),
    (err: Error & { code?: string }) => err.code === "WAIVER_REQUIRED",
  );
  const waiver = rt.service.grantWaiver({
    proposalId: prop.proposalId,
    type: "insufficient_balance",
    amount: 60_000_000,
    grantedBy: "vp.liu",
    reason: "战略项目，管理层承接超额风险",
  });
  rt.service.decide(prop.proposalId, "manager.chen", "approved");
  assert.equal(rt.projection.occupancy(prop.proposalId)!.status, "approved");

  // 豁免撤销后不再具备签约条件
  rt.service.revokeWaiver(waiver.waiverId);
  await assert.rejects(
    rt.service.sign(prop.proposalId, "legal.zhou"),
    (err: Error & { code?: string }) => err.code === "WAIVER_REQUIRED",
  );
});

test("缺口提案可按豁免承接方式处理，血缘可追到豁免", async () => {
  const { rt } = await seed();
  const a = await rt.service.submitProposal({
    proposalId: "prop-gap",
    idempotencyKey: "gap-1",
    projectId: "prj-gap",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms,
    submittedBy: "buyer.zhang",
  });
  rt.service.decide(a.proposalId, "manager.chen", "approved");
  await rt.service.sign(a.proposalId, "legal.zhou");
  rt.service.publishForecast({
    forecastId: "fc-1",
    currency: CNY,
    minorUnit: 2,
    periods: ["2026H1"],
    assumptions: {
      revenueByScenario: { downside: 300_000_000, base: 1_200_000_000, upside: 2_000_000_000 },
      factors: {},
    },
    by: "fp&a",
  });
  const gap = rt.analytics.lineage(a.proposalId).gapProposals[0];
  const waiver = rt.service.grantWaiver({
    proposalId: a.proposalId,
    type: "gap_acceptance",
    amount: gap.gapAmount,
    grantedBy: "cfo.sun",
    reason: "确认承接口径变化带来的增量风险",
  });
  rt.service.resolveGap(gap.gapId, "accept_via_waiver", "cfo.sun", "季度风险会通过", waiver.waiverId);
  const resolved = rt.projection.gaps.find((g) => g.gapId === gap.gapId)!;
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolution?.waiverId, waiver.waiverId);

  const lineage = rt.analytics.lineage(a.proposalId);
  assert.ok(lineage.waivers.some((w) => w.waiverId === waiver.waiverId));
  assert.equal(lineage.contract?.snapshot.stress.base.total.amount, 260_000_000);
});

test("台账呈现已签/占用/可用/风险缺口，并可下钻到版本、预测依据与豁免", async () => {
  const { rt } = await seed();
  const a = await rt.service.submitProposal({
    proposalId: "prop-ledger-a",
    idempotencyKey: "l-1",
    projectId: "prj-a",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms,
    submittedBy: "buyer.zhang",
  });
  rt.service.decide(a.proposalId, "manager.chen", "approved");
  await rt.service.sign(a.proposalId, "legal.zhou");
  await rt.service.submitProposal({
    idempotencyKey: "l-2",
    projectId: "prj-b",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms,
    submittedBy: "buyer.lin",
  });

  const ledger = rt.analytics.poolLedger("pool-1")!;
  assert.equal(ledger.scenarios.base.signed, 260_000_000);
  assert.equal(ledger.scenarios.base.occupied, 260_000_000);
  assert.equal(ledger.scenarios.base.committed, 520_000_000);
  assert.equal(ledger.scenarios.base.available, 480_000_000);
  // 上行情景 400M*2 = 800M 仍在限额内
  assert.equal(ledger.scenarios.upside.riskGap, 0);

  // 下钻：合同条目带版本历史与预测依据快照
  const contractItem = ledger.items.find((i) => i.kind === "contract")!;
  assert.deepEqual(contractItem.versions, [1]);
  assert.equal(contractItem.basis.forecastId, "fc-1");
  assert.equal(contractItem.basis.assumptionsSnapshot.revenueByScenario.base, 800_000_000);
});

test("多场景对比按币种聚合", async () => {
  const { rt } = await seed();
  rt.service.publishPool({
    key: { currency: "USD", region: "NA", contentType: "sports", period: "2026H1" },
    minorUnit: 2,
    limit: 500_000_000,
    by: "finance",
  });
  const comparison = rt.analytics.compareScenarios();
  const cny = comparison.find((c) => c.currency === "CNY")!;
  const usd = comparison.find((c) => c.currency === "USD")!;
  assert.equal(cny.poolCount, 1);
  assert.equal(usd.poolCount, 1);
  assert.equal(cny.scenarios.base.limit, 1_000_000_000);
  assert.equal(usd.scenarios.base.available, 500_000_000);
});

test("服务重启后重放历史并继续释放到期占用、续跑重评任务", async () => {
  const { rt, dir } = await seed();
  const prop = await rt.service.submitProposal({
    idempotencyKey: "restart-expiry",
    projectId: "prj-restart",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms,
    submittedBy: "buyer.zhang",
    expiresAt: new Date(Date.now() + 50).toISOString(),
  });

  // 模拟“任务已入队但处理未完成”的崩溃现场：直接追加一条待处理重评事件
  rt.store.append({
    type: "ReevaluationJobEnqueued",
    payload: {
      jobId: "job-crashed",
      proposalId: prop.proposalId,
      occupancyVersion: 1,
      reason: "fx_changed",
      triggerRef: "fx@v9",
      status: "pending",
      attempts: 0,
      createdAt: new Date().toISOString(),
    },
  });
  const eventsBefore = rt.store.all().length;

  await new Promise((r) => setTimeout(r, 80));
  rt.stop();

  // 新进程：同一 DATA_DIR 重放
  const restarted = await createRuntime({
    dataDir: dir,
    maintenanceIntervalMs: 0,
    logger: silent,
  });
  // 历史完整恢复
  assert.equal(restarted.store.all().length >= eventsBefore, true);
  assert.equal(restarted.projection.pool("pool-1")!.limit, 1_000_000_000);
  // 到期占用已由启动维护释放
  assert.equal(restarted.projection.occupancy(prop.proposalId)!.status, "expired");
  // 遗留重评任务已续跑完成（占用已终结 -> 任务直接完成）
  const job = restarted.projection.jobs.get("job-crashed")!;
  assert.equal(job.status, "done");
  restarted.stop();
});

test("取消/拒绝后同幂等键改条款重新申请，容量账不重复冲销", async () => {
  const { rt } = await seed();
  const first = await rt.service.submitProposal({
    proposalId: "prop-reopen",
    idempotencyKey: "reopen-1",
    projectId: "prj-r",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms,
    submittedBy: "buyer.zhang",
  });
  await rt.service.cancel(first.proposalId, "先撤回");
  assert.equal(rt.projection.reservedNet("pool-1"), 0);

  const changed: DealTerms = {
    ...terms,
    guarantee: { amount: 80_000_000, currency: CNY, minorUnit: 2 },
  };
  const reopened = await rt.service.submitProposal({
    proposalId: "prop-reopen",
    idempotencyKey: "reopen-1",
    projectId: "prj-r",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 1,
    terms: changed,
    submittedBy: "buyer.zhang",
  });
  assert.equal(reopened.version, 2);
  assert.equal(reopened.occupancy.status, "pending_approval");
  // 新口径：保底80M + 里程碑50M + 分成110M = 240M
  assert.equal(reopened.occupancy.reservedAmount, 240_000_000);
  assert.equal(rt.projection.reservedNet("pool-1"), 240_000_000);
});

test("不能引用已被替代的预测；拒绝释放容量后后续申请可成功", async () => {
  const { rt } = await seed();
  // 发布 fc-1 v2 替代 v1
  rt.service.publishForecast({
    forecastId: "fc-1",
    currency: CNY,
    minorUnit: 2,
    periods: ["2026H1"],
    assumptions: {
      revenueByScenario: { downside: 200_000_000, base: 700_000_000, upside: 1_400_000_000 },
      factors: {},
    },
    by: "fp&a",
  });
  await assert.rejects(
    rt.service.submitProposal({
      idempotencyKey: "stale-fc",
      projectId: "prj-stale",
      poolId: "pool-1",
      forecastId: "fc-1",
      forecastVersion: 1, // 已被替代
      terms,
      submittedBy: "buyer.zhang",
    }),
    (err: Error & { code?: string }) => err.code === "FORECAST_SUPERSEDED",
  );

  // 池限额只容一个 v2 基准口径（保底100M + 里程碑50M + 分成90M = 240M）；
  // A 被拒后释放，B 随即成功（串行争用、错误不毒化队列）
  rt.service.publishPool({
    poolId: "pool-1",
    key: { currency: CNY, region: "CN", contentType: "drama", period: "2026H1" },
    minorUnit: 2,
    limit: 240_000_000,
    by: "finance",
  });
  const a = await rt.service.submitProposal({
    idempotencyKey: "seq-a",
    projectId: "prj-a",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 2,
    terms,
    submittedBy: "buyer.zhang",
  });
  rt.service.decide(a.proposalId, "manager.chen", "rejected", "先拒绝");
  assert.equal(rt.projection.reservedNet("pool-1"), 0);
  const b = await rt.service.submitProposal({
    idempotencyKey: "seq-b",
    projectId: "prj-b",
    poolId: "pool-1",
    forecastId: "fc-1",
    forecastVersion: 2,
    terms,
    submittedBy: "buyer.lin",
  });
  assert.equal(b.version, 1);
  assert.equal(b.occupancy.reservedAmount, 240_000_000);
  assert.equal(rt.projection.reservedNet("pool-1"), 240_000_000);
});

test("预算池按币种/地区/内容类型/期间版本化，维度不同即不同池", async () => {
  const { rt } = await seed();
  const other = rt.service.publishPool({
    key: { currency: CNY, region: "CN", contentType: "variety", period: "2026H1" },
    minorUnit: 2,
    limit: 100_000_000,
    by: "finance",
  });
  assert.notEqual(other.poolId, "pool-1");
  const v2 = rt.service.publishPool({
    poolId: "pool-1",
    key: { currency: CNY, region: "CN", contentType: "drama", period: "2026H1" },
    minorUnit: 2,
    limit: 900_000_000,
    by: "finance",
  });
  assert.equal(v2.version, 2);
  assert.equal(rt.projection.pool("pool-1")!.limit, 900_000_000);
  assert.equal(rt.projection.pools.get("pool-1")!.length, 2);
});
