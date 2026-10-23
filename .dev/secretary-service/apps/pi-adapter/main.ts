import { createPiApp } from "./app.js";
const token = process.env.SECRETARY_PI_INTERNAL_TOKEN,
  baseUrl = process.env.SECRETARY_CORE_MODEL_URL,
  modelId = process.env.LLM_MODEL;
if (!token || !baseUrl || !modelId)
  throw new Error(
    "Configure internal token, Core model proxy URL and model ID.",
  );
const app = createPiApp({ token, baseUrl, modelId });
await app.listen({
  host: "0.0.0.0",
  port: Number(process.env.PI_PORT ?? 3181),
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => void app.close());
