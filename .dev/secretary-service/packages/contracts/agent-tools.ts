import { proposalSchema } from "./api.js";
// One catalog for AstrBot's restricted tool set and the model proxy.
// from user notes, extensions or a model-provided URL.
export const AGENT_TOOL_NAMES = [
  "get_context",
  "secretary",
  "submit_proposal",
  "workspace",
] as const;

const string = { type: "string" };
const properties = (
  fields: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: "object",
  properties: fields,
  required,
  additionalProperties: false,
});
// The model must deliberately distinguish a numeric minimum from an optional
// target. Keep the public Core API compatible with older clients.
const agentProposalSchema: any = structuredClone(proposalSchema);
const agentAction =
  agentProposalSchema.properties.action_groups.items.properties.actions.items;
agentAction.properties.target_id.description = "操作对象：reschedule用安排plan.id及该安排版本；update_task/configure_task/report_execution/report_habit使用对应事项id。改期不能把task.id放target_id再附plan_id。";
agentAction.properties.planning.description = "任务执行设计：create_task/update_task/configure_task的next_action、remaining_minutes、blocker必须写在此对象，不能放动作顶层。reschedule的next_action则在动作顶层。";
agentAction.properties.work.description = "save_work保存跨会话的当前共识、未决问题与接续责任，不创建任务。key为稳定短英文键，owner=assistant/user/condition，check_at是已约定或授权范围内的未来检查；等用户且不催则为null。更新先查followups取target_id/version；结束用control_work.stop。";
// Core owns automatic diary projection and approval expansion. Exposing the
// maintenance actions here lets the model invent redundant, invalid bindings.
agentAction.properties.type.enum = agentAction.properties.type.enum.filter(
  (type: string) => !["accept_proposal", "link_diary", "project_diary"].includes(type),
);
agentAction.properties.minimum_quantity = {
  ...agentAction.properties.minimum_quantity,
  description:
    "新建习惯必须显式填写：用户约定最低10个词则为{value:10,unit:'词'}；没有数量门槛填null。可选目标只写optional_target，不能代替最低数量。",
};
agentAction.properties.reminder_mode = {
  enum: ["window", "opportunistic", "off"],
  description:
    "新习惯必须明确选择：用户明确要固定提示才用window；只在空闲时顺带提示用opportunistic；不联系用off。机会窗口不是固定闹钟。",
};
agentAction.allOf.push({
  if: { properties: { type: { const: "create_habit" } } },
  then: { required: ["minimum_quantity", "reminder_mode"] },
});
export const AGENT_TOOLS = [
  {
    name: "secretary",
    description:
      "私人助理业务工具。state/day/planning查实际任务、安排与版本；conversation取完整近期对话，预载缺失时主动查。apply_changes直接办理用户已交代或已接受的任务、习惯、排程、规则，结果立即返回，可修正后继续。save_proposals只保存尚待取舍的建议。resolve_proposals按已读提案id/version接受、暂缓、拒绝或修订后接受，可一次决定多项，不重复新建。create_period按Template创建并补父级。rules/preferences/followups/automations/focus查长期规则和进展。",
    parameters: properties(
      {
        operation: {
          enum: [
            "apply_changes", "save_proposals", "resolve_proposals", "conversation",
            "rules",
            "automations",
            "focus",
            "board",
            "planning_context",
            "preferences",
            "followups",
            "planning",
            "capabilities",
            "periods",
            "create_period",
            "state",
            "day",
            "status",
            "trash",
            "restore_note",
            "history",
            "history_content",
            "restore_version",
          ],
        },
        kind: { enum: ["daily", "weekly", "monthly", "quarterly", "yearly"] },
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        scope: {
          enum: ["all", "habits", "tasks", "plans", "controls", "proposals"],
        },
        query: string,
        ids: { type: "array", items: string },
        offset: { type: "integer", minimum: 0 },
        path: string,
        recovery_id: string,
        commit: string,
        base_hash: string,
        summary: { type: "string", maxLength: 500 },
        commit_mode: {
          enum: ["independent_groups", "all_or_nothing"],
          description: "默认独立事项逐组办理；用户明确要求整批一起成功或全不做才用all_or_nothing。共享对象的修改由Core合并提交，不猜中间版本。",
        },
        action_groups: agentProposalSchema.properties.action_groups,
        decisions: { type: "array", minItems: 1, maxItems: 20, items: properties({
          target_id: string, expected_version: { type: "integer", minimum: 1 },
          decision: { enum: ["accept", "reject", "defer"] },
          action_indices: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: { type: "integer", minimum: 0 } },
          replacements: { type: "array", minItems: 1, maxItems: 20, items: agentAction },
        }, ["target_id", "expected_version", "decision"]) },
      },
      ["operation"],
    ),
  },
  {
    name: "workspace",
    description:
      "真实授权仓库文件工具：list/search/read/write/edit/rename/delete。直接自主查找读取，无需预附清单；offset分页。已有文件修改先read拿hash。禁止库外与隐藏文件；内部记忆仅.agent/context/memory.md；新周期笔记必须secretary.create_period。",
    parameters: properties(
      {
        operation: {
          enum: ["list", "search", "read", "write", "edit", "rename", "delete"],
        },
        path: string,
        query: string,
        content: string,
        old_text: string,
        new_text: string,
        new_path: string,
        base_hash: string,
        offset: { type: "integer", minimum: 0 },
      },
      ["operation"],
    ),
  },
  {
    name: "get_context",
    description:
      "读取本次已授权事项，空ids返回预载对象；完整台账使用secretary.state。",
    parameters: properties(
      { ids: { type: "array", items: string }, purpose: string },
      ["ids", "purpose"],
    ),
  },
  {
    name: "submit_proposal",
    description:
      "一次提交最终答复与业务动作；discussion写给用户的回答，action_groups交Core校验执行。提案接收不等于已执行。没有动作时也须提供实际答复。",
    parameters: agentProposalSchema,
  },
] as const;
