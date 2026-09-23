import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";

test("健康检查返回服务标识", async () => {
  const app = buildApp();
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().service, "content-forecast-engine");
  await app.close();
});
