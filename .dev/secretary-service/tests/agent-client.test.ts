import { afterEach, it, expect, vi } from "vitest";
import { AstrBotClient } from "../apps/core/agent-client.js";
import { loadConfig } from "../apps/core/config.js";
import { atomicWrite } from "../apps/core/files.js";
import { temporary, removeTemporary } from "./helpers.js";
import path from "node:path";
afterEach(() => vi.unstubAllGlobals());
const input = {
  id: "normal",
  channel: "web",
  actor_ref: "user",
  external_id: "normal",
  text: "创建日记",
  occurred_at: new Date().toISOString(),
};
it("configuration cannot advertise a tool policy different from the registered SDK catalog", () => {
  const root = temporary();
  try {
    atomicWrite(
      path.join(root, ".agent/config.json"),
      JSON.stringify({ agent: { allowed_tools: ["get_context", "shell"] } }),
    );
    expect(() => loadConfig(root)).toThrow("配置与 v1");
  } finally {
    removeTemporary(root);
  }
});
it("invalid result never replays an agent request that might already have written files", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          action_groups: [],
          clarification: null,
          reply_intent: "discussion",
        }),
      ),
    );
  vi.stubGlobal("fetch", fetch);
  await expect(
    new AstrBotClient("http://astrbot", "token").interpret(input, {}),
  ).rejects.toMatchObject({ code: "AGENT_INVALID" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("configured call and compose limits reach the adapter and startup waits for health", async () => {
  const bodies: any[] = [];
  const fetch = vi.fn(async (url: string, opts: any) => {
    if (url.endsWith("/healthz")) return new Response("{}", { status: 503 });
    bodies.push(JSON.parse(opts.body));
    return new Response(
      JSON.stringify(
        url.endsWith("/compose")
          ? { text: "收到" }
          : {
              action_groups: [],
              clarification: null,
              reply_intent: "discussion",
              discussion: "说明",
            },
      ),
    );
  });
  vi.stubGlobal("fetch", fetch);
  const client = new AstrBotClient("http://astrbot", "token", 60000, "rules", {
    maxTools: 8,
    composeTimeoutMs: 5000,
  });
  await client.interpret(input, {});
  await client.compose({});
  expect(bodies[0].limits).toEqual({ max_tools: 8, timeout_ms: 60000 });
  expect(bodies[1].limits.timeout_ms).toBe(5000);
  await expect(client.check()).rejects.toMatchObject({
    code: "AGENT_STARTING",
  });
  expect(fetch).toHaveBeenCalledTimes(3);
});
