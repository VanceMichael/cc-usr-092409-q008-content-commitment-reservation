import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
const app = await buildApp();
await app.listen({ host: "0.0.0.0", port });
