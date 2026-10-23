import path from "node:path";
import { createApp } from "./app.js";
const vault = process.env.SECRETARY_VAULT_ROOT;
if (
  !vault ||
  !process.env.SECRETARY_WEB_PASSWORD_HASH ||
  !process.env.SECRETARY_SESSION_SIGNING_KEY
)
  throw new Error(
    "Set SECRETARY_VAULT_ROOT, SECRETARY_WEB_PASSWORD_HASH and SECRETARY_SESSION_SIGNING_KEY; see README.",
  );
const { app } = await createApp({
  vault: path.resolve(vault),
  passwordHash: process.env.SECRETARY_WEB_PASSWORD_HASH,
  sessionKey: process.env.SECRETARY_SESSION_SIGNING_KEY,
  origin: process.env.SECRETARY_PUBLIC_ORIGIN,
  secure: process.env.NODE_ENV === "production",
});
await app.listen({
  host: process.env.SECRETARY_HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3180),
});
console.log("Secretary listening on configured host/port.");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void app.close());
