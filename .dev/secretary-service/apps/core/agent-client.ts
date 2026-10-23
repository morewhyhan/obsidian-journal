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
    typeof result.reply_intent === "string" &&
    (result.discussion === undefined ||
      (typeof result.discussion === "string" &&
        result.discussion.length <= 12000))
  );
}
export class PiClient implements AgentAdapter {
  private shutdown = new AbortController();
  constructor(
    private url: string,
    private token: string,
    private timeoutMs = 30000,
    private instructions = "",
  ) {}
  close() {
    this.shutdown.abort();
  }
  async interpret(input: Input, context: unknown): Promise<AgentResult> {
    const timeout = /^(?:\/讨论 |(?:帮我|请)?(?:分析|研究|讨论|比较))/.test(
      input.text,
    )
      ? 120000
      : this.timeoutMs;
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(timeout),
    ]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(this.url + "/interpret", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + this.token,
        },
        body: JSON.stringify({
          input,
          context,
          instructions:
            this.instructions +
            (attempt
              ? "\n上次候选结构无效。请在原输入范围内修复一次，必须提交有效提案；不能扩大权限。"
              : ""),
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
      "理解服务返回了无效结构，暂未执行",
      503,
    );
  }
  async check() {
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
      body: JSON.stringify({ facts, instructions: this.instructions }),
      signal: AbortSignal.any([
        this.shutdown.signal,
        AbortSignal.timeout(10000),
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
