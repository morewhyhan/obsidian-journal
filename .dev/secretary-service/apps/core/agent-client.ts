import type { AgentAdapter, AgentResult } from "./core.js";
import type { Input } from "../../packages/contracts/types.js";
import { AppError } from "../../packages/contracts/types.js";
import {AGENT_TOOLS} from "../../packages/contracts/agent-tools.js";
import {hash} from "./files.js";
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
  readonly executionMode = "tools-v2" as const;
  /** Persona-and-facts view without the tool protocol, for wording calls. */
  communication = "";
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
    const timeout = input.id === "model-self-test" ? 30000 : input.channel==="coordinator"?Math.min(60000,this.timeoutMs):this.timeoutMs;
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
          communication: this.communication || this.instructions,
          limits: { max_tools: this.limits.maxTools, timeout_ms: timeout },
          execution_mode: input.id === "model-self-test" || input.channel === "coordinator" && !(context as any)?.background_grant ? "legacy" : this.executionMode,
        }),
        signal,
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as any;
        // Model-side failures stay distinguishable from an unreachable bridge:
        // a full input budget is a design signal, not a transport outage.
        const code = [
          "AGENT_BUSY",
          "BRIDGE_TIMEOUT",
          "AGENT_INVALID",
          "TOOL_LIMIT",
          "MODEL_INPUT_LIMIT",
          "MODEL_PROVIDER_FAILED",
          "MODEL_INVALID_FINAL",
        ].includes(failure?.error?.code)
          ? failure.error.code
          : "AGENT_UNAVAILABLE";
        const reason = /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(failure?.error?.reason ?? "") ? failure.error.reason : null;
        throw new AppError(code, "理解服务暂时不可用，已执行操作以回执为准", 503, { reason });
      }
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
    const contract=await health.json() as any;
    if(contract.protocol!=="tools-v2" || contract.tools_hash!==hash(JSON.stringify(AGENT_TOOLS)))
      throw new AppError("AGENT_CONTRACT_MISMATCH","Core与插件工具合同不兼容，未调用模型",503);
    const result = await this.interpret(
      {
        id: "model-self-test",
        channel: "core",
        actor_ref: "self-test",
        external_id: "self-test",
        // Native mode has no submit_proposal tool; asking for one made the
        // model explain the mismatch instead of answering, and the failed
        // self-test then disabled the agent for every incoming message.
        text: "模型协议自检：不要调用任何工具，也不要创建或修改任何事项；直接回复 ready，action_groups 为空，clarification 为 null，reply_intent 为 discussion。",
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
      !(result.discussion ?? "").trim() ||
      (result.discussion ?? "").length > 200
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
        instructions: this.communication || this.instructions,
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
      result.text.length > 1800
    )
      throw new AppError("AGENT_INVALID", "文案不符合短回复要求", 503);
    return result;
  }
}

// Kept as a source-compatible name for fixture tests and downstream callers;
