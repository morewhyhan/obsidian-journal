import { createServer } from "node:http";
import { it, expect } from "vitest";
import { interpretWithPi } from "../apps/pi-adapter/agent.js";
it("A01 Pi SDK exposes only authorized tools and returns a non-executing structured proposal", async () => {
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    expect(request.headers.authorization).toBe("Bearer internal-test-token");
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    const proposal = {
      action_groups: [],
      clarification: "你指英语还是报告？",
      reply_intent: "clarification",
    };
    const delta =
      requests.length === 1
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_proposal",
                type: "function",
                function: {
                  name: "submit_proposal",
                  arguments: JSON.stringify(proposal),
                },
              },
            ],
          }
        : { role: "assistant", content: "提案已提交，等待 Core 验证。" };
    response.write(
      "data: " +
        JSON.stringify({
          id: "mock",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
          choices: [{ index: 0, delta, finish_reason: null }],
        }) +
        "\n\n",
    );
    response.write(
      "data: " +
        JSON.stringify({
          id: "mock",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: requests.length === 1 ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
        }) +
        "\n\n",
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    const result = await interpretWithPi(
      {
        id: "input",
        channel: "web",
        actor_ref: "user",
        external_id: "input",
        text: "完成了",
        occurred_at: "2026-10-23T12:00:00Z",
      },
      { items: [], business_date: "2026-10-23", now: "2026-10-23T12:00:00Z" },
      "你是私人秘书。",
      {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        token: "internal-test-token",
        modelId: "test-model",
        timeoutMs: 10000,
      },
    );
    expect(result.clarification).toBe("你指英语还是报告？");
    expect(requests[0].tools.map((x: any) => x.function.name).sort()).toEqual([
      "get_context",
      "submit_proposal",
    ]);
    expect(result.action_groups).toEqual([]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20000);
