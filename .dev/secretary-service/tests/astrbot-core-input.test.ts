import { afterEach, expect, it } from "vitest";
import { createApp, agentRetryDelay } from "../apps/core/app.js";
import { passwordHash } from "../apps/core/auth.js";
import path from "node:path";
import fs from "node:fs";
import { removeTemporary, temporary } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

it("E09 a redelivered channel event neither duplicates the input nor resends the answer", async () => {
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
  h.core.agent = {
    executionMode: "tools-v2",
    interpret: async () => ({ action_groups: [], clarification: null, reply_intent: "discussion", discussion: "收到。" }),
  } as any;
  const headers = { authorization: "Bearer fixture-bridge-token-which-is-long-enough" };
  const body = {
    bot_id: "1000000001",
    user_id: "1000000002",
    message_id: "napcat-e09",
    text: "在吗",
    occurred_at: new Date().toISOString(),
  };
  expect((await h.app.inject({ method: "POST", url: "/internal/channel-input", headers, payload: body })).statusCode).toBe(202);
  await h.core.processPending();
  const inputs = () => (h.store.db.prepare("SELECT count(*) n FROM inbox").get() as any).n;
  const outbox = () => (h.store.db.prepare("SELECT count(*) n FROM outbox").get() as any).n;
  expect(inputs()).toBe(1);
  expect(outbox()).toBe(1);
  // The channel redelivers the same event: still one input and one answer.
  const again = await h.app.inject({ method: "POST", url: "/internal/channel-input", headers, payload: body });
  expect(again.statusCode).toBe(202);
  expect(again.json().duplicate).toBe(true);
  await h.core.processPending();
  expect(inputs()).toBe(1);
  expect(outbox()).toBe(1);
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

it("D16b a failed model self-test is logged with a code, not just silent", async () => {
  const root = temporary();
  cleanups.push(async () => removeTemporary(root));
  const { createServer } = await import("node:http");
  const bridge = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    // A bridge that is up but speaks the wrong contract must be diagnosable.
    response.end(JSON.stringify({ ok: true, agent: "astrbot", protocol: "legacy", tools_hash: "sha256:" + "0".repeat(64) }));
  });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => bridge.close(() => resolve())));
  const port = (bridge.address() as any).port;
  const h = await createApp({
    vault: root,
    passwordHash: passwordHash("fixture-password"),
    sessionKey: "fixture-signature",
    origin: "http://localhost",
    timers: false,
    env: {
      SECRETARY_BRIDGE_TOKEN: "fixture-bridge-token-which-is-long-enough",
      SECRETARY_QQ_ENABLED: "1",
      SECRETARY_ASTRBOT_URL: "http://127.0.0.1:" + port,
      SECRETARY_QQ_BOT_ID: "1000000001",
      SECRETARY_RECIPIENT: "1000000002",
    },
  });
  cleanups.push(() => h.app.close());
  const lines: string[] = [];
  const original = console.error;
  console.error = (value: any) => lines.push(String(value));
  try {
    h.checkAgent();
    await expect.poll(() => lines.length).toBeGreaterThan(0);
  } finally {
    console.error = original;
  }
  expect(h.core.agent).toBeUndefined();
  const entry = JSON.parse(lines.find((line) => line.includes("agent_self_test_failed"))!);
  expect(entry).toMatchObject({ event: "agent_self_test_failed", failures: 1 });
  expect(entry.code).toBe("AGENT_CONTRACT_MISMATCH");
});

it("D16 a restart turns the model on without waiting for a chat message", async () => {
  const root = temporary();
  cleanups.push(async () => removeTemporary(root));
  const { createServer } = await import("node:http");
  const { AGENT_TOOLS } = await import("../packages/contracts/agent-tools.js");
  const { hash } = await import("../apps/core/files.js");
  const toolsHash = hash(JSON.stringify(AGENT_TOOLS));
  let healthCalls = 0;
  const bridge = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/healthz") {
      healthCalls++;
      response.end(JSON.stringify({ ok: true, agent: "astrbot", protocol: "tools-v2", tools_hash: toolsHash }));
      return;
    }
    if (request.url === "/interpret") {
      response.end(
        JSON.stringify({
          action_groups: [],
          clarification: null,
          reply_intent: "discussion",
          discussion: "ready",
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => bridge.close(() => resolve())));
  const port = (bridge.address() as any).port;
  const h = await createApp({
    vault: root,
    passwordHash: passwordHash("fixture-password"),
    sessionKey: "fixture-signature",
    origin: "http://localhost",
    timers: false,
    env: {
      SECRETARY_BRIDGE_TOKEN: "fixture-bridge-token-which-is-long-enough",
      SECRETARY_QQ_ENABLED: "1",
      SECRETARY_ASTRBOT_URL: "http://127.0.0.1:" + port,
      SECRETARY_QQ_BOT_ID: "1000000001",
      SECRETARY_RECIPIENT: "1000000002",
    },
  });
  cleanups.push(() => h.app.close());
  expect(h.core.agent).toBeUndefined();
  // This is what main.ts calls right after listening.
  h.checkAgent();
  for (let i = 0; i < 100 && !h.core.agent; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(healthCalls).toBeGreaterThan(0);
  expect(h.core.agent).toBeDefined();
  expect(h.core.agent).toMatchObject({ executionMode: "tools-v2" });
  // The production entry must actually invoke it: a test that only calls the
  // hook itself would pass even if nothing ever ran at startup.
  const main = fs.readFileSync(path.join(process.cwd(), "apps/core/main.ts"), "utf8");
  expect(main).toContain("checkAgent");
  expect(main.indexOf("checkAgent()")).toBeGreaterThan(main.indexOf("Secretary listening"));
});

it("D17 a queued message shortens the model circuit breaker", () => {
  expect(agentRetryDelay(0, false)).toBe(0);
  expect(agentRetryDelay(1, false)).toBe(5000);
  expect(agentRetryDelay(2, false)).toBe(30000);
  // Ten minutes of silence after a restart is unacceptable while a user waits.
  expect(agentRetryDelay(3, true)).toBe(30000);
  expect(agentRetryDelay(5, true)).toBe(30000);
  // Without anyone waiting the long backoff stays in place.
  expect(agentRetryDelay(3, false)).toBe(600000);
});

it("the scheduled self-test retry also shortens when a message is queued", async () => {
  const source = fs.readFileSync(new URL("../apps/core/app.ts", import.meta.url), "utf8");
  const retry = source.slice(source.indexOf("const delay = agentRetryDelay("));
  // The retry timer must read pending inputs, otherwise a queued message waits
  // the full ten-minute circuit timeout.
  expect(retry.slice(0, 200)).toContain("pendingInputs()");
  expect(source).not.toContain("agentStatus.consecutive_failures>=3?600000");
});
