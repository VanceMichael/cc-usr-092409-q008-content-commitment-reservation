/**
 * HTTP API 端到端测试：路由装配、幂等头、状态码映射、
 * 台账/场景对比/血缘接口。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApp } from "../src/app.js";

async function newApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfe-http-"));
  const app = await buildApp({ dataDir, maintenanceIntervalMs: 0 });
  return { app, dataDir };
}

const poolBody = {
  poolId: "pool-1",
  key: { currency: "CNY", region: "CN", contentType: "drama", period: "2026H1" },
  minorUnit: 2,
  limit: 1_000_000_000,
  by: "finance",
};
const forecastBody = {
  forecastId: "fc-1",
  currency: "CNY",
  minorUnit: 2,
  periods: ["2026H1"],
  assumptions: {
    revenueByScenario: { downside: 300_000_000, base: 800_000_000, upside: 1_500_000_000 },
    factors: { retention: 0.72 },
  },
  by: "fp&a",
};
const terms = {
  guarantee: { amount: 100_000_000, currency: "CNY", minorUnit: 2 },
  milestones: [
    {
      code: "master_delivery",
      trigger: "母带交付",
      dueDate: "2026-06-30",
      amount: { amount: 50_000_000, currency: "CNY", minorUnit: 2 },
    },
  ],
  royaltyTiers: [
    { threshold: 0, rate: 0.1 },
    { threshold: 500_000_000, rate: 0.2 },
  ],
  contingentCap: null,
};

async function seed(app: Awaited<ReturnType<typeof newApp>>["app"]) {
  await app.inject({ method: "POST", url: "/v1/pools", payload: poolBody });
  await app.inject({ method: "POST", url: "/v1/forecasts", payload: forecastBody });
}

test("HTTP: 全流程 申请->自审拒绝->审批->签约->台账", async () => {
  const { app } = await newApp();
  await seed(app);

  // 申请（幂等键走请求头）
  const submitted = await app.inject({
    method: "PUT",
    url: "/v1/proposals",
    headers: { "idempotency-key": "http-1" },
    payload: {
      proposalId: "prop-1",
      projectId: "prj-1",
      poolId: "pool-1",
      forecastId: "fc-1",
      forecastVersion: 1,
      terms,
      submittedBy: "buyer.zhang",
    },
  });
  assert.equal(submitted.statusCode, 201);
  assert.equal(submitted.json().occupancy.stress.base.total.amount, 260_000_000);

  // 重试同幂等键 -> 200 reused
  const retry = await app.inject({
    method: "PUT",
    url: "/v1/proposals",
    headers: { "idempotency-key": "http-1" },
    payload: {
      proposalId: "prop-1",
      projectId: "prj-1",
      poolId: "pool-1",
      forecastId: "fc-1",
      forecastVersion: 1,
      terms,
      submittedBy: "buyer.zhang",
    },
  });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().reused, true);

  // 自审 -> 403
  const self = await app.inject({
    method: "POST",
    url: "/v1/proposals/prop-1/decisions",
    payload: { approver: "buyer.zhang", decision: "approved" },
  });
  assert.equal(self.statusCode, 403);
  assert.equal(self.json().error, "SELF_APPROVAL_FORBIDDEN");

  // 他人审批
  const approved = await app.inject({
    method: "POST",
    url: "/v1/proposals/prop-1/decisions",
    payload: { approver: "manager.chen", decision: "approved", comment: "同意" },
  });
  assert.equal(approved.statusCode, 200);

  // 签约
  const signed = await app.inject({
    method: "POST",
    url: "/v1/proposals/prop-1/sign",
    payload: { signer: "legal.zhou" },
  });
  assert.equal(signed.statusCode, 200);
  assert.equal(signed.json().committedAmount, 260_000_000);

  // 台账
  const ledger = await app.inject({ method: "GET", url: "/v1/ledger/pools/pool-1" });
  assert.equal(ledger.statusCode, 200);
  const body = ledger.json();
  assert.equal(body.scenarios.base.signed, 260_000_000);
  assert.equal(body.scenarios.base.available, 740_000_000);
  assert.equal(body.items[0].basis.forecastId, "fc-1");

  // 血缘
  const lineage = await app.inject({ method: "GET", url: "/v1/lineage/proposals/prop-1" });
  assert.equal(lineage.statusCode, 200);
  assert.equal(lineage.json().contract.snapshot.basis.forecastVersion, 1);
  assert.ok(lineage.json().eventTrail.some((e: { type: string }) => e.type === "ContractSigned"));

  await app.close();
});

test("HTTP: 余额不足返回 409 与余额明细", async () => {
  const { app } = await newApp();
  await app.inject({
    method: "POST",
    url: "/v1/pools",
    payload: { ...poolBody, limit: 200_000_000 },
  });
  await app.inject({ method: "POST", url: "/v1/forecasts", payload: forecastBody });
  const res = await app.inject({
    method: "PUT",
    url: "/v1/proposals",
    headers: { "idempotency-key": "http-2" },
    payload: {
      projectId: "prj-1",
      poolId: "pool-1",
      forecastId: "fc-1",
      forecastVersion: 1,
      terms,
      submittedBy: "buyer.zhang",
    },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "INSUFFICIENT_BALANCE");
  assert.equal(res.json().details.requested, 260_000_000);
  assert.equal(res.json().details.available, 200_000_000);
  await app.close();
});

test("HTTP: 预测替代后重评未签约占用，场景对比反映新口径", async () => {
  const { app } = await newApp();
  await seed(app);
  await app.inject({
    method: "PUT",
    url: "/v1/proposals",
    headers: { "idempotency-key": "http-3" },
    payload: {
      projectId: "prj-1",
      poolId: "pool-1",
      forecastId: "fc-1",
      forecastVersion: 1,
      terms,
      submittedBy: "buyer.zhang",
    },
  });
  const v2 = await app.inject({
    method: "POST",
    url: "/v1/forecasts",
    payload: {
      ...forecastBody,
      assumptions: {
        revenueByScenario: { downside: 300_000_000, base: 1_200_000_000, upside: 2_000_000_000 },
        factors: {},
      },
    },
  });
  assert.equal(v2.statusCode, 200);
  assert.equal(v2.json().version, 2);

  const jobs = await app.inject({ method: "GET", url: "/v1/jobs?status=done" });
  assert.ok(jobs.json().jobs.length >= 1);

  const compare = await app.inject({ method: "GET", url: "/v1/scenarios/compare" });
  const cny = compare.json().comparison.find((c: { currency: string }) => c.currency === "CNY");
  // 重评后基准占用 340M
  assert.equal(cny.scenarios.base.occupied, 340_000_000);
  // 上行情景 150M + (50M + 1500M*20%=300M)=450M
  assert.equal(cny.scenarios.upside.occupied, 500_000_000);

  const events = await app.inject({ method: "GET", url: "/v1/events" });
  const types = events.json().events.map((e: { type: string }) => e.type);
  assert.ok(types.includes("OccupancyReevaluated"));
  await app.close();
});
