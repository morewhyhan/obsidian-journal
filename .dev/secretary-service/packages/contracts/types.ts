export type Source = {
  input_id: string;
  channel: string;
  external_id: string;
  accepted_at: string;
  summary: string;
};
export type Quantity = { value: number; unit: string };
export type NoteRef = {
  path: string;
  heading: string | null;
  relation: "motivation" | "plan" | "method" | "evidence";
};
export type Entity = {
  id: string;
  version: number;
  created_at: string;
  updated_at: string;
  last_operation_id: string;
};
export type Habit = Entity & {
  definition_history?: {
    version: number;
    min_behavior: string;
    effective_until: string;
  }[];
  title: string;
  min_behavior: string;
  optional_target: Quantity | null;
  status: "draft" | "active" | "paused" | "retired";
  approval: Source | null;
  note_refs: NoteRef[];
  recurrence: { weekdays: number[]; starts_on: string; ends_on: string | null };
  anchor:
    | { kind: "time_window"; local_start: string; local_end: string }
    | { kind: "event"; event_key: string };
};
export type Criterion = {
  id: string;
  kind: "check" | "count" | "artifact";
  description: string;
  target: number | null;
  unit: string | null;
  verification: "self_report" | "tool";
  artifact_ref: string | null;
};
export type Task = Entity & {
  title: string;
  outcome: string;
  acceptance: Criterion[];
  due_at: string | null;
  verification: "self_report" | "tool";
  status: "draft" | "ready" | "in_progress" | "blocked" | "done" | "cancelled";
  done_at: string | null;
  parent_task_id: string | null;
  supporting_habit_ids: string[];
  approval: Source | null;
  note_refs: NoteRef[];
  progress: {
    criteria: Record<
      string,
      {
        reported_value: number | null;
        unit: string | null;
        status: "pending" | "met" | "unmet";
        source_refs: Source[];
      }
    >;
    last_report: string | null;
    report_source?: Source;
    verification_pending?: boolean;
  };
};
export type Plan = Entity & {
  target_ref: { kind: "habit" | "task"; id: string; business_date?: string };
  kind: "fixed" | "window";
  window_start: string;
  window_end: string;
  duration_minutes: number;
  next_action: string;
  status: "planned" | "active" | "finished" | "expired" | "cancelled";
  approval: Source;
};
export type Control = Entity & {
  scope: "global" | "item";
  target_id: string | null;
  starts_at: string;
  ends_at: string;
  reason_source: Source;
};
export type DiaryLink = Entity & {
  status?: "active" | "pending";
  allow_append?: boolean;
  business_date?: string;
  target_ref: { kind: "habit" | "task"; id: string };
  path: string;
  heading: "习惯" | "任务";
  line_fingerprint: string;
  position_hint: number;
  last_hash: string;
  last_item_version: number;
};
export type Proposal = Entity & {
  summary: string;
  actions: Action[];
  expires_at: string;
  status: "pending" | "accepted" | "expired" | "cancelled";
  source: Source;
};
export type Registry = {
  schema_version: 1;
  revision: number;
  last_operation_id: string | null;
  updated_at: string | null;
  habits: Habit[];
  tasks: Task[];
  plans: Plan[];
  controls: Control[];
  diary_links: DiaryLink[];
  proposals: Proposal[];
};
export type Occurrence = {
  id: string;
  habit_id: string;
  slot_key: string;
  definition_version: number;
  min_behavior_snapshot: string;
  status: "unreported" | "did" | "did_not" | "skipped";
  quantity: Quantity | null;
  optional_target_met: boolean | null;
  source: Source;
  reported_at: string;
  operation_id: string;
};
export type Day = {
  schema_version: 1;
  revision: number;
  last_operation_id: string | null;
  updated_at: string | null;
  business_date: string;
  occurrences: Occurrence[];
  corrections: {
    id: string;
    old_status: string;
    new_status: string;
    source: Source;
    at: string;
    target_kind?: "task" | "habit";
    title_snapshot?: string;
    done_at?: string | null;
    outcome_snapshot?: string;
    acceptance_snapshot?: Criterion[];
  }[];
};
export type Action = {
  type: string;
  target_id?: string;
  expected_version?: number;
  [key: string]: unknown;
};
export type Input = {
  id: string;
  channel: string;
  actor_ref: string;
  external_id: string;
  text: string;
  occurred_at: string;
  reply_to?: string;
  note_scope?: NoteRef[];
};
export type Execution = {
  status: "accepted" | "conflict" | "rejected" | "needs_confirmation";
  operation_id: string;
  updated_ids: string[];
  message: string;
};
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
