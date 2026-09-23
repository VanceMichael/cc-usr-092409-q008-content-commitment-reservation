import Fastify from "fastify";

export function buildApp() {
  const app = Fastify({ logger: true });
  app.get("/health", async () => ({ status: "ok", service: "content-forecast-engine" }));
  return app;
}
