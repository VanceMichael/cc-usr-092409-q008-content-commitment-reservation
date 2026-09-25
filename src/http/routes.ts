import type { FastifyInstance } from "fastify";
import { BudgetExhaustedError, ProcurementService } from "../service/procurement-service.js";
import { bigintReplacer, optionalBigint, toBigint } from "./json-bigint.js";

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(reply: import("fastify").FastifyReply, code: number, body: unknown): void {
  reply
    .code(code)
    .header("content-type", "application/json; charset=utf-8")
    .send(JSON.stringify(body, bigintReplacer));
}

function bodyOf(request: import("fastify").FastifyRequest): Record<string, unknown> {
  const body = request.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") throw new HttpError(400, "请求体必须是 JSON 对象");
  return body;
}

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || v.trim() === "") throw new HttpError(400, `字段 ${key} 必填且为非空字符串`);
  return v;
}

function optStr(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HttpError(400, `字段 ${key} 必须为字符串`);
  return v;
}

function num(body: Record<string, unknown>, key: string): number {
  const v = body[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpError(400, `字段 ${key} 必填且为数字`);
  return v;
}

export function registerRoutes(app: FastifyInstance, svc: ProcurementService): void {
  const wrap =
    (fn: (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<unknown> | unknown) =>
    async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
      try {
        const result = await fn(request, reply);
        if (!reply.sent) sendJson(reply, 200, result ?? { ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof BudgetExhaustedError) {
          sendJson(reply, 409, {
            error: "BUDGET_EXHAUSTED",
            message,
            poolKey: err.poolKey,
            availableMinor: err.availableMinor.toString(),
            requestedMinor: err.requestedMinor.toString(),
            shortfallMinor: err.shortfallMinor.toString(),
          });
          return;
        }
        const status = err instanceof HttpError ? err.statusCode : 400;
        sendJson(reply, status, { error: status === 400 ? "BAD_REQUEST" : "ERROR", message });
      }
    };

  // ---------- 基础数据 ----------

  app.post(
    "/admin/pools",
    wrap((request) => {
      const b = bodyOf(request);
      return svc.createPool({
        currency: str(b, "currency"),
        region: str(b, "region"),
        contentType: str(b, "contentType"),
        period: str(b, "period"),
        totalMinor: toBigint(b.totalMinor, "totalMinor"),
      });
    }),
  );

  app.post(
    "/admin/pools/:poolKey/versions",
    wrap((request) => {
      const { poolKey } = request.params as { poolKey: string };
      const b = bodyOf(request);
      return svc.publishPoolVersion(poolKey, toBigint(b.totalMinor, "totalMinor"));
    }),
  );

  app.post(
    "/forecasts",
    wrap((request) => {
      const b = bodyOf(request);
      const periodsRaw = b.periods;
      if (!Array.isArray(periodsRaw) || periodsRaw.length === 0) {
        throw new HttpError(400, "periods 必须是非空数组");
      }
      const periods = periodsRaw.map((p) => {
        const x = p as Record<string, unknown>;
        return {
          period: str(x, "period"),
          downsideMinor: toBigint(x.downsideMinor, "downsideMinor"),
          baseMinor: toBigint(x.baseMinor, "baseMinor"),
          upsideMinor: toBigint(x.upsideMinor, "upsideMinor"),
        };
      });
      const assumptions = b.assumptions;
      if (!assumptions || typeof assumptions !== "object" || Array.isArray(assumptions)) {
        throw new HttpError(400, "assumptions 必须是对象");
      }
      return svc.publishForecast({
        forecastId: str(b, "forecastId"),
        currency: str(b, "currency"),
        assumptions: assumptions as Record<string, number>,
        periods,
        supersedesVersion:
          b.supersedesVersion === undefined || b.supersedesVersion === null
            ? undefined
            : Number(b.supersedesVersion),
      });
    }),
  );

  app.post(
    "/fx/versions",
    wrap((request) => {
      const b = bodyOf(request);
      const ratesRaw = b.rates;
      if (!ratesRaw || typeof ratesRaw !== "object" || Array.isArray(ratesRaw)) {
        throw new HttpError(400, "rates 必须是币种到十进制汇率的映射");
      }
      const rates: Record<string, string> = {};
      for (const [ccy, value] of Object.entries(ratesRaw as Record<string, unknown>)) {
        rates[ccy] = String(value);
      }
      return svc.defineFxVersion({
        version: str(b, "version"),
        rates,
        base: optStr(b, "base"),
      });
    }),
  );

  app.post(
    "/fx/versions/:version/activate",
    wrap((request) => {
      const { version } = request.params as { version: string };
      return svc.activateFx(version);
    }),
  );

  app.post(
    "/waivers",
    wrap((request) => {
      const b = bodyOf(request);
      return svc.grantWaiver({
        grantedBy: str(b, "grantedBy"),
        reason: str(b, "reason"),
        amountMinor: optionalBigint(b.amountMinor, "amountMinor"),
        poolKey: optStr(b, "poolKey"),
        occupancyId: optStr(b, "occupancyId"),
        gapId: optStr(b, "gapId"),
      });
    }),
  );

  // ---------- 谈判方案全生命周期 ----------

  app.post(
    "/proposals",
    wrap((request) => {
      const b = bodyOf(request);
      const pool = b.pool as Record<string, unknown> | undefined;
      if (!pool) throw new HttpError(400, "pool 必填");
      const termsRaw = b.terms as Record<string, unknown> | undefined;
      if (!termsRaw) throw new HttpError(400, "terms 必填");
      const milestonesRaw = Array.isArray(termsRaw.milestones) ? termsRaw.milestones : [];
      const contingentRaw = termsRaw.contingent as Record<string, unknown> | undefined;
      if (!contingentRaw) throw new HttpError(400, "terms.contingent 必填");
      const waiverIds = Array.isArray(b.waiverIds)
        ? (b.waiverIds as unknown[]).map((x) => String(x))
        : [];
      return svc.submitProposal({
        idempotencyKey: str(b, "idempotencyKey"),
        projectId: str(b, "projectId"),
        pool: {
          currency: str(pool, "currency"),
          region: str(pool, "region"),
          contentType: str(pool, "contentType"),
          period: str(pool, "period"),
        },
        terms: {
          currency: str(termsRaw, "currency"),
          guaranteeMinor: toBigint(termsRaw.guaranteeMinor, "guaranteeMinor"),
          milestones: milestonesRaw.map((m) => {
            const x = m as Record<string, unknown>;
            return {
              id: str(x, "id"),
              amountMinor: toBigint(x.amountMinor, "amountMinor"),
              duePeriod: str(x, "duePeriod"),
            };
          }),
          contingent: {
            bips: Number(contingentRaw.bips),
            periods: (Array.isArray(contingentRaw.periods)
              ? (contingentRaw.periods as unknown[]).map((x) => String(x))
              : []
            ).filter((x) => x),
          },
        },
        forecastId: str(b, "forecastId"),
        forecastVersion:
          b.forecastVersion === undefined || b.forecastVersion === null
            ? undefined
            : Number(b.forecastVersion),
        submittedBy: str(b, "submittedBy"),
        ttlMs: b.ttlMs === undefined ? undefined : num(b, "ttlMs"),
        waiverIds,
      });
    }),
  );

  app.post(
    "/proposals/:proposalId/approve",
    wrap((request) => {
      const { proposalId } = request.params as { proposalId: string };
      const b = bodyOf(request);
      const approverId = str(b, "approverId");
      const waiverId = optStr(b, "waiverId");
      return svc.approve(proposalId, approverId, waiverId);
    }),
  );

  app.post(
    "/proposals/:proposalId/sign",
    wrap((request) => {
      const { proposalId } = request.params as { proposalId: string };
      return svc.sign(proposalId);
    }),
  );

  app.post(
    "/proposals/:proposalId/reject",
    wrap((request) => {
      const { proposalId } = request.params as { proposalId: string };
      const b = (request.body ?? {}) as Record<string, unknown>;
      return svc.reject(proposalId, optStr(b, "note"));
    }),
  );

  app.post(
    "/proposals/:proposalId/cancel",
    wrap((request) => {
      const { proposalId } = request.params as { proposalId: string };
      const b = (request.body ?? {}) as Record<string, unknown>;
      return svc.cancel(proposalId, optStr(b, "note"));
    }),
  );

  app.post(
    "/proposals/:proposalId/terminate",
    wrap((request) => {
      const { proposalId } = request.params as { proposalId: string };
      const b = (request.body ?? {}) as Record<string, unknown>;
      return svc.terminateContract(proposalId, optStr(b, "note"));
    }),
  );

  app.get(
    "/proposals/:proposalId/history",
    wrap((request) => {
      const { proposalId } = request.params as { proposalId: string };
      return svc.proposalHistory(proposalId);
    }),
  );

  // ---------- 重评触发与缺口处置 ----------

  app.post(
    "/projects/:projectId/delay",
    wrap((request) => {
      const { projectId } = request.params as { projectId: string };
      const b = bodyOf(request);
      return svc.delayProject(projectId, num(b, "periods"));
    }),
  );

  app.post(
    "/gaps/:gapId/resolve",
    wrap((request) => {
      const { gapId } = request.params as { gapId: string };
      const b = bodyOf(request);
      const status = str(b, "status");
      const allowed = ["WAIVED", "RENEGOTIATED", "TOPPED_UP", "DISMISSED"];
      if (!allowed.includes(status)) {
        throw new HttpError(400, `status 必须是 ${allowed.join("/")}`);
      }
      return svc.resolveGap(
        gapId,
        status as "WAIVED" | "RENEGOTIATED" | "TOPPED_UP" | "DISMISSED",
        str(b, "note"),
        optStr(b, "waiverId"),
      );
    }),
  );

  app.get(
    "/gaps",
    wrap((request) => {
      const { status } = request.query as { status?: string };
      return svc.listGaps(status as never);
    }),
  );

  // ---------- 查询与管理看板 ----------

  app.get(
    "/pools",
    wrap(() => svc.listPools()),
  );

  app.get(
    "/pools/:poolKey",
    wrap((request) => {
      const { poolKey } = request.params as { poolKey: string };
      const { band } = request.query as { band?: string };
      const valid = band === undefined || ["downside", "base", "upside"].includes(band);
      if (!valid) throw new HttpError(400, "band 只能是 downside/base/upside");
      return svc.poolView(poolKey, (band ?? "base") as "downside" | "base" | "upside");
    }),
  );

  app.get(
    "/scenarios",
    wrap(() => svc.scenarioComparison()),
  );
}
