import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
await buildApp().listen({ host: "0.0.0.0", port });
