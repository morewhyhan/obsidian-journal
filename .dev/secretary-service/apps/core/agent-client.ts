import type { AgentAdapter, AgentResult } from "./core.js";
import type { Input } from "../../packages/contracts/types.js";
import { AppError } from "../../packages/contracts/types.js";
function valid(result: any): result is AgentResult {
  return (
    result &&
    Array.isArray(result.action_groups) &&
    result.action_groups.length <= 20 &&
    result.action_groups.every(
      (g: any) =>
        g &&
        typeof g.action_identity === "string" &&
        Array.isArray(g.actions) &&
        g.actions.length <= 20 &&
        g.actions.every(
          (a: any) => a && typeof a === "object" && typeof a.type === "string",
        ),
    ) &&
    (result.clarification === null ||
      (typeof result.clarification === "string" &&
        result.clarification.length <= 300)) &&
    ["receipt", "proposal", "clarification", "discussion"].includes(
      result.reply_intent,
    ) &&
    (result.summary === undefined ||
      (typeof result.summary === "string" && result.summary.length <= 2000)) &&
    (result.action_groups.length > 0 ||
      !!result.clarification?.trim() ||
      !!result.discussion?.trim() ||
      !!result.summary?.trim()) &&
    (result.discussion === undefined ||
      (typeof result.discussion === "string" &&
        result.discussion.length <= 12000))
  );
}
export class AstrBotClient implements AgentAdapter {
  private shutdown = new AbortController();
  constructor(
    private url: string,
    private token: string,
    private timeoutMs = 30000,
    private instructions = "",
    private limits = { maxTools: 16, composeTimeoutMs: 10000 },
  ) {}
  close() {
    this.shutdown.abort();
  }
  async interpret(input: Input, context: unknown): Promise<AgentResult> {
    const timeout = input.id === "model-self-test" ? 30000 : this.timeoutMs;
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(timeout),
    ]);
    {
      const response = await fetch(this.url + "/interpret", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + this.token,
        },
        body: JSON.stringify({
          input,
          context,
          instructions: this.instructions,
          limits: { max_tools: this.limits.maxTools, timeout_ms: timeout },
        }),
        signal,
      });
      if (!response.ok)
        throw new AppError("AGENT_UNAVAILABLE", "理解服务暂时不可用", 503);
      let result: unknown;
      try {
        result = await response.json();
      } catch {
        result = null;
      }
      if (valid(result)) return result;
    }
    throw new AppError(
      "AGENT_INVALID",
      "理解服务返回了无效结构，未重放请求；已执行操作以回执为准",
      503,
    );
  }
  async check() {
    const health = await fetch(this.url + "/healthz", {
      headers: { Authorization: "Bearer " + this.token },
      signal: AbortSignal.timeout(3000),
    });
    if (!health.ok)
      throw new AppError("AGENT_STARTING", "Agent服务仍在启动", 503);
    const result = await this.interpret(
      {
        id: "model-self-test",
        channel: "core",
        actor_ref: "self-test",
        external_id: "self-test",
        text: "模型协议自检：只调用submit_proposal一次，action_groups为空，clarification为null，reply_intent为discussion，discussion为ready。不得创建事项。",
        occurred_at: new Date().toISOString(),
      },
      {
        items: [],
        plans: [],
        controls: [],
        business_date: new Date().toISOString().slice(0, 10),
      },
    );
    if (
      result.action_groups.length ||
      result.clarification !== null ||
      result.discussion !== "ready"
    )
      throw new AppError(
        "MODEL_SELF_TEST_FAILED",
        "模型未通过受限工具协议自检",
        503,
      );
  }
  async compose(facts: unknown) {
    const response = await fetch(this.url + "/compose", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + this.token,
      },
      body: JSON.stringify({
        facts,
        instructions: this.instructions,
        limits: { timeout_ms: this.limits.composeTimeoutMs },
      }),
      signal: AbortSignal.any([
        this.shutdown.signal,
        AbortSignal.timeout(this.limits.composeTimeoutMs),
      ]),
    });
    if (!response.ok)
      throw new AppError("AGENT_UNAVAILABLE", "文案服务不可用", 503);
    const result = (await response.json()) as { text: string };
    if (
      typeof result.text !== "string" ||
      !result.text.trim() ||
      result.text.length > 250
    )
      throw new AppError("AGENT_INVALID", "文案不符合短回复要求", 503);
    return result;
  }
}

// Kept as a source-compatible name for fixture tests and downstream callers;
