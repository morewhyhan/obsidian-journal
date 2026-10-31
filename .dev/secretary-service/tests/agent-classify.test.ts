import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { afterEach, expect, it } from "vitest";
import { AstrBotClient } from "../apps/core/agent-client.js";
import { ACT_AFFECTS, ACT_KINDS, ACT_RELATIONS } from "../apps/core/classification.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function bridge(handler: (body: any, res: http.ServerResponse) => void) {
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => handler(raw ? JSON.parse(raw) : null, response));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  return "http://127.0.0.1:" + address.port;
}

it("C2 the HTTP adapter publishes classification items and tolerates an older bridge", async () => {
  const url = await bridge((body, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      items: [
        { input_id: body.inputs[0].id, interpretation: { acts: [] } },
        { input_id: "not-asked", interpretation: { acts: [] } },
        { interpretation: { acts: [] } },
      ],
    }));
  });
  const client = new AstrBotClient(url, "token", 5000);
  const result = await client.classify([{ id: "a", text: "在吗", occurred_at: "2026-10-31T00:00:00Z" }]);
  // Unknown or malformed items are dropped instead of being trusted.
  expect(result?.items).toHaveLength(1);
  expect(result?.items[0].input_id).toBe("a");
});

it("C2 a bridge without the classify route means \"not supported\", not \"nothing to understand\"", async () => {
  const url = await bridge((_body, response) => {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
  });
  const client = new AstrBotClient(url, "token", 5000);
  expect(await client.classify([{ id: "a", text: "在吗", occurred_at: "2026-10-31T00:00:00Z" }])).toBeNull();
});

it("C2 an unusable classifier response is an error, never an empty success", async () => {
  const url = await bridge((_body, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ items: "nope" }));
  });
  const client = new AstrBotClient(url, "token", 5000);
  await expect(
    client.classify([{ id: "a", text: "在吗", occurred_at: "2026-10-31T00:00:00Z" }]),
  ).rejects.toMatchObject({ code: "AGENT_INVALID" });
});

it("C2 the bridge prompt and the Core validator list the same values", () => {
  // A drift here would make every real classification fail validation, which then
  // blocks older work — the expensive failure mode this test protects against.
  const source = fs.readFileSync(
    path.join(process.cwd(), "integrations/astrbot/astrbot_plugin_secretary/main.py"),
    "utf8",
  );
  const instruction = source.slice(source.indexOf("classify_secretary"), source.indexOf("async def terminate"));
  for (const value of ACT_KINDS) expect(instruction).toContain(value);
  for (const value of ACT_RELATIONS) expect(instruction).toContain(value);
  for (const value of ACT_AFFECTS) expect(instruction).toContain(value);
  for (const scope of ["explicit", "conversation", "unknown"]) expect(instruction).toContain(scope);
});

it("C2 the prompt tells the model how to act on a planning gap", () => {
  // The gap is useless if the model is never told it exists and how to resolve it.
  const prompt = fs.readFileSync(
    path.join(process.cwd(), "resources/prompts/workflows.md"),
    "utf8",
  );
  expect(prompt).toContain("planning_gap");
  expect(prompt).toContain("day_overrides");
  // Real-model testing caught a wrong-date diary note: keep the rule explicit.
  expect(prompt).toContain("business_date");
  expect(prompt).toContain("不用UTC日期");
  // A crash mid-turn must not turn into "please repeat that".
  expect(prompt).toContain("不要要求用户重说");
  expect(prompt).toContain("buffer_minutes");
});

it("Q8 the operator runbook only names status fields that really exist", () => {
  // Stale runbooks are worse than none: an operator would look in the wrong place.
  const app = fs.readFileSync(path.join(process.cwd(), "apps/core/app.ts"), "utf8");
  for (const field of [
    "last_dispatch",
    "queued_proactive",
    "planning_gap",
    "recovery_until",
    "unfinished_recovery",
    "model_budget",
  ])
    expect(app).toContain(field);
  const core = fs.readFileSync(path.join(process.cwd(), "apps/core/core.ts"), "utf8");
  for (const field of ["understood_seq", "uninterpreted_inputs"]) expect(core).toContain(field);
});

it("C1 the prompt carries the conversation rhythm rules that keep replies natural", () => {
  const prompt = fs.readFileSync(
    path.join(process.cwd(), "resources/prompts/workflows.md"),
    "utf8",
  );
  // Answer first, one purpose per message, no canned "still working", no re-asking.
  expect(prompt).toContain("## 交流节奏");
  expect(prompt).toContain("先答用户当前问的那件事");
  expect(prompt).toContain("不为了表示在办而先说");
  expect(prompt).toContain("不能把没发出的内容当成用户已经看过");
  expect(prompt).toContain("等了一会儿不等于必须说话");
  expect(prompt).toContain("用户插话后，先处理新话");
});
