import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { EventStore } from "../src/store/event-store.js";
import { ProcurementService } from "../src/service/procurement-service.js";
import { registerRoutes } from "../src/http/routes.js";

function buildTestApp() {
  const store = new EventStore(":memory:");
  const service = new ProcurementService(store, Date.now, false);
  service.start();
  const app = Fastify({ logger: false });
  registerRoutes(app, service);
  return {
    app,
    service,
    close: () => app.close(),
  };
}

type TestApp = ReturnType<typeof buildTestApp>["app"];

async function jsonPost(app: TestApp, url: string, body: unknown) {
  return app.inject({
    method: "POST",
    url,
    payload: body as never,
    headers: { "content-type": "application/json" },
  });
}

async function jsonGet(app: TestApp, url: string) {
  return app.inject({ method: "GET", url });
}

test("端到端：建池→发预测→定义汇率→申请→批准→签署→看板钻取", async () => {
  const { app, close } = buildTestApp();

  let r = await jsonPost(app, "/admin/pools", {
    currency: "CNY",
    region: "APAC",
    contentType: "SERIES",
    period: "2026Q3",
    totalMinor: "10000",
  });
  assert.equal(r.statusCode, 200, r.body);
  const { poolKey } = r.json();

  r = await jsonPost(app, "/fx/versions", { version: "fx-1", base: "CNY", rates: {} });
  assert.equal(r.statusCode, 200);
  r = await jsonPost(app, "/fx/versions/fx-1/activate", {});
  assert.equal(r.statusCode, 200);

  r = await jsonPost(app, "/forecasts", {
    forecastId: "F-1",
    currency: "CNY",
    assumptions: { ad_growth: 0.08 },
    periods: [
      { period: "2026Q3", downsideMinor: "40000", baseMinor: "50000", upsideMinor: "60000" },
    ],
  });
  assert.equal(r.statusCode, 200);

  r = await jsonPost(app, "/proposals", {
    idempotencyKey: "req-1",
    projectId: "PRJ-A",
    pool: { currency: "CNY", region: "APAC", contentType: "SERIES", period: "2026Q3" },
    terms: {
      currency: "CNY",
      guaranteeMinor: "1000",
      milestones: [{ id: "m1", amountMinor: "500", duePeriod: "2026Q3" }],
      contingent: { bips: 1000, periods: ["2026Q3"] },
    },
    forecastId: "F-1",
    submittedBy: "alice",
  });
  assert.equal(r.statusCode, 200, r.body);
  const { proposalId } = r.json();
  assert.equal(r.json().range.baseMinor, "6500");

  // 自审被拒（400）
  r = await jsonPost(app, `/proposals/${proposalId}/approve`, { approverId: "alice" });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().message, /职责分离/);

  r = await jsonPost(app, `/proposals/${proposalId}/approve`, { approverId: "carol" });
  assert.equal(r.statusCode, 200, r.body);
  r = await jsonPost(app, `/proposals/${proposalId}/sign`, {});
  assert.equal(r.statusCode, 200);

  // 看板：已签/占用/可用
  r = await jsonGet(app, `/pools/${poolKey}?band=base`);
  assert.equal(r.statusCode, 200);
  const view = r.json();
  assert.equal(view.signedMinor, "6500");
  assert.equal(view.heldMinor, "0");
  assert.equal(view.availableMinor, "3500");
  assert.equal(view.signed[0].forecastId, "F-1");
  assert.equal(view.signed[0].forecastVersion, 1);
  assert.equal(view.signed[0].approverId, "carol");
  assert.equal(view.signed[0].submittedBy, "alice");

  // 三场景对比
  r = await jsonGet(app, "/scenarios");
  assert.equal(r.statusCode, 200);
  const scenarios = r.json();
  assert.equal(scenarios[0].downside.signedMinor, "5500");
  assert.equal(scenarios[0].base.signedMinor, "6500");
  assert.equal(scenarios[0].upside.signedMinor, "7500");
  assert.equal(scenarios[0].upside.availableMinor, "2500");

  // 钻取：合同版本、预测假设、审批链
  r = await jsonGet(app, `/proposals/${proposalId}/history`);
  assert.equal(r.statusCode, 200);
  const history = r.json();
  assert.equal(history.signedSnapshot.forecast.assumptions.ad_growth, 0.08);
  assert.equal(history.signedSnapshot.forecast.assumptionHash.length, 16);
  assert.equal(history.signedSnapshot.pool.totalMinor, "10000");
  assert.equal(history.versions[0].range.baseMinor, "6500");

  await close();
});

test("余额争用失败返回 409 结构化错误", async () => {
  const { app, close } = buildTestApp();
  await jsonPost(app, "/admin/pools", {
    currency: "CNY",
    region: "APAC",
    contentType: "SERIES",
    period: "2026Q3",
    totalMinor: "7000",
  });
  await jsonPost(app, "/fx/versions", { version: "fx-1", base: "CNY", rates: {} });
  await jsonPost(app, "/fx/versions/fx-1/activate", {});
  await jsonPost(app, "/forecasts", {
    forecastId: "F-1",
    currency: "CNY",
    assumptions: { x: 1 },
    periods: [
      { period: "2026Q3", downsideMinor: "40000", baseMinor: "50000", upsideMinor: "60000" },
    ],
  });
  const terms = {
    currency: "CNY",
    guaranteeMinor: "1000",
    milestones: [{ id: "m1", amountMinor: "500", duePeriod: "2026Q3" }],
    contingent: { bips: 1000, periods: ["2026Q3"] },
  };
  const first = await jsonPost(app, "/proposals", {
    idempotencyKey: "req-a",
    projectId: "A",
    pool: { currency: "CNY", region: "APAC", contentType: "SERIES", period: "2026Q3" },
    terms,
    forecastId: "F-1",
    submittedBy: "alice",
  });
  assert.equal(first.statusCode, 200);
  const second = await jsonPost(app, "/proposals", {
    idempotencyKey: "req-b",
    projectId: "B",
    pool: { currency: "CNY", region: "APAC", contentType: "SERIES", period: "2026Q3" },
    terms,
    forecastId: "F-1",
    submittedBy: "bob",
  });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, "BUDGET_EXHAUSTED");
  assert.equal(second.json().shortfallMinor, "6000");

  await close();
});

test("非法输入返回 400：金额必须为整数字符串", async () => {
  const { app, close } = buildTestApp();
  const r = await jsonPost(app, "/admin/pools", {
    currency: "CNY",
    region: "APAC",
    contentType: "SERIES",
    period: "2026Q3",
    totalMinor: "10.5",
  });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().message, /整数/);
  await close();
});
