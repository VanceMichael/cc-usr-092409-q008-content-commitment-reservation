import Fastify, { type FastifyInstance } from "fastify";
import { join } from "node:path";
import { EventStore } from "./store/event-store.js";
import { ProcurementService } from "./service/procurement-service.js";
import { registerRoutes } from "./http/routes.js";

export interface AppContext {
  app: FastifyInstance;
  service: ProcurementService;
  store: EventStore;
}

/**
 * @param dataDir 事件日志目录，默认取 DATA_DIR（运行约定 /data）；
 *                传 ":memory:" 用于测试。
 */
export async function buildAppContext(dataDir: string | ":memory:" = process.env.DATA_DIR ?? "/data"): Promise<AppContext> {
  const path = dataDir === ":memory:" ? ":memory:" : join(dataDir, "procurement-events.jsonl");
  const store = new EventStore(path);
  const service = new ProcurementService(store);
  service.start();

  const app = Fastify({ logger: true });
  app.get("/health", async () => ({ status: "ok", service: "content-forecast-engine" }));
  registerRoutes(app, service);

  app.addHook("onClose", async () => {
    service.stop();
    store.close();
  });

  return { app, service, store };
}

/** 兼容既有入口/测试：返回仅挂载健康检查的应用。 */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });
  app.get("/health", async () => ({ status: "ok", service: "content-forecast-engine" }));
  return app;
}
