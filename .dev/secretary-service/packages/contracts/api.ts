import type { FastifyInstance } from "fastify";
import { actionFields } from "./action-fields.js";
import { workInputJsonSchema } from "./work.js";
import {
  HABIT_STATUSES,
  HABIT_OCCURRENCE_STATUSES,
  TASK_UPDATE_STATUSES,
  CRITERION_STATUSES,
} from "./types.js";
const string = (maxLength = 1024) => ({
  type: "string",
  minLength: 1,
  maxLength,
});
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const object = (
  properties: Record<string, unknown>,
  required: string[] = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });
const date = { ...string(10), pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  time = { type: "string", format: "date-time" },
  version = { type: "integer", minimum: 1 },
  quantity = nullable(
    object({ value: { type: "number", minimum: 0 }, unit: string(30) }),
  );
export const noteRefSchema = object(
  {
    path: string(),
    heading: nullable(string(200)),
    relation: { enum: ["motivation", "plan", "method", "evidence"] },
  },
  ["path", "relation"],
);
export const criterionSchema = object(
  {
    id: string(64),
    kind: { enum: ["check", "count", "artifact"] },
    description: string(2000),
    target: nullable({ type: "number", minimum: 0 }),
    unit: nullable(string(30)),
    verification: { enum: ["self_report", "tool"] },
    artifact_ref: nullable(string()),
    artifact_check: {
      oneOf: [
        object({ kind: { const: "exists_nonempty" } }),
        object({ kind: { const: "contains_all" }, terms: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: string(500) } }),
      ],
    },
  },
  ["kind", "description"],
);
const recurrence = object(
  {
    weekdays: {
      type: "array",
      minItems: 1,
      maxItems: 7,
      uniqueItems: true,
      items: { type: "integer", minimum: 1, maximum: 7 },
    },
    starts_on: date,
    ends_on: nullable(date),
  },
  ["weekdays", "starts_on"],
);
const anchor = {
  oneOf: [
    object({
      kind: { const: "time_window" },
      local_start: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
      local_end: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
    }),
    object({ kind: { const: "event" }, event_key: string(100) }),
  ],
};
const initialPlan = {
  ...object(
    {
      window_start: time,
      window_end: time,
      duration_minutes: { type: "number", exclusiveMinimum: 0 },
      next_action: string(2000),
      kind: { enum: ["fixed", "window", "flexible"], description: "普通任务的时间块用window；fixed仅用于用户明确不能移动的预约或承诺。给出起止时刻本身不代表不可调整。" },
      allow_reflow: { type: "boolean" },
      overdue_recovery:{type:"boolean"},
    },
    ["window_start", "window_end", "duration_minutes", "next_action"],
  ),
  description:
    "用户同时交代新任务和执行时间时放在这里，Core原子创建任务与安排；不要猜测尚未生成的任务ID。没有明确窗口则省略，不承诺已经安排提醒。",
};
const localWindow = object({
  start: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
  end: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
});
const weeklyWindow = object({
  ...localWindow.properties,
  weekdays: recurrence.properties.weekdays,
});
const blocker = nullable(
  object({
    kind: {
      enum: [
        "time",
        "scope",
        "resource",
        "ability",
        "waiting",
        "health",
        "priority",
      ],
    },
    detail: string(500),
    review_at: nullable(time),
  }),
);
const taskPlanning = object(
  {
    category: nullable(string(80)),
    enabled: { type: "boolean" },
    next_action: nullable(string(500)),
    remaining_minutes: nullable({
      type: "integer",
      minimum: 0,
      maximum: 100000,
    }),
    priority: { type: "integer", minimum: 1, maximum: 3 },
    depends_on: {
      type: "array",
      maxItems: 30,
      uniqueItems: true,
      items: string(100),
    },
    not_before: nullable(time),
    allow_split: { type: "boolean" },
    blocker,
  },
  [],
);
const planningPreferences = object(
  {
    enabled: { type: "boolean" },
    auto_create_daily: { type: "boolean" },
    evening_time: localWindow.properties.start,
    availability: { type: "array", maxItems: 32, items: weeklyWindow },
    protected: { type: "array", maxItems: 32, items: weeklyWindow },
    day_overrides: {
      type: "array",
      maxItems: 62,
      // windows is optional: lowering one day's reserve should not require
      // restating that day's availability.
      items: object(
        {
          date,
          windows: { type: "array", maxItems: 32, items: localWindow },
          buffer_minutes: { type: ["integer", "null"], minimum: 0, maximum: 120 },
        },
        ["date"],
      ),
    },
    buffer_minutes: { type: "integer", minimum: 0, maximum: 120 },
    max_task_minutes: { type: "integer", minimum: 1, maximum: 960 },
    max_tasks: { type: "integer", minimum: 1, maximum: 20 },
    risk_horizon_days: { type: "integer", minimum: 1, maximum: 31 },
    stale_days: { type: "integer", minimum: 1, maximum: 90 },
    postponement_threshold: { type: "integer", minimum: 2, maximum: 10 },
  },
  [],
);
const types = [
  "save_work", "control_work",
  "set_personal_rule",
  "control_rule",
  "undo_rule",
  "create_automation",
  "update_automation",
  "control_automation",
  "report_automation",
  "start_focus",
  "pause_focus",
  "resume_focus",
  "stop_focus",
  "set_period_focus",
  "set_planning",
  "configure_task",
  "report_execution",
  "plan_day",
  "reject_proposal",
  "create_habit",
  "update_habit",
  "create_task",
  "update_task",
  "report_habit",
  "report_event",
  "update_task_progress",
  "complete_task",
  "reopen_task",
  "schedule",
  "reschedule",
  "pause_contact",
  "resume_contact",
  "cancel_item",
  "remember_fact",
  "forget_fact",
  "link_diary",
  "project_diary",
];
export const actionSchema = {
  ...object(
    {
      type: { enum: types },
      work: workInputJsonSchema,
      key: string(80),
      enabled: { type: "boolean" },
      reminder_mode: { enum: ["window", "opportunistic", "off"] },
      starts_at: time,
      performed_at: { ...nullable(time), description: "行为/任务反馈的实际发生时刻，带时区；business_date为所属日期。报告时间由Core另记；未知不猜。" },
      fact_subject: string(200),
      fact_scope: { type: "array", maxItems: 8, minItems: 1, uniqueItems: true, items: string(60) },
      valid_until: nullable(time),
      supersedes: nullable(string(100)),
      expected_rules_revision: { type: "integer", minimum: 0 },
      timezone: string(80),
      delay_seconds: { type: "integer", minimum: 1, maximum: 2678400 },
      body: string(1000),
      to_diary: { type: "boolean" },
      status_check: {
        type: "boolean",
        description: "这是“看看用户现在在做什么”的状态检查：一旦近期聊天或记录已经说明近况，就不发出这一轮；只有长时间没有任何动静时才问。",
      },
      strict: { type: "boolean" },
      control: { enum: ["pause", "resume", "stop", "skip_today", "complete"] },
      occurrence_id: string(100),
      task_ref: nullable(string(100)),
      work_minutes: { type: "integer", minimum: 1, maximum: 120 },
      break_minutes: { type: "integer", minimum: 1, maximum: 120 },
      rounds: { type: "integer", minimum: 1, maximum: 12 },
      content: string(2000),
      replace_section: { type: "boolean" },
      base_hash: string(100),
      schedule: object(
        {
          weekdays: recurrence.properties.weekdays,
          starts_on: date,
          ends_on: nullable(date),
          local_start: localWindow.properties.start,
          local_end: localWindow.properties.end,
          minute: { type: "integer", minimum: 0, maximum: 59 },
          every_hours: { type: "integer", minimum: 1, maximum: 24 },
        },
        ["weekdays", "starts_on", "local_start", "local_end"],
      ),
      planning: taskPlanning,
      preferences: planningPreferences,
      expected_planning_version: { type: "integer", minimum: 0 },
      effort_minutes: { type: "integer", minimum: 0, maximum: 1440 },
      execution: {
        enum: ["started", "progress", "not_started", "not_done", "blocked"],
      },
      remaining_minutes: { type: "integer", minimum: 0, maximum: 100000 },
      blocker,
      plan_id: string(100),
      allow_reflow: { type: "boolean" },
      overdue_recovery:{type:"boolean",description:"仅用户明确选择逾期补救时为true；保留原硬截止和逾期事实，不能用于悄悄消除冲突。"},
      target_id: string(100),
      expected_version: version,
      title: string(200),
      min_behavior: string(500),
      minimum_quantity: quantity,
      optional_target: quantity,
      recurrence,
      anchor,
      status: {
        ...string(30),
        enum: [
          ...new Set([
            ...HABIT_STATUSES,
            ...HABIT_OCCURRENCE_STATUSES,
            ...TASK_UPDATE_STATUSES,
            ...CRITERION_STATUSES,
          ]),
        ],
        description:
          "report_habit：做了=did、没做=did_not、跳过=skipped、未确认=unreported。不能用completed/done代替习惯事实；任务完成用complete_task。",
      },
      note_refs: { type: "array", maxItems: 12, items: noteRefSchema },
      outcome: string(2000),
      acceptance: { type: "array", maxItems: 20, items: criterionSchema },
      due_at: nullable(time),
      verification: { enum: ["self_report", "tool"] },
      parent_task_id: nullable(string(100)),
      supporting_habit_ids: { type: "array", maxItems: 20, items: string(100) },
      business_date: date,
      quantity,
      optional_target_met: nullable({ type: "boolean" }),
      event_key: string(100),
      criterion_id: string(64),
      value: {
        anyOf: [
          { type: "null" },
          { type: "number", minimum: 0 },
          { type: "string", maxLength: 1000 },
          { type: "boolean" },
          { type: "array", maxItems: 128 },
          { type: "object" },
        ],
      },
      unit: string(30),
      mode: { enum: ["total", "increment"] },
      report: string(500),
      task_status: { enum: ["in_progress", "blocked"] },
      verification_pending: { type: "boolean" },
      window_start: time,
      window_end: time,
      available_windows: {
        type: "array",
        minItems: 1,
        maxItems: 24,
        items: object({ start: time, end: time }),
      },
      duration_minutes: { type: "number", exclusiveMinimum: 0 },
      next_action: string(2000),
      initial_plan: initialPlan,
      kind: { ...string(100), description: "create_automation：one_shot一次消息；recurring按所选日期每天仅在local_start发生一次；hourly_checkin按小时回顾；status_check按小时检查近况。每小时/每两小时不能使用recurring，更不能删掉minute来掩盖用户要的频率。其他动作按各自kind枚举。" },
      ends_at: time,
      fact: string(500),
      path: string(),
      label: string(500),
    },
    ["type"],
  ),
};
Object.assign(actionSchema, {
  allOf: [
    ...Object.entries(actionFields).map(([type,fields])=>({
      if:{properties:{type:{const:type}}},then:{propertyNames:{enum:fields}},
    })),
    ...Object.entries({
      create_habit: ["draft", "active"],
      update_habit: HABIT_STATUSES,
      create_task: ["draft", "ready"],
      update_task: TASK_UPDATE_STATUSES,
      report_habit: HABIT_OCCURRENCE_STATUSES,
      update_task_progress: CRITERION_STATUSES,
    }).map(([type, statuses]) => ({
      if: { properties: { type: { const: type } } },
      then: { properties: { status: { enum: statuses } } },
    })),
    {
      if: {
        properties: {
          type: { const: "create_task" },
          status: { const: "ready" },
        },
      },
      then: {
        properties: { acceptance: { type: "array", minItems: 1 } },
        required: ["acceptance"],
      },
    },
    {
      if: { properties: { type: { enum: ["schedule", "reschedule"] } } },
      then: { properties: { kind: { enum: ["fixed", "window", "flexible"] } } },
    },
    {
      if: { properties: { type: { const: "remember_fact" } } },
      then: { properties: { kind: { const: "user_confirmed" } } },
    },
    {
      if: { properties: { type: { enum: ["create_automation", "update_automation"] } } },
      then: {
        properties: { kind: { enum: ["one_shot", "recurring", "hourly_checkin", "status_check"] } },
        allOf: [{
          if: { properties: { kind: { const: "recurring" } }, required: ["kind"] },
          then: { properties: { schedule: { not: { anyOf: [{ type: "object", required: ["minute"] }, { type: "object", required: ["every_hours"] }] } } } },
        }, {
          if: { properties: { type: { const: "create_automation" }, kind: { const: "one_shot" } }, required: ["kind"] },
          then: { oneOf: [
            { required: ["delay_seconds"], properties: { due_at: { type: "null" } } },
            { required: ["due_at"], properties: { due_at: time }, not: { type: "object", required: ["delay_seconds"] } },
          ] },
        }, {
          if: { properties: { type: { const: "create_automation" }, kind: { enum: ["recurring", "hourly_checkin", "status_check"] } }, required: ["kind"] },
          then: { required: ["schedule"] },
        }, {
          if: { properties: { kind: { enum: ["recurring", "hourly_checkin", "status_check"] } }, required: ["kind"] },
          then: { properties: { due_at: { type: "null" } }, not: { type: "object", required: ["delay_seconds"] } },
        }],
      },
    },
    {
      if: { properties: { type: { const: "set_personal_rule" } } },
      then: {
        properties: { key: { anyOf: [
          { enum: [
            ...Object.keys(planningPreferences.properties).map((key) => "planning." + key),
            "contact.style", "support.style", "contact.quiet_hours", "contact.suggestion_cap", "contact.minimum_gap_minutes",
            "review.weekly_day", "support.review_after_minutes", "contact.enabled", "contact.focus_protection",
            "recording.to_diary", "review.enabled", "support.enabled", "support.allow_prepare_next_action",
          ] }, { type: "string", pattern: "^working\\.[a-z0-9_-]{1,60}$" },
        ] } },
        allOf: [
          ...Object.entries({
            ...Object.fromEntries(Object.entries(planningPreferences.properties).map(([key, schema]) => ["planning." + key, schema])),
            "contact.style": string(300),
            "support.style": { enum: ["direct", "gentle"] },
            "contact.quiet_hours": localWindow,
            "contact.suggestion_cap": { type: "integer", minimum: 0, maximum: 4 },
            "contact.minimum_gap_minutes": { type: "integer", minimum: 60, maximum: 1440 },
            "review.weekly_day": { type: "integer", minimum: 1, maximum: 7 },
            "support.review_after_minutes": { type: "integer", minimum: 60, maximum: 10080 },
            ...Object.fromEntries(["contact.enabled", "contact.focus_protection", "recording.to_diary", "review.enabled", "support.enabled", "support.allow_prepare_next_action"].map((key) => [key, { type: "boolean" }])),
          }).map(([key, schema]) => ({
            if: { properties: { key: { const: key } } }, then: { properties: { value: schema } },
          })),
          {
            if: { properties: { key: { type: "string", pattern: "^working\\." } } },
            then: { properties: { value: object({
              instruction: string(600),
              task_ids: { type: "array", maxItems: 20, items: string(100) },
              categories: { type: "array", maxItems: 20, items: string(100) },
              purpose: { enum: ["all", "planning", "support"] },
            }) } },
          },
        ],
      },
    },
    {
      if: {
        properties: {
          type: {
            enum: [
              "update_habit",
              "update_task",
              "report_habit",
              "report_event",
              "update_task_progress",
              "complete_task",
              "reopen_task",
              "schedule",
              "reschedule",
              "cancel_item",
              "link_diary",
              "project_diary",
              "configure_task",
              "report_execution",
              "reject_proposal",
              "update_automation",
              "control_automation",
              "report_automation",
              "control_rule",
              "undo_rule",
              "pause_focus",
              "resume_focus",
              "stop_focus",
            ],
          },
        },
      },
      then: { required: ["target_id", "expected_version"] },
    },
    ...Object.entries({
      set_personal_rule: ["key", "value", "expected_rules_revision"],
      save_work:["work"],control_work:["target_id","expected_version","control"],
      control_rule: ["enabled", "expected_rules_revision"],
      undo_rule: ["expected_rules_revision"],
      create_automation: ["title", "kind"],
      control_automation: ["control"],
      report_automation: ["business_date", "occurrence_id", "report"],
      set_period_focus: ["kind", "business_date", "content", "base_hash"],
      create_habit: ["title", "min_behavior", "recurrence", "anchor"],
      create_task: ["title", "outcome"],
      report_habit: ["business_date", "status"],
      report_event: ["event_key"],
      link_diary: ["path", "label"],
      remember_fact: ["fact"],
      configure_task: ["planning"],
      report_execution: ["execution"],
      set_planning: ["preferences", "expected_planning_version"],
      plan_day: ["business_date"],
    }).map(([type, required]) => ({
      if: { properties: { type: { const: type } } },
      then: { required },
    })),
  ],
});
export const proposalSchema = object(
  {
    action_groups: {
      type: "array",
      maxItems: 20,
      items: object({
        action_identity: string(300),
        actions: { type: "array", maxItems: 20, items: actionSchema },
        proposal_id:string(200),expected_version:version,
        basis_refs:{type:"array",minItems:1,maxItems:8,items:object({kind:{enum:["current_input","proposal_decision","rule","delegation"]},id:string(200),version},["kind","id"])},
      },["action_identity","actions"]),
    },
    clarification: {
      ...nullable(string(300)),
      description:
        "仅当缺少完成用户当前请求必需的信息时提一个必要问题。普通问答、讨论做法、查询状态时应为null；不能用它问是否要做下一步或是否需要创建。已有答案写discussion。",
    },
    reply_intent: {
      enum: ["receipt", "proposal", "discussion", "clarification"],
    },
    summary: string(2000),
    discussion: {
      ...string(12000),
      description:
        "直接回答用户当前的问题，或如实报告已执行的文件操作。不能以是否需要帮忙/创建的反问替代已有答案。",
    },
  },
  ["action_groups", "clarification", "reply_intent"],
);
const anyObject = { type: "object", additionalProperties: true };
const hash = { type: "string", pattern: "^sha256:[0-9a-f]{64}$" };
const schemas: Record<string, any> = {
  "GET /export": {},
  "POST /auth/login": { body: object({ password: string(1024) }) },
  "POST /auth/logout": { body: object({}) },
  "GET /documents": { querystring: object({ path: string() }) },
  "PUT /documents": {
    body: object({
      path: string(),
      base_hash: hash,
      content: { type: "string" },
    }),
  },
  "POST /documents": {
    body: {
      ...object(
        {
          path: string(),
          content: { type: "string" },
          kind: { enum: ["daily", "weekly", "monthly", "quarterly", "yearly"] },
          date,
        },
        [],
      ),
      oneOf: [
        { required: ["path", "content"] },
        { required: ["kind", "date"] },
      ],
    },
  },
  "POST /documents/rename": {
    body: object({ path: string(), new_path: string(), base_hash: hash }),
  },
  "DELETE /documents": { body: object({ path: string(), base_hash: hash }) },
  "GET /documents/history": { querystring: object({ path: string() }) },
  "GET /documents/history/content": {
    querystring: object({
      path: string(),
      commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
    }),
  },
  "POST /documents/restore": {
    body: object({
      path: string(),
      commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
      base_hash: hash,
    }),
  },
  "POST /documents/recover": {
    body: object({
      recovery_id: { type: "string", pattern: "^trash_[a-f0-9-]+$" },
    }),
  },
  "GET /home": { querystring: object({ date }, []) },
  "GET /items": { querystring: object({ date }, []) },
  "GET /search": {
    querystring: object(
      {
        q: { type: "string", maxLength: 200 },
        offset: { type: "integer", minimum: 0 },
      },
      ["q"],
    ),
  },
  "POST /commands": { body: actionSchema },
  "POST /assistant/messages": {
    body: object(
      {
        text: string(8000),
        reply_to: string(200),
        note_scope: { type: "array", maxItems: 2, items: noteRefSchema },
      },
      ["text"],
    ),
  },
  "GET /inputs/:id": { params: object({ id: string(100) }) },
  "POST /proposals/:id/accept": {
    params: object({ id: string(100) }),
    body: object({ version }),
  },
  "GET /attachments": { querystring: object({ path: string() }) },
};
export function registerApiContracts(app: FastifyInstance) {
  const paths: Record<string, Record<string, unknown>> = {};
  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/api/v1/")) return;
    const methods = (
        Array.isArray(route.method) ? route.method : [route.method]
      ).filter((x) => x !== "HEAD"),
      short = route.url.slice("/api/v1".length);
    const method = methods[0],
      base = schemas[method + " " + short] ?? {};
    route.schema = { ...route.schema, ...base };
    for (const method of methods) {
      const full = route.url.replace(/:([a-z_]+)/gi, "{$1}"),
        parameters: any[] = [],
        schema = route.schema as any;
      for (const [kind, key] of [
        ["query", "querystring"],
        ["path", "params"],
      ] as const)
        for (const [name, property] of Object.entries(
          schema[key]?.properties ?? {},
        ))
          parameters.push({
            in: kind,
            name,
            required:
              kind === "path" || schema[key].required?.includes(name) || false,
            schema: property,
          });
      if (!["GET", "OPTIONS"].includes(method) && short !== "/auth/login")
        parameters.push({
          in: "header",
          name: "Idempotency-Key",
          required: true,
          schema: string(200),
        });
      const operation: any = {
        operationId:
          method.toLowerCase() + "_" + short.replace(/[^a-z0-9]/gi, "_"),
        security: short === "/auth/login" ? [] : [{ session: [] }],
        parameters,
        responses: {
          "200": {
            description: "Actual current state or operation result",
            content: { "application/json": { schema: anyObject } },
          },
          "400": { description: "Invalid request" },
          "401": { description: "Login required" },
          "403": { description: "Scope or origin denied" },
          "409": { description: "Version or idempotency conflict" },
          "422": { description: "Business requirement not satisfied" },
          "503": { description: "Dependency temporarily unavailable" },
        },
      };
      if (schema.body)
        operation.requestBody = {
          required: true,
          content: { "application/json": { schema: schema.body } },
        };
      if (short === "/attachments" && method === "POST")
        operation.requestBody = {
          required: true,
          content: {
            "multipart/form-data": {
              schema: object({ file: { type: "string", format: "binary" } }),
            },
          },
        };
      if (short === "/attachments" && method === "GET")
        operation.responses["200"] = {
          description: "Authenticated binary attachment",
        };
      if (short === "/events/stream")
        operation.responses["200"] = {
          description: "Refresh notifications only; no document bodies",
          content: { "text/event-stream": { schema: { type: "string" } } },
        };
      if (short === "/assistant/messages")
        operation.responses["202"] = {
          description: "Persisted input; execution has not yet been confirmed",
        };
      (paths[full] ??= {})[method.toLowerCase()] = operation;
    }
  });
  return () => ({
    openapi: "3.1.0",
    info: { title: "Private Secretary Core", version: "1.0.0" },
    paths,
    components: {
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "secretary" },
      },
      schemas: {
        Action: actionSchema,
        ProposalEnvelope: proposalSchema,
        Criterion: criterionSchema,
        NoteRef: noteRefSchema,
      },
    },
    description:
      "Single-user same-origin API. All mutations except login require an Idempotency-Key and exact Origin. Plain Markdown remains on disk.",
  });
}
