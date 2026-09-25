import { buildAppContext } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
const { app } = await buildAppContext(process.env.DATA_DIR ?? "/data");
await app.listen({ host: "0.0.0.0", port });
