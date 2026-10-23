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
export const AGENT_TOOLS = [
  {
    name: "secretary",
    description:
      "原生应用功能：create_period使用Template统一引擎生成日周月季年笔记及父计划；state完整查询台账；periods路径；day事实；status运行状态；preferences偏好；trash/restore_note恢复；history/history_content/restore_version版本。不猜字段，不要求打开Obsidian。只有用户要求才创建或恢复。",
    parameters: properties(
      {
        operation: {
          enum: [
            "preferences",
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
    parameters: proposalSchema,
  },
] as const;
