import { DateTime } from "luxon";
import type {
  Day,
  Followup,
  PlanningIssue,
  PlanningSettings,
  Registry,
} from "../contracts/types.js";
import { hash } from "../shared/identity.js";
import { taskPlanning } from "./planning.js";
import { workingPrinciples } from "./assistant.js";

const digest = (x: unknown) => hash(JSON.stringify(x)).slice(0, 24);
const terminal = (r: Registry, f: Followup) => {
  if (f.issue.task_id) {
    const t = r.tasks.find((t) => t.id === f.issue.task_id);
    return (
      !t ||
      !t.approval ||
      ["draft", "done", "cancelled"].includes(t.status) ||
      !taskPlanning(t).enabled
    );
  }
  if (f.issue.habit_id)
    return r.habits.find((h) => h.id === f.issue.habit_id)?.status !== "active";
  return false;
};
export function activationIssues(
  r: Registry,
  date: string,
  settings: PlanningSettings,
  load: (d: string) => Day,
): PlanningIssue[] {
  const issues: PlanningIssue[] = [],
    threshold = Math.max(2, settings.postponement_threshold);
  for (const t of r.tasks.filter(
    (t) =>
      t.approval &&
      !["draft", "done", "cancelled"].includes(t.status) &&
      taskPlanning(t).enabled,
  )) {
    const history = taskPlanning(t).execution_history ?? [];
    let misses = 0;
    for (const e of [...history].reverse()) {
      if (e.execution !== "not_started") break;
      misses++;
    }
    if (misses >= threshold)
      issues.push({
        id: "activation:" + t.id,
        kind: "activation",
        task_id: t.id,
        severity: "decision",
        message: t.title + "最近已确认的" + misses + "次反馈都还没有开始",
        recommendation:
          "原办法需要调整。先查约定理由、具体障碍和材料，准备一个更容易开始的动作；最终验收和截止保留。",
        question: "建议换一个更易开始的办法，仍保留这个目标，可以吗？",
      });
  }
  // Only explicit reports count. Missing days, skipped opportunities and partial practice are not failures to start.
  const dates = Array.from(
    { length: Math.min(90, Math.max(30, threshold * 3)) },
    (_, i) => DateTime.fromISO(date).minus({ days: i }).toISODate()!,
  );
  for (const h of r.habits.filter(
    (h) => h.approval && h.status === "active" && h.reminder_mode !== "off",
  )) {
    let misses = 0;
    for (const d of dates) {
      if (d < h.recurrence.starts_on) break;
      const o = load(d).occurrences.find((o) => o.habit_id === h.id);
      if (!o || o.status === "unreported") continue;
      if (o.status !== "did_not") break;
      misses++;
    }
    if (misses >= threshold)
      issues.push({
        id: "activation:" + h.id,
        kind: "activation",
        habit_id: h.id,
        severity: "decision",
        message: h.title + "最近已确认的" + misses + "次机会没有发生",
        recommendation:
          "检查行为门槛、现实机会和提示方式，准备一个具体改法；不降低已约定最低行为，不补欠账。",
        question: "建议调整发生时机或准备方式，先从哪一项改起？",
      });
  }
  return issues;
}

/** Based on business evidence, never on generated wording or the mere passage of another tick. */
export function followupEvidence(
  r: Registry,
  issue: PlanningIssue,
  date: string,
  load: (d: string) => Day,
  now: string,
) {
  const t = r.tasks.find((t) => t.id === issue.task_id),
    h = r.habits.find((h) => h.id === issue.habit_id);
  const p = t ? taskPlanning(t) : null;
  return digest({
    kind: issue.kind,
    severity: issue.severity,
    task: t && {
      outcome: t.outcome,
      acceptance: t.acceptance,
      due: t.due_at,
      status: t.status,
      next: p!.next_action,
      remaining: p!.remaining_minutes,
      feedback: p!.feedback,
      at: p!.feedback_at,
      postponements: p!.postponements,
      blocker: p!.blocker,
      parents: t.parent_task_id,
      dependencies: p!.depends_on.map((id) => [
        id,
        r.tasks.find((x) => x.id === id)?.status,
      ]),
    },
    habit: h && {
      version: h.version,
      facts: Array.from({ length: 30 }, (_, i) => {
        const d = DateTime.fromISO(date).minus({ days: i }).toISODate()!;
        const o = load(d).occurrences.find((o) => o.habit_id === h.id);
        return o ? [o.id, o.status, o.reported_at] : null;
      }).filter(Boolean),
    },
    // Time-only open issues do not acquire a new identity every morning.
    plans: ["conflict", "unconfirmed", "capacity", "deadline"].includes(
      issue.kind,
    )
      ? r.plans
          .filter((x) => !t || x.target_ref.id === t.id)
          .map((x) => [
            x.id,
            x.window_start,
            x.window_end,
            x.status,
            x.execution,
            x.needs_replan,
          ])
      : undefined,
    time_boundaries: [
      "capacity",
      "availability",
      "deadline",
      "conflict",
    ].includes(issue.kind)
      ? r.planning_preferences
      : undefined,
    principles: workingPrinciples(r, now, "support", t ? [t.id] : []),
  });
}
export function followupKey(f: Followup, now: string) {
  // A waiting blocker has one explicit condition check.  Its contact state
  // must remain attached to the same evidence after the check time passes;
  // otherwise the wall clock alone would manufacture a second reminder.
  const checkpoint = f.issue.kind === "blocked" ? null : f.next_check_at;
  return (
    f.id +
    "@" +
    f.fingerprint +
    (checkpoint && checkpoint <= now ? ":" + checkpoint : "")
  );
}
export function syncFollowups(
  r: Registry,
  issues: PlanningIssue[],
  date: string,
  now: string,
  operation: string,
  load: (d: string) => Day,
) {
  const all = (r.followups ??= []),
    seen = new Set<string>();
  const candidates = new Map<string, PlanningIssue>();
  for (const issue of issues) {
    const dated =
      (!issue.task_id && !issue.habit_id) || issue.kind === "capacity";
    const key =
      "followup:" +
      issue.kind +
      ":" +
      (issue.task_id ?? issue.habit_id ?? "day") +
      (dated ? ":" + date : "");
    const previous = candidates.get(key);
    const rank = (x: PlanningIssue) =>
      ({ info: 0, decision: 2, risk: 4 })[x.severity] + Number(!!x.question);
    if (!previous || rank(issue) > rank(previous)) candidates.set(key, issue);
  }
  for (const issue of candidates.values()) {
    if (!issue.question && issue.kind !== "blocked") continue;
    const dated =
      (!issue.task_id && !issue.habit_id) || issue.kind === "capacity";
    const key =
      "followup:" +
      issue.kind +
      ":" +
      (issue.task_id ?? issue.habit_id ?? "day") +
      (dated ? ":" + date : "");
    seen.add(key);
    const fingerprint = followupEvidence(r, issue, date, load, now);
    let f = all.find((x) => x.id === key);
    if (!f) {
      f = {
        id: key,
        version: 0,
        created_at: now,
        updated_at: now,
        last_operation_id: operation,
        business_date: date,
        issue,
        fingerprint: "",
        status: "open",
        next_check_at: null,
        asked_keys: [],
        attempts: [],
      };
      all.push(f);
    }
    if (f.fingerprint === fingerprint && f.status !== "resolved") {
      f.issue = issue;
      continue;
    }
    const t = r.tasks.find((t) => t.id === issue.task_id);
    if (f.analysis?.advice)
      f.attempts = [
        ...f.attempts,
        {
          at: f.analysis.at,
          strategy: f.analysis.strategy,
          advice: f.analysis.advice,
          outcome: t
            ? taskPlanning(t).feedback
            : "新事实已记录，需按习惯事实核对",
        },
      ].slice(-6);
    f.issue = issue;
    f.business_date = date;
    f.fingerprint = fingerprint;
    f.status =
      t?.planning?.blocker?.kind === "waiting" ? "waiting_condition" : "open";
    f.next_check_at = t?.planning?.blocker?.review_at ?? null;
    f.asked_keys = [];
    delete f.resolved_at;
    delete f.analysis;
    f.version++;
    f.updated_at = now;
    f.last_operation_id = operation;
  }
  for (const f of all) {
    if (f.status === "resolved") continue;
    if (f.issue.kind === "checkin" || f.issue.kind === "work") continue;
    const dateSpecific =
      (!f.issue.task_id && !f.issue.habit_id) || f.issue.kind === "capacity";
    if (
      terminal(r, f) ||
      (!seen.has(f.id) && (!dateSpecific || f.business_date <= date))
    ) {
      f.status = "resolved";
      f.resolved_at = now;
      f.next_check_at = null;
      f.version++;
      f.updated_at = now;
      f.last_operation_id = operation;
      if (f.analysis?.advice)
        f.attempts = [
          ...f.attempts,
          {
            at: f.analysis.at,
            strategy: f.analysis.strategy,
            advice: f.analysis.advice,
            outcome: "事项已结束或触发条件已解除；不能据此推断干预的因果效果",
          },
        ].slice(-6);
    }
  }
}
