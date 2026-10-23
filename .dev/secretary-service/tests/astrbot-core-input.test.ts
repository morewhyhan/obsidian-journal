import { afterEach, expect, it } from "vitest";
import { createApp } from "../apps/core/app.js";
import { passwordHash } from "../apps/core/auth.js";
import { removeTemporary, temporary } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

it("Core accepts only the NapCat bot/owner pair and deduplicates message ids", async () => {
  const root = temporary();
  cleanups.push(async () => removeTemporary(root));
  const h = await createApp({
    vault: root,
    passwordHash: passwordHash("fixture-password"),
    sessionKey: "fixture-signature",
    origin: "http://localhost",
    timers: false,
    env: {
      SECRETARY_BRIDGE_TOKEN: "fixture-bridge-token-which-is-long-enough",
      SECRETARY_QQ_ENABLED: "1",
      SECRETARY_ASTRBOT_URL: "http://astrbot:3181",
      SECRETARY_QQ_BOT_ID: "1000000001",
      SECRETARY_RECIPIENT: "1000000002",
    },
  });
  cleanups.push(() => h.app.close());
  const headers = { authorization: "Bearer fixture-bridge-token-which-is-long-enough" };
  const body = {
    bot_id: "1000000001",
    user_id: "1000000002",
    message_id: "napcat-message-1",
    text: "列出当前目录",
    occurred_at: new Date().toISOString(),
  };
  const first = await h.app.inject({ method: "POST", url: "/internal/channel-input", headers, payload: body });
  expect(first.statusCode).toBe(202);
  const duplicate = await h.app.inject({ method: "POST", url: "/internal/channel-input", headers, payload: body });
  expect(duplicate.statusCode).toBe(202);
  expect(duplicate.json().duplicate).toBe(true);
  const stranger = await h.app.inject({ method: "POST", url: "/internal/channel-input", headers, payload: { ...body, message_id: "napcat-message-2", user_id: "1000000001" } });
  expect(stranger.statusCode).toBe(403);
});
