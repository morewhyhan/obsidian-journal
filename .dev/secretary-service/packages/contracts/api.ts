import type { FastifyInstance } from "fastify";
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
const types = [
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
  "link_diary",
  "project_diary",
];
export const actionSchema = {
  ...object(
    {
      type: { enum: types },
      target_id: string(100),
      expected_version: version,
      title: string(200),
      min_behavior: string(500),
      optional_target: quantity,
      recurrence,
      anchor,
      status: string(30),
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
      value: nullable({ type: "number", minimum: 0 }),
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
      kind: string(100),
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
            ],
          },
        },
      },
      then: { required: ["target_id", "expected_version"] },
    },
    ...Object.entries({
      create_habit: ["title", "min_behavior", "recurrence", "anchor"],
      create_task: ["title", "outcome"],
      report_habit: ["business_date", "status"],
      report_event: ["event_key"],
      link_diary: ["path", "label"],
      remember_fact: ["fact"],
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
      }),
    },
    clarification: nullable(string(300)),
    reply_intent: {
      enum: ["receipt", "proposal", "discussion", "clarification"],
    },
    summary: string(2000),
    discussion: string(12000),
  },
  ["action_groups", "clarification", "reply_intent"],
);
const anyObject = { type: "object", additionalProperties: true };
const hash = { type: "string", pattern: "^sha256:[0-9a-f]{64}$" };
const schemas: Record<string, any> = {
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
