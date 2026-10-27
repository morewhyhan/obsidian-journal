import { DateTime } from "luxon";
import { activationIssues } from "./followups.js";
import {
  AppError,
  type Registry,
  type Day,
  type Task,
  type Plan,
  type PlanningSettings,
  type TaskPlanning,
  type PlanningIssue,
  type Source,
  type LocalWindow,
} from "../contracts/types.js";
import { hash, id } from "../shared/identity.js";
import { effectivePlanning } from "./assistant.js";

const live = (p: Plan) => ["planned", "active"].includes(p.status);
const active = (t: Task) =>
  !!t.approval && ["ready", "in_progress", "blocked"].includes(t.status);
const iso = (n: number) => new Date(n).toISOString();
const minute = 60000;
const fail = (message: string): never => {
  throw new AppError("PLANNING_INVALID", message);
};
const localTime = (s: unknown) =>
  typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const timestamp = (s: unknown) =>
  typeof s === "string" &&
  /(Z|[+-]\d\d:\d\d)$/i.test(s) &&
  DateTime.fromISO(s).isValid;

export function validatePlanningSettings(p: PlanningSettings) {
  if (
    !p ||
    typeof p.enabled !== "boolean" ||
    typeof p.auto_create_daily !== "boolean" ||
    !localTime(p.evening_time)
  )
    fail("计划开关或晚间时刻无效");
  for (const [value, min, max] of [
    [p.buffer_minutes, 0, 120],
    [p.max_task_minutes, 1, 960],
    [p.max_tasks, 1, 20],
    [p.risk_horizon_days, 1, 31],
    [p.stale_days, 1, 90],
    [p.postponement_threshold, 2, 10],
  ])
    if (!Number.isInteger(value) || value < min || value > max)
      fail("计划容量参数不在允许范围内");
  const windows = (items: LocalWindow[]) => {
    if (!Array.isArray(items) || items.length > 32) fail("时间窗口过多");
    for (const w of items)
      if (!w || !localTime(w.start) || !localTime(w.end) || w.end <= w.start)
        fail("可用时间需为同一天内的有效起止时刻");
  };
  for (const items of [p.availability, p.protected]) {
    windows(items);
    for (const w of items)
      if (
        !Array.isArray(w.weekdays) ||
        !w.weekdays.length ||
        w.weekdays.some((x) => !Number.isInteger(x) || x < 1 || x > 7)
      )
        fail("星期应为1到7");
  }
  if (
    !Array.isArray(p.day_overrides) ||
    p.day_overrides.length > 62 ||
    new Set(p.day_overrides.map((x) => x.date)).size !== p.day_overrides.length
  )
    fail("单日空闲记录无效或重复");
  for (const d of p.day_overrides) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(d.date) ||
      !DateTime.fromISO(d.date).isValid
    )
      fail("计划日期无效");
    windows(d.windows);
  }
}
export function planningSettings(
  r: Registry,
  defaults: PlanningSettings,
  now: string,
): PlanningSettings {
  return effectivePlanning(r, defaults, now);
}
export function taskPlanning(t: Task): TaskPlanning {
  return (
    t.planning ?? {
      enabled: true,
      next_action: null,
      remaining_minutes: null,
      priority: 2,
      depends_on: [],
      not_before: null,
      allow_split: false,
      blocker: null,
      postponements: 0,
      feedback: "unknown",
      feedback_at: null,
      focus_until: null,
    }
  );
}
export function updateTaskPlanning(t: Task, patch: any, r: Registry) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    fail("任务安排资料无效");
  const allowed = [
    "enabled",
    "next_action",
    "remaining_minutes",
    "priority",
    "depends_on",
    "not_before",
    "allow_split",
    "blocker",
    "category",
  ];
  if (Object.keys(patch).some((k) => !allowed.includes(k)))
    fail("任务安排包含未知字段");
  const wasBlocked = t.status === "blocked" && !!taskPlanning(t).blocker;
  const p = { ...taskPlanning(t), ...patch } as TaskPlanning;
  if (
    p.category !== undefined &&
    p.category !== null &&
    (typeof p.category !== "string" ||
      !p.category.trim() ||
      p.category.length > 80)
  )
    fail("任务类别需为简短名称");
  if (typeof p.enabled !== "boolean" || typeof p.allow_split !== "boolean")
    fail("自动安排和拆分应为开关");
  if (
    p.next_action !== null &&
    (typeof p.next_action !== "string" ||
      !p.next_action.trim() ||
      p.next_action.length > 500)
  )
    fail("下一步需为具体动作");
  if (
    p.remaining_minutes !== null &&
    (!Number.isInteger(p.remaining_minutes) ||
      p.remaining_minutes < 0 ||
      p.remaining_minutes > 100000)
  )
    fail("剩余时间应为非负分钟数");
  if (!Number.isInteger(p.priority) || p.priority < 1 || p.priority > 3)
    fail("优先级为1到3，1最高");
  if (p.not_before !== null && !timestamp(p.not_before))
    fail("最早开始时间需要时区");
  if (
    !Array.isArray(p.depends_on) ||
    p.depends_on.length > 30 ||
    new Set(p.depends_on).size !== p.depends_on.length ||
    p.depends_on.some((x) => x === t.id || !r.tasks.some((y) => y.id === x))
  )
    fail("前置任务无效");
  if (
    p.blocker !== null &&
    (!p.blocker ||
      ![
        "time",
        "scope",
        "resource",
        "ability",
        "waiting",
        "health",
        "priority",
      ].includes(p.blocker.kind) ||
      typeof p.blocker.detail !== "string" ||
      !p.blocker.detail.trim() ||
      p.blocker.detail.length > 500 ||
      (p.blocker.review_at !== null && !timestamp(p.blocker.review_at)))
  )
    fail("阻碍需要类别、说明和有效检查时刻");
  if (p.not_before)
    p.not_before = DateTime.fromISO(p.not_before).toUTC().toISO()!;
  if (p.blocker?.review_at)
    p.blocker = {
      ...p.blocker,
      review_at: DateTime.fromISO(p.blocker.review_at).toUTC().toISO()!,
    };
  const visit = (taskId: string, seen: Set<string>) => {
    if (seen.has(taskId)) fail("任务依赖不能成环");
    const next = new Set([...seen, taskId]);
    const deps =
      taskId === t.id
        ? p.depends_on
        : (r.tasks.find((x) => x.id === taskId)?.planning?.depends_on ?? []);
    for (const dep of deps) visit(dep, next);
  };
  visit(t.id, new Set());
  t.planning = p;
  if (wasBlocked && patch.blocker === null) t.status = "ready";
}
function issue(
  kind: PlanningIssue["kind"],
  t: Task | null,
  message: string,
  recommendation: string,
  question: string | null = null,
  severity: PlanningIssue["severity"] = "decision",
): PlanningIssue {
  return {
    id: kind + ":" + (t?.id ?? "day"),
    kind,
    ...(t ? { task_id: t.id } : {}),
    severity,
    message,
    recommendation,
    question,
  };
}
type Span = { start: number; end: number };
function mergeSpans(spans: Span[]) {
  const result: Span[] = [];
  for (const x of spans.sort((a, b) => a.start - b.start)) {
    const last = result.at(-1);
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
    else result.push({ ...x });
  }
  return result;
}
export function availabilityFor(
  date: string,
  p: PlanningSettings,
  zone: string,
): Span[] {
  const d = DateTime.fromISO(date, { zone });
  const override = p.day_overrides.find((x) => x.date === date);
  const local =
    override?.windows ??
    p.availability.filter((x) => x.weekdays.includes(d.weekday));
  return mergeSpans(
    local.map((w) => ({
      start: DateTime.fromISO(date + "T" + w.start, { zone }).toMillis(),
      end: DateTime.fromISO(date + "T" + w.end, { zone }).toMillis(),
    })),
  );
}
function freeSpans(
  date: string,
  r: Registry,
  p: PlanningSettings,
  zone: string,
  now: string,
  exclude: string[] = [],
  buffer = true,
): Span[] {
  const weekday = DateTime.fromISO(date).weekday;
  const protectedSpans = p.protected
    .filter((x) => x.weekdays.includes(weekday))
    .map((w) => ({
      start: DateTime.fromISO(date + "T" + w.start, { zone }).toMillis(),
      end: DateTime.fromISO(date + "T" + w.end, { zone }).toMillis(),
    }));
  const occupied = mergeSpans([
    ...protectedSpans,
    ...r.plans
      .filter((x) => live(x) && !exclude.includes(x.id))
      .map((x) => ({
        start: Date.parse(x.window_start),
        end: Date.parse(x.window_end),
      })),
  ]);
  const result: Span[] = [];
  for (const range of availabilityFor(date, p, zone)) {
    const end = range.end - (buffer ? p.buffer_minutes * minute : 0);
    let cursor = Math.max(range.start, Date.parse(now));
    for (const block of occupied) {
      if (block.end <= cursor || block.start >= end) continue;
      if (block.start > cursor)
        result.push({ start: cursor, end: Math.min(end, block.start) });
      cursor = Math.max(cursor, block.end);
    }
    if (cursor < end) result.push({ start: cursor, end });
  }
  return result;
}
function slotFor(
  r: Registry,
  t: Task,
  earliest: string,
  p: PlanningSettings,
  zone: string,
  exclude: string[] = [],
  buffer = false,
  dateOnly?: string,
) {
  const duration = taskPlanning(t).remaining_minutes;
  if (duration === null || duration <= 0) return null;
  const from = DateTime.fromISO(earliest, { zone }).startOf("day");
  for (
    let offset = 0;
    offset < (dateOnly ? 1 : p.risk_horizon_days);
    offset++
  ) {
    const date = dateOnly ?? from.plus({ days: offset }).toISODate()!;
    for (const free of freeSpans(date, r, p, zone, earliest, exclude, buffer)) {
      const start = Math.max(free.start, Date.parse(earliest));
      const maxEnd = Math.min(
        free.end,
        t.due_at ? Date.parse(t.due_at) : Infinity,
      );
      const minutes = taskPlanning(t).allow_split
        ? Math.min(
            duration,
            Math.floor((maxEnd - start) / minute),
            p.max_task_minutes,
          )
        : duration;
      if (minutes > 0 && start + minutes * minute <= maxEnd)
        return {
          start: iso(start),
          end: iso(start + minutes * minute),
          duration: minutes,
        };
    }
  }
  return null;
}
export function stampPlan(p: Plan, now: string, operation: string) {
  p.version++;
  p.updated_at = now;
  p.last_operation_id = operation;
}
/** All-or-nothing local repair. Only colliding or dependent flexible blocks move. */
export function reflow(
  r: Registry,
  rootId: string,
  start: string,
  end: string,
  now: string,
  settings: PlanningSettings,
  zone: string,
  operation: string,
) {
  const copy = structuredClone(r);
  const root = copy.plans.find((x) => x.id === rootId)!;
  if (!root || end <= start) fail("重排窗口无效");
  const affected = new Set([rootId]);
  const changedTargets = new Set([root.target_ref.id]);
  root.window_start = start;
  root.window_end = end;
  root.duration_minutes = Math.ceil(
    (Date.parse(end) - Date.parse(start)) / minute,
  );
  for (;;) {
    let added = false;
    for (const p of copy.plans.filter(live)) {
      if (affected.has(p.id) || p.window_end <= now) continue;
      const depends = copy.tasks
        .find((x) => x.id === p.target_ref.id)
        ?.planning?.depends_on.some((x) => changedTargets.has(x));
      const collision = copy.plans.some(
        (x) =>
          affected.has(x.id) &&
          x.window_start < p.window_end &&
          x.window_end > p.window_start,
      );
      if (!collision && !depends) continue;
      if (
        (p.kind === "fixed" && collision) ||
        taskPlanning(
          copy.tasks.find((x) => x.id === p.target_ref.id) ??
            ({ planning: { enabled: false } } as Task),
        ).enabled === false
      )
        throw new AppError(
          "PLANNING_CONFLICT",
          "会影响固定事项或未授权移动的安排，需要你取舍",
          409,
        );
      affected.add(p.id);
      changedTargets.add(p.target_ref.id);
      added = true;
    }
    if (!added) break;
  }
  const rootTask = copy.tasks.find((x) => x.id === root.target_ref.id);
  const fitsAvailability = availabilityFor(
    DateTime.fromISO(start, { zone }).toISODate()!,
    settings,
    zone,
  ).some((x) => x.start <= Date.parse(start) && x.end >= Date.parse(end));
  const protectedHit = !freeSpans(
    DateTime.fromISO(start, { zone }).toISODate()!,
    copy,
    settings,
    zone,
    start,
    [...affected],
    false,
  ).some((x) => x.start <= Date.parse(start) && x.end >= Date.parse(end));
  if (
    !fitsAvailability ||
    protectedHit ||
    (rootTask?.due_at && end > rootTask.due_at && !root.overdue_recovery)
  )
    throw new AppError(
      "PLANNING_CONFLICT",
      "剩余工作放不进已确认时间，不能挤占休息或改变截止日",
      409,
    );
  const pending = copy.plans
    .filter((x) => affected.has(x.id) && x.id !== rootId)
    .sort((a, b) => a.window_start.localeCompare(b.window_start));
  const placed = new Set([root.target_ref.id]);
  while (pending.length) {
    const index = pending.findIndex((p) =>
      (
        copy.tasks.find((x) => x.id === p.target_ref.id)?.planning
          ?.depends_on ?? []
      ).every((dep) => !changedTargets.has(dep) || placed.has(dep)),
    );
    if (index < 0) fail("依赖安排无法排序");
    const p = pending.splice(index, 1)[0];
    const t = copy.tasks.find((x) => x.id === p.target_ref.id);
    if (!t)
      throw new AppError(
        "PLANNING_CONFLICT",
        "习惯时间不自动移动，请明确新的机会",
        409,
      );
    const dependencyEnds = copy.plans
      .filter(
        (x) =>
          live(x) &&
          (taskPlanning(t).depends_on.includes(x.target_ref.id) ||
            x.id === rootId),
      )
      .map((x) => x.window_end);
    const earliest = [now, p.window_start, ...dependencyEnds].sort().at(-1)!;
    if (p.kind === "fixed") {
      if (earliest > p.window_start)
        throw new AppError(
          "PLANNING_CONFLICT",
          "后续固定事项的前置工作来不及完成，需要取舍",
          409,
        );
      placed.add(t.id);
      continue;
    }
    const slot = slotFor(
      copy,
      {
        ...t,
        planning: {
          ...taskPlanning(t),
          remaining_minutes: p.duration_minutes,
          allow_split: false,
        },
      },
      earliest,
      settings,
      zone,
      pending
        .filter((x) => x.kind !== "fixed")
        .map((x) => x.id)
        .concat(p.id),
    );
    if (!slot)
      throw new AppError(
        "PLANNING_CONFLICT",
        "连带安排无法放入剩余时间，请选择保留哪项承诺",
        409,
      );
    if (p.window_start === slot.start && p.window_end === slot.end) {
      placed.add(t.id);
      continue;
    }
    p.window_start = slot.start;
    p.window_end = slot.end;
    p.origin = "recovery";
    p.needs_replan = false;
    stampPlan(p, now, operation);
    placed.add(t.id);
    t.planning = {
      ...taskPlanning(t),
      postponements: taskPlanning(t).postponements + 1,
    };
    t.version++;
    t.updated_at = now;
    t.last_operation_id = operation;
  }
  root.needs_replan = false;
  root.origin = "recovery";
  stampPlan(root, now, operation);
  for (const date of new Set(
    copy.plans
      .filter((p) => affected.has(p.id))
      .map((p) => DateTime.fromISO(p.window_start, { zone }).toISODate()!),
  )) {
    const planned = copy.plans.filter(
      (p) =>
        live(p) &&
        p.target_ref.kind === "task" &&
        DateTime.fromISO(p.window_start, { zone }).toISODate() === date,
    );
    if (
      planned.length > settings.max_tasks ||
      planned.reduce((n, p) => n + p.duration_minutes, 0) >
        settings.max_task_minutes
    )
      throw new AppError(
        "PLANNING_CONFLICT",
        "重排会超过当天已确认的工作容量，需要取舍",
        409,
      );
  }
  for (const p of r.plans)
    if (affected.has(p.id))
      Object.assign(
        p,
        copy.plans.find((x) => x.id === p.id),
      );
  for (const t of r.tasks)
    if (changedTargets.has(t.id))
      Object.assign(
        t,
        copy.tasks.find((x) => x.id === t.id),
      );
  return [...affected].filter(
    (planId) =>
      planId === rootId ||
      r.plans.find((p) => p.id === planId)!.last_operation_id === operation,
  );
}
export function recoverySlot(
  r: Registry,
  t: Task,
  plan: Plan,
  now: string,
  settings: PlanningSettings,
  zone: string,
) {
  return slotFor(
    r,
    {
      ...t,
      planning: {
        ...taskPlanning(t),
        remaining_minutes: plan.duration_minutes,
        allow_split: false,
      },
    },
    now,
    settings,
    zone,
    [plan.id],
  );
}
export function boundaryAllows(
  p: Plan,
  settings: PlanningSettings,
  zone: string,
) {
  const date = DateTime.fromISO(p.window_start, { zone }).toISODate()!;
  const spans = availabilityFor(date, settings, zone);
  const weekday = DateTime.fromISO(date).weekday;
  const protectedHit = settings.protected.some(
    (w) =>
      w.weekdays.includes(weekday) &&
      DateTime.fromISO(date + "T" + w.start, { zone }).toMillis() <
        Date.parse(p.window_end) &&
      DateTime.fromISO(date + "T" + w.end, { zone }).toMillis() >
        Date.parse(p.window_start),
  );
  return (
    !protectedHit &&
    spans.some(
      (w) =>
        w.start <= Date.parse(p.window_start) &&
        w.end >= Date.parse(p.window_end),
    )
  );
}
export function blockedIssue(t: Task): PlanningIssue {
  const b = taskPlanning(t).blocker;
  const advice: Record<string, string> = {
    time: "在已确认的空闲时间内重排下一步。",
    scope: "先拆出一个更小、可验收的步骤，最终要求保留。",
    resource: "先列出缺的资料或工具，准备可获取的部分。",
    ability: "先找一份方法或示例，做一个小试验。",
    waiting: "先做不依赖回复的部分，到检查时间再看。",
    health: "保留必要休息，减少弹性安排。",
    priority: "先决定保留、暂停还是取消这件事。",
  };
  return issue(
    "blocked",
    t,
    t.title + "目前受阻" + (b ? "：" + b.detail : "，原因尚未明确"),
    advice[b?.kind ?? "resource"],
    b?.kind === "priority"
      ? "建议先暂停这项，你想保留、暂停还是取消？"
      : b
        ? null
        : "这项具体卡在哪里？",
    "info",
  );
}
export function collectIssues(
  r: Registry,
  date: string,
  now: string,
  p: PlanningSettings,
  zone: string,
  loadDay: (date: string) => Day,
): PlanningIssue[] {
  const issues: PlanningIssue[] = [];
  const horizon = DateTime.fromISO(now, { zone })
    .plus({ days: p.risk_horizon_days })
    .toUTC()
    .toISO()!;
  const remainingBudget = new Map<string, number>();
  for (const t of r.tasks
    .filter(active)
    .sort(
      (a, b) =>
        (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999") ||
        taskPlanning(a).priority - taskPlanning(b).priority,
    )) {
    const c = taskPlanning(t),
      plans = r.plans.filter((x) => x.target_ref.id === t.id && live(x));
    if (!c.enabled) continue;
    if (t.status === "blocked") issues.push(blockedIssue(t));
    if (
      plans.some(
        (x) =>
          x.window_end <= now &&
          (!x.execution ||
            x.execution === "unknown" ||
            x.execution === "started" ||
            x.execution === "progress"),
      )
    )
      issues.push(
        issue(
          "unconfirmed",
          t,
          t.title + "上一次安排已结束，进度未确认",
          "先核对是否已完成，不直接重复安排。",
          "这项已经完成，还是需要接着安排？",
        ),
      );
    if (plans.some((x) => x.needs_replan))
      issues.push(
        issue(
          "conflict",
          t,
          t.title + "的时间调整遇到冲突",
          "保留固定事项、休息和原截止；请明确可以移动哪项。",
          "建议保留固定事项，另找已确认空档；可以调整哪一项？",
          "risk",
        ),
      );
    if (c.postponements >= p.postponement_threshold)
      issues.push(
        issue(
          "repeated",
          t,
          t.title + "已多次改期",
          "建议先拆小下一步，或暂停后重新决定。",
          "建议先暂停自动排程，重新确定下一步，可以吗？",
        ),
      );
    const priorEffort = c.category
      ? r.tasks
          .filter(
            (x) =>
              x.id !== t.id &&
              x.status === "done" &&
              x.planning?.category === c.category &&
              (x.planning?.reported_work_minutes ?? 0) > 0,
          )
          .sort((a, b) => (b.done_at ?? "").localeCompare(a.done_at ?? ""))
          .slice(0, 5)
          .map((x) => x.planning!.reported_work_minutes!)
          .sort((a, b) => a - b)
      : [];
    const typical =
      priorEffort.length >= 3
        ? priorEffort[Math.floor(priorEffort.length / 2)]
        : null;
    if (typical !== null)
      issues.push(
        issue(
          "estimate",
          t,
          c.category +
            "最近" +
            priorEffort.length +
            "项的自报用时中间值为" +
            typical +
            "分钟",
          "同类任务可参考这个时长；这是已记录经验，不代表每项都一样，不自动替换当前估计。",
          null,
          "info",
        ),
      );
    if (
      !plans.some((x) => x.window_end > now) &&
      !c.blocker &&
      (!c.next_action ||
        c.remaining_minutes === null ||
        c.remaining_minutes === 0)
    )
      issues.push(
        issue(
          "details",
          t,
          t.title + "还缺可执行的下一步或时长",
          typical !== null
            ? "同类已有记录可参考约" + typical + "分钟，请明确接受后再安排。"
            : "先明确一件能动手的事和预计时长，保留原验收。",
          "这项先做哪一步，大约需要多久？",
        ),
      );
    if (
      c.depends_on.some(
        (dep) => r.tasks.find((x) => x.id === dep)?.status !== "done",
      )
    )
      issues.push(
        issue(
          "dependency",
          t,
          t.title + "仍有前置任务未完成",
          "先推进前置任务；预计排程不代表前置已经完成。",
          null,
          "info",
        ),
      );
    if (
      Date.parse(now) - Date.parse(c.feedback_at ?? t.updated_at) >
      p.stale_days * 86400000
    )
      issues.push(
        issue(
          "stale",
          t,
          t.title + "较久没有新的进展记录",
          "核对是否继续，保留、暂停或取消由你决定。",
          "这项仍要继续吗？建议先明确下一步再排。",
        ),
      );
    if (t.due_at && t.due_at <= horizon) {
      const due = t.due_at;
      if (due <= now) {
        issues.push(
          issue(
            "deadline",
            t,
            t.title + "已过原定截止，完成情况待核对",
            "核对成果；如需延期或改范围，由你明确接受。",
            "这项已经交付，还是需要重新确定期限？",
            "risk",
          ),
        );
        continue;
      }
      // Missing availability is missing information, not evidence that a deadline is impossible.
      const knownAvailability =
        p.availability.length > 0 ||
        p.day_overrides.some(
          (d) =>
            d.date >= DateTime.fromISO(now, { zone }).toISODate()! &&
            d.date <= DateTime.fromISO(due, { zone }).toISODate()!,
        );
      if (!knownAvailability) continue;
      const scheduled = plans
        .filter((x) => x.window_end > now && x.window_end <= due)
        .reduce(
          (n, x) =>
            n +
            Math.min(
              x.duration_minutes,
              (Date.parse(x.window_end) -
                Math.max(Date.parse(x.window_start), Date.parse(now))) /
                minute,
            ),
          0,
        );
      const knownFree = Array.from(
        { length: p.risk_horizon_days + 1 },
        (_, i) =>
          DateTime.fromISO(now, { zone }).plus({ days: i }).toISODate()!,
      )
        .flatMap((d) => freeSpans(d, r, p, zone, now))
        .reduce(
          (n, x) =>
            n +
            Math.max(0, Math.min(x.end, Date.parse(due)) - x.start) / minute,
          0,
        );
      const earlierClaims = [...remainingBudget.entries()]
        .filter(([deadline]) => deadline <= due)
        .reduce((n, [, value]) => n + value, 0);
      const needed = Math.max(0, (c.remaining_minutes ?? 0) - scheduled);
      const blockingPastDue =
        c.blocker &&
        (c.blocker.review_at
          ? c.blocker.review_at >= due
          : Date.parse(due) - Date.parse(now) < 86400000);
      if (
        c.remaining_minutes === null ||
        needed > knownFree - earlierClaims ||
        blockingPastDue
      )
        issues.push(
          issue(
            "deadline",
            t,
            t.title + "的截止可能受影响",
            c.remaining_minutes === null
              ? "先补剩余工作量，不能保证按时完成。"
              : "先调整弹性安排；仍放不下时再决定延期或改变范围。",
            "建议优先处理这项；若仍排不下，需要调整期限还是范围？",
            "risk",
          ),
        );
      remainingBudget.set(due, (remainingBudget.get(due) ?? 0) + needed);
    }
  }
  const activation = activationIssues(r, date, p, loadDay);
  return [
    ...issues.filter(
      (x) =>
        x.kind !== "repeated" ||
        !activation.some((a) => a.task_id === x.task_id),
    ),
    ...activation,
  ];
}
export function buildNight(
  r: Registry,
  date: string,
  now: string,
  settings: PlanningSettings,
  zone: string,
  operation: string,
  loadDay: (date: string) => Day,
  onlyTasks?: string[],
  allowRebooking = true,
) {
  const issues: PlanningIssue[] = [];
  const dayStart = DateTime.fromISO(date, { zone }).toUTC().toISO()!;
  const dayEnd = DateTime.fromISO(date, { zone })
    .plus({ days: 1 })
    .toUTC()
    .toISO()!;
  const hasFree = availabilityFor(date, settings, zone).length > 0;
  const tasks = r.tasks.filter(
    (t) =>
      active(t) &&
      taskPlanning(t).enabled &&
      (!onlyTasks || onlyTasks.includes(t.id)),
  );
  if (!hasFree && tasks.length)
    issues.push(
      issue(
        "availability",
        null,
        "还没有" + date + "已确认的空闲时间",
        "先给可用时段；固定安排和习惯照原规则执行。",
        date + "哪些时段可以安排任务？",
      ),
    );
  const pending = tasks.sort(
    (a, b) =>
      taskPlanning(a).priority - taskPlanning(b).priority ||
      (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999") ||
      a.created_at.localeCompare(b.created_at),
  );
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let index = 0; index < pending.length; index++) {
      const t = pending[index],
        c = taskPlanning(t);
      if (
        r.plans.some(
          (x) => x.target_ref.id === t.id && live(x) && x.window_end > now,
        )
      ) {
        pending.splice(index--, 1);
        progressed = true;
        continue;
      }
      if (
        t.status === "blocked" ||
        c.blocker ||
        c.postponements >= settings.postponement_threshold
      )
        continue;
      if (
        !allowRebooking &&
        r.plans.some(
          (x) =>
            x.target_ref.id === t.id &&
            x.status === "expired" &&
            ["not_done", "not_started"].includes(x.execution ?? ""),
        )
      )
        continue;
      const past = r.plans.filter(
        (x) => live(x) && x.target_ref.id === t.id && x.window_end <= now,
      );
      if (
        past.some(
          (x) =>
            !["not_done", "not_started", "blocked"].includes(x.execution ?? ""),
        )
      )
        continue;
      if (!hasFree || !c.next_action || !c.remaining_minutes) continue;
      const dependencies = c.depends_on.map((dep) =>
        r.tasks.find((x) => x.id === dep)!,
      );
      if (
        dependencies.some(
          (dep) =>
            dep.status !== "done" &&
            !r.plans.some(
              (x) =>
                x.target_ref.id === dep.id &&
                live(x) &&
                x.window_start >= dayStart &&
                x.duration_minutes >=
                  (taskPlanning(dep).remaining_minutes ?? Infinity),
            ),
        )
      )
        continue;
      const dependencyEnds = r.plans
        .filter((x) => live(x) && c.depends_on.includes(x.target_ref.id))
        .map((x) => x.window_end);
      const earliest = [
        dayStart,
        now,
        c.not_before ?? dayStart,
        ...dependencyEnds,
      ]
        .sort()
        .at(-1)!;
      const planned = r.plans.filter(
        (x) =>
          live(x) &&
          x.target_ref.kind === "task" &&
          x.window_start >= dayStart &&
          x.window_start < dayEnd,
      );
      const used = planned.reduce((n, x) => n + x.duration_minutes, 0);
      const left = settings.max_task_minutes - used;
      const estimated = c.allow_split
        ? Math.min(c.remaining_minutes, left)
        : c.remaining_minutes;
      const slot =
        planned.length < settings.max_tasks && left > 0 && estimated <= left
          ? slotFor(
              r,
              { ...t, planning: { ...c, remaining_minutes: estimated } },
              earliest,
              settings,
              zone,
              [],
              true,
              date,
            )
          : null;
      if (!slot) {
        issues.push(
          issue(
            "capacity",
            t,
            t.title + "没有排进" + date,
            "保留为待安排；不挤占休息，不改截止。",
            t.due_at && t.due_at <= dayEnd
              ? date + "时间不足，建议移开弹性事项；你希望保留哪项？"
              : null,
            t.due_at && t.due_at <= dayEnd ? "risk" : "info",
          ),
        );
        continue;
      }
      const p: Plan = {
        id: id("plan"),
        version: 1,
        created_at: now,
        updated_at: now,
        last_operation_id: operation,
        target_ref: { kind: "task", id: t.id },
        kind: "window",
        window_start: slot.start,
        window_end: slot.end,
        duration_minutes: slot.duration,
        next_action: c.next_action,
        status: "planned",
        approval: t.approval!,
        origin: "night",
        execution: "unknown",
      };
      r.plans.push(p);
      pending.splice(index--, 1);
      progressed = true;
    }
  }
  issues.push(...collectIssues(r, date, now, settings, zone, loadDay));
  return {
    plan_ids: r.plans
      .filter(
        (x) => live(x) && x.window_start >= dayStart && x.window_start < dayEnd,
      )
      .map((x) => x.id),
    issues: [...new Map(issues.map((x) => [x.id, x])).values()],
  };
}
export function planningFingerprint(value: unknown) {
  return hash(JSON.stringify(value)).slice(-24);
}
export function nightMessage(
  r: Registry,
  date: string,
  planIds: string[],
  issues: PlanningIssue[],
  zone: string,
) {
  const rows = r.plans
    .filter((x) => planIds.includes(x.id) && live(x))
    .sort((a, b) => a.window_start.localeCompare(b.window_start));
  const lines = rows
    .slice(0, 5)
    .map(
      (p) =>
        DateTime.fromISO(p.window_start, { zone }).toFormat("HH:mm") +
        " " +
        p.next_action,
    );
  const question = [...issues]
    .sort(
      (a, b) => Number(b.severity === "risk") - Number(a.severity === "risk"),
    )
    .find((x) => x.question);
  return (
    (lines.length
      ? date + " 已安排：\n" + lines.join("\n")
      : date + " 暂无新的任务安排。") +
    (question
      ? "\n" +
        question.message +
        "。" +
        question.recommendation +
        " " +
        question.question
      : "\n按这个安排执行，有变化我再调整。")
  );
}
