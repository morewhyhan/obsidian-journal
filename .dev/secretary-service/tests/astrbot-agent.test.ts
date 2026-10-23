import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { AstrBotClient } from "../apps/core/agent-client.js";
import type { Input } from "../packages/contracts/types.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const input: Input = {
  id: "astrbot-test",
  channel: "core",
  actor_ref: "self-test",
  external_id: "astrbot-test",
  text: "只返回discussion=ready，不创建事项",
  occurred_at: new Date().toISOString(),
};

it("AstrBot client accepts only the Core proposal contract", async () => {
  const server = createServer(async (_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        action_groups: [],
        clarification: null,
        reply_intent: "discussion",
        discussion: "ready",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + (server.address() as any).port;
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  const client = new AstrBotClient(url, "bridge-token", 2000);
  cleanups.push(async () => client.close());
  const result = await client.interpret(input, {});
  expect(result.reply_intent).toBe("discussion");
  expect(result.action_groups).toHaveLength(0);
});
