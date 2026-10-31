import { afterEach, it, expect, vi } from "vitest";
import { AstrBotClient, SELF_TEST_TIMEOUT_MS } from "../apps/core/agent-client.js";
import { loadConfig } from "../apps/core/config.js";
import { atomicWrite, hash } from "../apps/core/files.js";
import { AGENT_TOOLS } from "../packages/contracts/agent-tools.js";
import { temporary, removeTemporary } from "./helpers.js";
import path from "node:path";
import fs from "node:fs";
afterEach(() => vi.unstubAllGlobals());
const SENT_TEXT = (body: any) => String(body?.input?.text ?? "");
const input = {
  id: "normal",
  channel: "web",
  actor_ref: "user",
  external_id: "normal",
  text: "创建日记",
  occurred_at: new Date().toISOString(),
};
it("AstrBot's shipped tool catalog matches the Core contract", () => {
  const file = path.resolve("integrations/astrbot/astrbot_plugin_secretary/tools.json");
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(AGENT_TOOLS);
});
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
it("failure diagnostics keep safe categories without replay or arbitrary server error text", async () => {
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{code:"AGENT_INVALID",reason:"ValueError",message:"PRIVATE_TOKEN_AND_NOTES"}}),{status:503}));
  vi.stubGlobal("fetch",fetch);
  const error=await new AstrBotClient("http://astrbot","token").interpret(input,{}).catch(e=>e);
  expect(error).toMatchObject({code:"AGENT_INVALID",details:{reason:"ValueError"}});
  expect(error.message).not.toContain("PRIVATE");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("a full model input budget is reported as such and never as an unreachable agent", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "MODEL_INPUT_LIMIT",
            reason: "ValueError",
            message: "PRIVATE_PROMPT_TEXT",
          },
        }),
        { status: 503 },
      ),
    );
  vi.stubGlobal("fetch", fetch);
  const error = await new AstrBotClient("http://astrbot", "token")
    .interpret(input, {})
    .catch((e) => e);
  expect(error).toMatchObject({ code: "MODEL_INPUT_LIMIT", details: { reason: "ValueError" } });
  expect(error.message).not.toContain("PRIVATE");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("startup self-test does not ask native mode for a legacy tool call and accepts a plain answer", async () => {
  const sent: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, opts: any) => {
    if (url.endsWith("/healthz"))
      return new Response(JSON.stringify({ protocol: "tools-v2", tools_hash: hash(JSON.stringify(AGENT_TOOLS)) }));
    sent.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({
      action_groups: [], clarification: null, reply_intent: "discussion",
      discussion: "好的，自检通过。",
    }));
  }));
  const client = new AstrBotClient("http://astrbot", "token", 30000, "");
  await expect(client.check()).resolves.toBeUndefined();
  expect(SENT_TEXT(sent[0])).not.toContain("submit_proposal");
});
it("wording calls receive the communication view while execution keeps the protocol", async () => {
  const bodies: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, opts: any) => {
    bodies.push(JSON.parse(opts.body));
    return new Response(JSON.stringify(url.endsWith("/compose")
      ? { text: "好的" }
      : { action_groups: [], clarification: null, reply_intent: "discussion", discussion: "好" }));
  }));
  const client = new AstrBotClient("http://astrbot", "token", 1000, "EXEC_PROTOCOL");
  client.communication = "PERSONA_ONLY";
  await client.interpret(input, {});
  await client.compose({});
  expect(bodies[0].instructions).toBe("EXEC_PROTOCOL");
  expect(bodies[0].communication).toBe("PERSONA_ONLY");
  expect(bodies[1].instructions).toBe("PERSONA_ONLY");
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

it("the model self-test gets a longer leash than a normal turn", () => {
  // A warm-up timeout right after a bridge restart used to mute the assistant
  // until the retry cycle; the probe must tolerate a slower first answer.
  expect(SELF_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(45000);
  expect(SELF_TEST_TIMEOUT_MS).toBeLessThanOrEqual(60000);
});
