export const HABIT_STATUSES = ["draft", "active", "paused", "retired"] as const;
export const HABIT_OCCURRENCE_STATUSES = [
  "unreported",
  "partial",
  "did",
  "did_not",
  "skipped",
] as const;
export const TASK_UPDATE_STATUSES = [
  "draft",
  "ready",
  "in_progress",
  "blocked",
] as const;
export const CRITERION_STATUSES = ["met", "unmet", "pending"] as const;
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
  reminder_mode?: "window" | "opportunistic" | "off";
  definition_history?: {
    version: number;
    min_behavior: string;
    minimum_quantity?: Quantity | null;
    effective_until: string;
  }[];
  title: string;
  min_behavior: string;
  minimum_quantity?: Quantity | null;
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
  artifact_check?: { kind: "exists_nonempty" } | { kind: "contains_all"; terms: string[] };
};
export type Task = Entity & {
  planning?: TaskPlanning;
  title: string;
  outcome: string;
  acceptance: Criterion[];
  due_at: string | null;
  verification: "self_report" | "tool";
  status: "draft" | "ready" | "in_progress" | "blocked" | "done" | "cancelled";
  done_at: string | null;
  completion_time?: {performed_at:string|null;business_date:string|null;reported_at:string};
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
  overdue_recovery?: Source;
  origin?: "user" | "night" | "recovery";
  execution?:
    "unknown" | "started" | "progress" | "not_started" | "not_done" | "blocked";
  execution_at?: string;
  needs_replan?: boolean;
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
  managed_label?: string;
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
  decisions?: {
    proposal_version: number;
    proposal_hash: string;
    decision: "accept" | "reject" | "defer";
    action_indices: number[];
    original_actions: Action[];
    applied_actions: Action[];
    applied_hash: string;
    source: Source;
    operation_id: string;
    at: string;
  }[];
  issue_key?: string;
  summary: string;
  actions: Action[];
  expires_at: string;
  status: "pending" | "accepted" | "expired" | "cancelled";
  source: Source;
};
export type Registry = {
  operational_blocks?: {capability:"background_write"|"contact"|"model"|"business_write";reason_code:string;
    source_ref:string;created_at:string;cleared_at?:string}[];
  followups?: Followup[];
  rules_revision?: number;
  user_rules?: PersonalRule[];
  automations?: Automation[];
  focus_date?: string | null;
  planning_version?: number;
  planning_preferences?: PlanningSettings;
  schema_version: 1 | 2;
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
  minimum_quantity_snapshot?: Quantity | null;
  status: "unreported" | "did" | "did_not" | "skipped" | "partial";
  quantity: Quantity | null;
  optional_target_met: boolean | null;
  source: Source;
  reported_at: string;
  performed_at?: string | null;
  operation_id: string;
};
export type Day = {
  automation_occurrences?: AutomationOccurrence[];
  focus?: FocusSession;
  assistance?: {
    request_id?: string;
    attempted_at?: string;
    cause_code?: string;
    status: "pending" | "running" | "done" | "failed" | "superseded";
    revision: number;
    attempts: number;
    summary?: string;
    error?: string;
    snapshot?: string;
    reviews?: string[];
  };
  planning?: DailyPlanning;
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
    old_performed_at?: string | null;
    new_performed_at?: string | null;
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
export type LocalWindow = { start: string; end: string };
export type WeeklyWindow = LocalWindow & { weekdays: number[] };
export type PlanningSettings = {
  enabled: boolean;
  evening_time: string;
  availability: WeeklyWindow[];
  protected: WeeklyWindow[];
  day_overrides: { date: string; windows: LocalWindow[] }[];
  buffer_minutes: number;
  max_task_minutes: number;
  max_tasks: number;
  risk_horizon_days: number;
  stale_days: number;
  postponement_threshold: number;
  auto_create_daily: boolean;
};
export type Obstacle = {
  kind:
    | "time"
    | "scope"
    | "resource"
    | "ability"
    | "waiting"
    | "health"
    | "priority";
  detail: string;
  review_at: string | null;
};
export type TaskPlanning = {
  execution_history?: {
    at: string;
    performed_at?: string|null;
    business_date?: string|null;
    execution: "started" | "progress" | "not_started" | "not_done" | "blocked";
    next_action: string | null;
    source: Source;
  }[];
  category?: string | null;
  reported_work_minutes?: number;
  enabled: boolean;
  next_action: string | null;
  remaining_minutes: number | null;
  priority: number;
  depends_on: string[];
  not_before: string | null;
  allow_split: boolean;
  blocker: Obstacle | null;
  postponements: number;
  feedback:
    "unknown" | "started" | "progress" | "not_started" | "not_done" | "blocked";
  feedback_at: string | null;
  focus_until: string | null;
};
export type PlanningIssue = {
  id: string;
  kind:
    | "availability"
    | "details"
    | "unconfirmed"
    | "dependency"
    | "capacity"
    | "deadline"
    | "blocked"
    | "stale"
    | "repeated"
    | "activation"
    | "checkin"
    | "conflict"
    | "estimate"
    | "work";
  task_id?: string;
  habit_id?: string;
  severity: "info" | "decision" | "risk";
  message: string;
  recommendation: string;
  question: string | null;
};
/** Durable business follow-through; delivery receipts remain short-lived in SQLite. */
export type Followup = Entity & {
  work?: { key:string; summary:string; owner:"assistant"|"user"|"condition"; next_action:string;
    condition:string|null; source:Source;
    refs?: import("./work.js").WorkRef[];
    step_id?:string;
    done_when?:import("./work.js").WorkDone;
    wake_on?: {kind:"ref_changed"|"matching_feedback";ref:import("./work.js").WorkRef}[];
    delegation?:import("./work.js").WorkDelegation;
    resolution?:import("./work.js").WorkResolution;
    paused_from?:"open"|"waiting_user"|"waiting_condition";
    prior_steps?:{step_id:string;at:string;kind:"completed"|"superseded";evidence:string[]}[];
  };
  business_date: string;
  issue: PlanningIssue;
  fingerprint: string;
  status: "open" | "waiting_user" | "waiting_condition" | "paused" | "resolved";
  resolved_at?: string;
  next_check_at: string | null;
  asked_keys: string[];
  contact?: {
    key: string;
    outbox_id: string;
    at: string;
    status: "sending" | "sent" | "unknown" | "failed";
  };
  analysis?: {
    fingerprint: string;
    status: "running" | "done" | "failed" | "superseded";
    at: string;
    attempts: number;
    strategy: string;
    advice?: string;
    proposal_id?: string;
  };
  attempts: {
    at: string;
    strategy: string;
    advice: string;
    outcome: string;
  }[];
};
export type WorkingPrinciple = {
  instruction: string;
  task_ids: string[];
  categories: string[];
  purpose: "all" | "planning" | "support";
};
export type DailyPlanning = {
  generated_at: string;
  updated_at: string;
  status: "ready" | "needs_user";
  plan_ids: string[];
  issues: PlanningIssue[];
  review: string[];
  notice: {
    key: string;
    body: string;
    starts_at: string;
    expires_at: string;
    kind: "night" | "adjustment" | "risk";
    question_id?: string;
  };
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
export type PersonalRule = Entity & {
  key: string;
  value: unknown;
  starts_at: string;
  ends_at: string | null;
  enabled: boolean;
  source: Source;
};
export type Automation = Entity & {
  last_attempted_at?: string;
  title: string;
  kind: "one_shot" | "recurring" | "hourly_checkin" | "status_check";
  status: "active" | "paused" | "retired";
  timezone: string;
  due_at: string | null;
  schedule: {
    weekdays: number[];
    starts_on: string;
    ends_on: string | null;
    local_start: string;
    local_end: string;
    minute: number;
    every_hours?: number;
  } | null;
  body: string;
  to_diary: boolean;
  strict: boolean;
  quiet_exception: boolean;
  paused_until: string | null;
  skip_dates: string[];
  approval: Source;
};
export type AutomationOccurrence = {
  checkin_status?: "ready" | "skip" | "failed";
  to_diary?: boolean;
  report_history?: { text: string; source: Source; at: string }[];
  id: string;
  slot_key: string;
  automation_id: string;
  version: number;
  due_at: string;
  expires_at: string;
  body: string;
  kind: "automation" | "focus";
  status: "scheduled" | "cancelled" | "expired";
  quiet_exception: boolean;
  report?: { text: string; source: Source; at: string; to_diary?: boolean };
  diary?: { path: string; heading: string; base_hash: string; done: boolean };
};
export type FocusSession = Entity & {
  task_ref: string | null;
  work_minutes: number;
  break_minutes: number;
  rounds: number;
  round_index: number;
  phase: "working" | "break";
  status: "active" | "paused" | "needs_resume" | "finished" | "cancelled";
  phase_started_at: string;
  phase_due_at: string;
  remaining_ms: number;
  quiet_exception: boolean;
  source: Source;
};
export type Execution = {
  projection?: { status: "applied" | "pending" | "conflict"; warnings: string[] };
  status: "accepted" | "conflict" | "rejected" | "needs_confirmation";
  operation_id: string;
  updated_ids: string[];
  message: string;
};
export type OperationGroupRef = { identity: string; fingerprint: string; compatibility_identity?:string };
export class AppError extends Error {
  readonly stage="execution";
  readonly effect:"not_applied"|"unknown";
  readonly retry_policy:"none"|"reread"|"backoff"|"reconcile_only";
  constructor(
    public code: string,
    message: string,
    public status = 422,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.effect=/UNCERTAIN|UNKNOWN/.test(code)?"unknown":"not_applied";
    this.retry_policy=this.effect==="unknown"?"reconcile_only":status===409?"reread":status===429||status===503?"backoff":"none";
  }
}
