/**
 * HTTP 路由：把领域服务与分析视图暴露为 JSON API。
 * 金额一律使用各币种 minor unit 整数；DomainError 映射为对应 HTTP 状态码。
 */
import type { FastifyInstance } from "fastify";
import type { CommitmentService } from "./domain/service.js";
import type { Analytics } from "./domain/analytics.js";
import type { Projection } from "./domain/projections.js";
import { DomainError } from "./domain/service.js";
import type { EventStore } from "./domain/store.js";

export interface RouteDeps {
  service: CommitmentService;
  analytics: Analytics;
  projection: Projection;
  store: EventStore;
}

/** 最小入参校验：缺失字段直接 400，语义校验仍由领域服务负责 */
function bodyOf(request: { body: unknown }, required: string[]): Record<string, unknown> {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DomainError("INVALID_BODY", "请求体必须是 JSON 对象");
  }
  const b = body as Record<string, unknown>;
  for (const field of required) {
    if (b[field] === undefined || b[field] === null) {
      throw new DomainError("MISSING_FIELD", `缺少必填字段: ${field}`);
    }
  }
  return b;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { service, analytics, projection, store } = deps;

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      void reply.status(error.status).send({
        error: error.code,
        message: error.message,
        details: error.details,
      });
      return;
    }
    if ((error as { validation?: unknown }).validation) {
      void reply.status(400).send({
        error: "VALIDATION_ERROR",
        message: error.message,
      });
      return;
    }
    request.log.error(error);
    void reply.status(500).send({ error: "INTERNAL", message: "内部错误" });
  });

  // ============================================================ 预算池

  app.post("/v1/pools", async (request) => {
    const body = bodyOf(request, ["key", "minorUnit", "limit", "by"]);
    return service.publishPool({
      poolId: body.poolId as string | undefined,
      key: body.key as never,
      minorUnit: body.minorUnit as number,
      limit: body.limit as number,
      by: body.by as string,
      note: body.note as string | undefined,
    });
  });

  app.post<{ Params: { poolId: string } }>(
    "/v1/pools/:poolId/close",
    async (request, reply) => {
      service.closePool(request.params.poolId);
      return reply.send({ closed: request.params.poolId });
    },
  );

  app.get<{ Params: { poolId: string } }>(
    "/v1/pools/:poolId",
    async (request, reply) => {
      const versions = projection.pools.get(request.params.poolId);
      if (!versions) {
        throw new DomainError("POOL_NOT_FOUND", "预算池不存在", 404);
      }
      return { poolId: request.params.poolId, current: versions.at(-1), versions };
    },
  );

  // ============================================================ 预测 / 汇率

  app.post("/v1/forecasts", async (request) => {
    const body = bodyOf(request, ["currency", "minorUnit", "periods", "assumptions", "by"]);
    return service.publishForecast({
      forecastId: body.forecastId as string | undefined,
      currency: body.currency as string,
      minorUnit: body.minorUnit as number,
      periods: body.periods as string[],
      assumptions: body.assumptions as never,
      by: body.by as string,
    });
  });

  app.post<{ Params: { forecastId: string } }>(
    "/v1/forecasts/:forecastId/supersede",
    async (request) => {
      const body = bodyOf(request, ["successor"]) as {
        successor: { forecastId: string; version: number };
      };
      service.supersedeForecast(request.params.forecastId, body.successor);
      return { superseded: request.params.forecastId, successor: body.successor };
    },
  );

  app.get<{ Params: { forecastId: string } }>(
    "/v1/forecasts/:forecastId",
    async (request) => {
      const versions = projection.forecasts.get(request.params.forecastId);
      if (!versions) {
        throw new DomainError("FORECAST_NOT_FOUND", "预测不存在", 404);
      }
      return { forecastId: request.params.forecastId, current: versions.at(-1), versions };
    },
  );

  app.post("/v1/fx", async (request) => {
    const body = bodyOf(request, ["rates", "by"]) as { rates: never; by: string };
    return service.publishFx({ rates: body.rates, by: body.by });
  });

  app.get("/v1/fx", async () => ({
    latestVersion: projection.latestFxVersion,
    versions: [...projection.fxVersions.values()],
  }));

  // ============================================================ 申请 / 占用

  app.put("/v1/proposals", async (request, reply) => {
    const body = bodyOf(request, ["projectId", "poolId", "forecastId", "forecastVersion", "terms", "submittedBy"]);
    const idempotencyKey =
      (body.idempotencyKey as string | undefined) ??
      (request.headers["idempotency-key"] as string | undefined);
    if (!idempotencyKey) {
      throw new DomainError("IDEMPOTENCY_REQUIRED", "申请必须携带幂等键（body.idempotencyKey 或 Idempotency-Key 头）");
    }
    const result = await service.submitProposal({
      proposalId: body.proposalId as string | undefined,
      idempotencyKey,
      projectId: body.projectId as string,
      poolId: body.poolId as string,
      forecastId: body.forecastId as string,
      forecastVersion: body.forecastVersion as number,
      terms: body.terms as never,
      submittedBy: body.submittedBy as string,
      ttlHours: body.ttlHours as number | undefined,
      expiresAt: body.expiresAt as string | undefined,
    });
    return reply.status(result.reused ? 200 : 201).send(result);
  });

  app.get<{ Params: { proposalId: string } }>(
    "/v1/proposals/:proposalId",
    async (request) => {
      const line = projection.getLine(request.params.proposalId);
      if (!line) {
        throw new DomainError("PROPOSAL_NOT_FOUND", "方案不存在", 404);
      }
      return {
        proposalId: request.params.proposalId,
        current: line.versions.get(line.latest),
        versions: [...line.versions.values()].sort((a, b) => a.version - b.version),
      };
    },
  );

  app.post<{ Params: { proposalId: string } }>(
    "/v1/proposals/:proposalId/decisions",
    async (request) => {
      const body = bodyOf(request, ["approver", "decision"]) as {
        approver: string;
        decision: "approved" | "rejected";
        comment?: string;
      };
      return service.decide(
        request.params.proposalId,
        body.approver,
        body.decision,
        body.comment,
      );
    },
  );

  app.post<{ Params: { proposalId: string } }>(
    "/v1/proposals/:proposalId/sign",
    async (request) => {
      const body = bodyOf(request, ["signer"]) as { signer: string };
      return service.sign(request.params.proposalId, body.signer);
    },
  );

  app.post<{ Params: { proposalId: string } }>(
    "/v1/proposals/:proposalId/cancel",
    async (request) => {
      const body = bodyOf(request, ["reason"]) as { reason: string };
      return service.cancel(request.params.proposalId, body.reason);
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/delay",
    async (request) => {
      const body = bodyOf(request, ["by", "reason"]) as {
        by: string;
        reason: string;
        revisedPeriod?: string;
        milestoneDueDates?: Record<string, string>;
      };
      return service.projectDelay({ projectId: request.params.projectId, ...body });
    },
  );

  // ============================================================ 合同

  app.get("/v1/contracts", async () => ({ contracts: [...projection.contracts.values()] }));

  app.post<{ Params: { contractId: string } }>(
    "/v1/contracts/:contractId/terminate",
    async (request) => {
      const body = bodyOf(request, ["reason"]) as { reason: string };
      return service.terminate(request.params.contractId, body.reason);
    },
  );

  // ============================================================ 豁免 / 缺口

  app.post("/v1/waivers", async (request) => {
    const body = bodyOf(request, ["proposalId", "type", "amount", "grantedBy", "reason"]) as {
      proposalId: string;
      type: "insufficient_balance" | "reevaluation_override" | "gap_acceptance";
      amount: number;
      grantedBy: string;
      reason: string;
    };
    return service.grantWaiver(body);
  });

  app.post<{ Params: { waiverId: string } }>(
    "/v1/waivers/:waiverId/revoke",
    async (request, reply) => {
      service.revokeWaiver(request.params.waiverId);
      return reply.send({ revoked: request.params.waiverId });
    },
  );

  app.get("/v1/waivers", async () => ({ waivers: [...projection.waivers.values()] }));

  app.get<{ Querystring: { status?: string } }>("/v1/gaps", async (request) => {
    const gaps = request.query.status
      ? projection.gaps.filter((g) => g.status === request.query.status)
      : projection.gaps;
    return { gaps };
  });

  app.post<{ Params: { gapId: string } }>(
    "/v1/gaps/:gapId/resolve",
    async (request) => {
      const body = bodyOf(request, ["kind", "by", "note"]) as {
        kind:
          | "renegotiate_contract"
          | "transfer_budget"
          | "accept_via_waiver"
          | "reduce_scope";
        by: string;
        note: string;
        waiverId?: string;
      };
      return service.resolveGap(
        request.params.gapId,
        body.kind,
        body.by,
        body.note,
        body.waiverId,
      );
    },
  );

  // ============================================================ 分析视图

  app.get<{ Params: { poolId: string } }>(
    "/v1/ledger/pools/:poolId",
    async (request) => {
      const ledger = analytics.poolLedger(request.params.poolId);
      if (!ledger) throw new DomainError("POOL_NOT_FOUND", "预算池不存在", 404);
      return ledger;
    },
  );

  app.get<{
    Querystring: { region?: string; contentType?: string; period?: string };
  }>("/v1/scenarios/compare", async (request) => {
    return { comparison: analytics.compareScenarios(request.query) };
  });

  app.get<{ Params: { proposalId: string } }>(
    "/v1/lineage/proposals/:proposalId",
    async (request) => {
      if (!projection.getLine(request.params.proposalId) && !projection.contract(request.params.proposalId)) {
        throw new DomainError("PROPOSAL_NOT_FOUND", "方案不存在", 404);
      }
      return analytics.lineage(request.params.proposalId);
    },
  );

  // ============================================================ 运维 / 审计

  app.get<{ Querystring: { status?: string } }>("/v1/jobs", async (request) => {
    const jobs = [...projection.jobs.values()];
    return {
      jobs: request.query.status ? jobs.filter((j) => j.status === request.query.status) : jobs,
    };
  });

  app.post("/v1/maintenance/run", async () => {
    const expired = await service.scanExpiries();
    const { processed, failed } = await service.processReevaluationJobs();
    return { expired, processed, failed };
  });

  app.get("/v1/events", async () => ({
    events: store.all().map((s) => ({ seq: s.seq, at: s.at, ...s.event })),
  }));
}
