import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { createRuntime, type RuntimeHandle } from "./runtime.js";
import { registerRoutes } from "./routes.js";

export interface BuildOptions {
  /** 事件日志目录，默认取 DATA_DIR 或每次新建的临时目录 */
  dataDir?: string;
  /** 周期维护间隔（毫秒）；0 表示只执行一次启动恢复、不设定时器 */
  maintenanceIntervalMs?: number;
}

export async function buildApp(options: BuildOptions = {}) {
  const dataDir =
    options.dataDir ??
    process.env.DATA_DIR ??
    fs.mkdtempSync(path.join(os.tmpdir(), "cfe-"));
  const app = Fastify({ logger: true });
  const runtime: RuntimeHandle = await createRuntime({
    dataDir,
    maintenanceIntervalMs: options.maintenanceIntervalMs,
    logger: app.log,
  });
  app.decorate("runtime", runtime);
  app.get("/health", async () => ({ status: "ok", service: "content-forecast-engine" }));
  registerRoutes(app, runtime);
  app.addHook("onClose", async () => runtime.stop());
  return app;
}
