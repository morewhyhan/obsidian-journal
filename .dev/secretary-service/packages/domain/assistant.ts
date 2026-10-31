import { DateTime } from "luxon";
import {
  AppError,
  type Action,
  type Automation,
  type Day,
  type Entity,
  type FocusSession,
  type PersonalRule,
  type PlanningSettings,
  type Registry,
  type Source,
  type WorkingPrinciple,
} from "../contracts/types.js";
import { hash, id } from "../shared/identity.js";
import { validatePlanningSettings } from "./planning.js";

type Context = {
  operation: string;
  source: Source;
  now: string;
  zone: string;
  userAuthorized: boolean;
  loadDay: (date: string) => Day;
  planningDefaults?: PlanningSettings;
  quietDefaults?: { start: string; end: string };
  rulesBaseRevision?: number;
};
const fail = (message: string): never => {
  throw new AppError("ASSISTANT_INVALID", message);
};
const str = (v: unknown, max = 500): string =>
  typeof v === "string" && v.trim() && v.length <= max
    ? v.trim()
    : fail("需要有效的简短内容");
const number = (v: unknown, min: number, max: number): number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max
    ? v
    : fail("数字不在允许范围内");
export const localTime = (v: unknown): v is string =>
  typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const iso = (v: unknown): string =>
  typeof v === "string" &&
  /(Z|[+-]\d\d:\d\d)$/i.test(v) &&
  DateTime.fromISO(v).isValid
    ? DateTime.fromISO(v).toUTC().toISO()!
    : fail("时间需要包含时区");
const date = (v: unknown): string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  DateTime.fromISO(v).isValid
    ? v
    : fail("日期无效");
const entity = (prefix: string, c: Context): Entity => ({
  id: id(prefix),
  version: 1,
  created_at: c.now,
  updated_at: c.now,
  last_operation_id: c.operation,
});
const touch = (e: Entity, c: Context) => {
  e.version++;
  e.updated_at = c.now;
  e.last_operation_id = c.operation;
};
const check = <T extends Entity>(e: T | undefined, a: Action): T => {
  if (!e) throw new AppError("ITEM_NOT_FOUND", "对象不存在", 404);
  if (a.expected_version !== e.version)
    throw new AppError("VERSION_CONFLICT", "对象已变化，请重新读取", 409);
  return e;
};
export function ruleValue<T>(
  r: Registry,
  key: string,
  fallback: T,
  now: string,
): T {
  const matches = [...(r.user_rules ?? [])]
    .reverse()
    .filter(
      (x) =>
        x.key === key &&
        x.enabled &&
        x.starts_at <= now &&
        (!x.ends_at || x.ends_at > now),
    );
  matches.sort(
    (a, b) =>
      Number(!!b.ends_at) - Number(!!a.ends_at) ||
      b.updated_at.localeCompare(a.updated_at) ||
      b.version - a.version,
  );
  return matches.length ? (matches[0].value as T) : fallback;
}
/** Same effective version selection in chat, planning and exception handling. */
export function workingPrinciples(
  r: Registry,
  now: string,
  purpose: "all" | "planning" | "support" = "all",
  taskIds: string[] = [],
) {
  const categories = r.tasks
    .filter((t) => taskIds.includes(t.id))
    .map((t) => t.planning?.category)
    .filter(Boolean);
  return [...new Set((r.user_rules ?? []).map((x) => x.key))]
    .filter((key) => key.startsWith("working."))
    .flatMap((key) => {
      const value = ruleValue<WorkingPrinciple | null>(r, key, null, now);
      if (
        !value ||
        (purpose !== "all" &&
          value.purpose !== "all" &&
          value.purpose !== purpose)
      )
        return [];
      if (
        (value.task_ids.length || value.categories.length) &&
        !value.task_ids.some((id) => taskIds.includes(id)) &&
        !value.categories.some((c) => categories.includes(c))
      )
        return [];
      const source = r.user_rules!.find(
        (x) => x.key === key && x.value === value,
      )!;
      return [
        {
          key,
          ...value,
          rule_id: source.id,
          version: source.version,
          updated_at: source.updated_at,
        },
      ];
    })
    .sort(
      (a, b) =>
        Number(!!(b.task_ids.length || b.categories.length)) -
          Number(!!(a.task_ids.length || a.categories.length)) ||
        b.updated_at.localeCompare(a.updated_at),
    );
}
export function effectivePlanning(
  r: Registry,
  defaults: PlanningSettings,
  now: string,
): PlanningSettings {
  const p = r.user_rules
    ? { ...defaults }
    : { ...defaults, ...r.planning_preferences };
  for (const k of Object.keys(p) as (keyof PlanningSettings)[])
    (p as any)[k] = ruleValue(r, "planning." + k, p[k], now);
  return p;
}
export function currentFocus(r: Registry, loadDay: (d: string) => Day) {
  return r.focus_date ? loadDay(r.focus_date).focus : undefined;
}
export function inQuiet(
  now: string,
  zone: string,
  q: { start: string; end: string },
) {
  const t = DateTime.fromISO(now).setZone(zone).toFormat("HH:mm");
  return q.start > q.end
    ? t >= q.start || t < q.end
    : t >= q.start && t < q.end;
}
export function quietHours(
  r: Registry,
  fallback: { start: string; end: string },
  now: string,
) {
  return ruleValue(r, "contact.quiet_hours", fallback, now);
}
export function ruleAction(
  r: Registry,
  a: Action,
  c: Context,
): string[] | null {
  if (!["set_personal_rule", "control_rule", "undo_rule"].includes(a.type))
    return null;
  if (!c.userAuthorized)
    throw new AppError("NEEDS_CONFIRMATION", "个人规则需要明确授权");
  if (
    a.expected_rules_revision !== (r.rules_revision ?? 0) &&
    a.expected_rules_revision !== (c.rulesBaseRevision ?? r.rules_revision ?? 0)
  )
    throw new AppError("VERSION_CONFLICT", "规则已变化", 409);
  seedRules(r, c);
  const all = r.user_rules!;
  if (a.type === "set_personal_rule") {
    const key = str(a.key, 80),
      value = a.value;
    JSON.stringify(value, (k, v) => {
      if (["__proto__", "constructor", "prototype"].includes(k))
        fail("规则含不安全字段");
      return v;
    });
    if (key.startsWith("working.")) {
      if (!/^working\.[a-z0-9_-]{1,60}$/.test(key))
        fail("工作原则需要稳定的短英文键");
      const v = value as WorkingPrinciple;
      if (
        !v ||
        typeof v !== "object" ||
        Array.isArray(v) ||
        Object.keys(v).some(
          (k) =>
            !["instruction", "task_ids", "categories", "purpose"].includes(k),
        )
      )
        fail("工作原则字段无效");
      str(v.instruction, 600);
      if (!["all", "planning", "support"].includes(v.purpose))
        fail("工作原则用途无效");
      for (const list of [v.task_ids, v.categories])
        if (
          !Array.isArray(list) ||
          list.length > 20 ||
          list.some((x) => typeof x !== "string" || !x.trim() || x.length > 100)
        )
          fail("工作原则范围无效");
      if (v.task_ids.some((id) => !r.tasks.some((t) => t.id === id)))
        fail("工作原则引用了不存在的任务");
      if (
        !all.some((x) => x.key === key && x.enabled) &&
        new Set(
          all
            .filter((x) => x.enabled && x.key.startsWith("working."))
            .map((x) => x.key),
        ).size >= 64
      )
        fail("工作原则已达64项，请修改或停用已有原则");
    } else if (key.startsWith("planning.")) {
      const p = effectivePlanning(r, c.planningDefaults!, c.now),
        k = key.slice(9);
      if (!Object.hasOwn(p, k)) fail("未知计划规则");
      validatePlanningSettings({ ...p, [k]: value });
    } else if (
      [
        "contact.suggestion_cap",
        "contact.minimum_gap_minutes",
        "review.weekly_day",
      ].includes(key)
    )
      number(
        value,
        key === "review.weekly_day"
          ? 1
          : key === "contact.minimum_gap_minutes"
            ? 60
            : 0,
        key === "review.weekly_day"
          ? 7
          : key === "contact.minimum_gap_minutes"
            ? 1440
            : 4,
      );
    else if (
      [
        "contact.enabled",
        "assistance.enabled",
        "contact.focus_protection",
        "recording.to_diary",
        "review.enabled",
        "support.enabled",
        "support.allow_prepare_next_action",
      ].includes(key)
    ) {
      if (typeof value !== "boolean") fail("规则需要开关值");
    } else if (key === "support.review_after_minutes") number(value, 60, 10080);
    else if (key === "support.style") {
      if (!["direct", "gentle"].includes(String(value)))
        fail("跟进风格需要direct或gentle");
    } else if (key === "contact.style") str(value, 300);
    else if (key === "contact.quiet_hours") {
      const q = value as any;
      if (
        !q ||
        Object.keys(q).some((k) => !["start", "end"].includes(k)) ||
        !localTime(q.start) ||
        !localTime(q.end) ||
        q.start === q.end
      )
        fail("静默时段无效");
    } else fail("不支持这项可执行规则；不能修改权限或运行密钥");
    const starts = a.starts_at ? iso(a.starts_at) : c.now,
      ends = a.ends_at ? iso(a.ends_at) : null;
    if (ends && (ends <= starts || ends <= c.now)) fail("规则有效期已过或反向");
    if (
      all.filter((x) => x.key === key && x.ends_at && x.ends_at > c.now)
        .length >= 32
    )
      fail("临时覆盖过多，请先停用旧覆盖");
    const item: PersonalRule = {
      ...entity("rule", c),
      key,
      value: structuredClone(value),
      starts_at: starts,
      ends_at: ends,
      enabled: true,
      source: c.source,
    };
    all.push(item);
    trimRules(r, key);
    r.rules_revision = (r.rules_revision ?? 0) + 1;
    if (key.startsWith("planning."))
      r.planning_version = (r.planning_version ?? 0) + 1;
    r.planning_preferences = effectivePlanning(r, c.planningDefaults!, c.now);
    return [item.id];
  }
  const item = check(
    all.find((x) => x.id === a.target_id),
    a,
  );
  if (a.type === "control_rule" && a.kind === "all_versions") {
    if (a.enabled !== false || !item.key.startsWith("working."))
      fail("仅支持停用同一工作原则的全部版本");
    const matches = all.filter((x) => x.key === item.key);
    for (const x of matches) {
      x.enabled = false;
      touch(x, c);
    }
    r.rules_revision = (r.rules_revision ?? 0) + 1;
    return matches.map((x) => x.id);
  }
  item.enabled = a.type === "undo_rule" ? false : a.enabled === true;
  touch(item, c);
  r.rules_revision = (r.rules_revision ?? 0) + 1;
  if (item.key.startsWith("planning."))
    r.planning_version = (r.planning_version ?? 0) + 1;
  r.planning_preferences = effectivePlanning(r, c.planningDefaults!, c.now);
  return [item.id];
}
export function syncPlanningRules(
  r: Registry,
  patch: Partial<PlanningSettings>,
  c: Context,
) {
  seedRules(r, c);
  const all = r.user_rules!;
  for (const [k, v] of Object.entries(patch)) {
    all.push({
      ...entity("rule", c),
      key: "planning." + k,
      value: structuredClone(v),
      starts_at: c.now,
      ends_at: null,
      enabled: true,
      source: c.source,
    });
    trimRules(r, "planning." + k);
  }
  r.rules_revision = (r.rules_revision ?? 0) + 1;
  r.planning_preferences = effectivePlanning(r, c.planningDefaults!, c.now);
}
function seedRules(r: Registry, c: Context) {
  if (!r.user_rules)
    r.user_rules = Object.entries(r.planning_preferences ?? {}).map(
      ([k, v]) => ({
        ...entity("rule", c),
        key: "planning." + k,
        value: structuredClone(v),
        starts_at: c.now,
        ends_at: null,
        enabled: true,
        source: c.source,
      }),
    );
}
function trimRules(r: Registry, key: string) {
  const history = r.user_rules!.filter((x) => x.key === key && !x.ends_at);
  const keep = new Set(history.slice(-20).map((x) => x.id));
  const kept = r.user_rules!.filter(
    (x) => x.key !== key || x.ends_at || keep.has(x.id),
  );
  r.user_rules!.splice(0, r.user_rules!.length, ...kept);
}
/** A wall-clock occurrence uses the first offset; nonexistent local instants are skipped. */
export function localInstant(
  d: string,
  t: string,
  zone: string,
): string | null {
  const dt = DateTime.fromISO(d + "T" + t, { zone });
  if (!dt.isValid || dt.toFormat("yyyy-MM-dd'T'HH:mm") !== d + "T" + t)
    return null;
  return dt
    .getPossibleOffsets()
    .sort((a, b) => a.toMillis() - b.toMillis())[0]
    .toUTC()
    .toISO();
}
export function automationSlots(a: Automation, businessDate: string): string[] {
  if (a.kind === "one_shot")
    return a.due_at &&
      DateTime.fromISO(a.due_at).setZone(a.timezone).toISODate() ===
        businessDate
      ? [a.due_at]
      : [];
  const s = a.schedule!;
  if (
    businessDate < s.starts_on ||
    (s.ends_on && businessDate > s.ends_on) ||
    !s.weekdays.includes(DateTime.fromISO(businessDate).weekday) ||
    a.skip_dates.includes(businessDate)
  )
    return [];
  if (a.kind === "recurring") {
    const t = localInstant(businessDate, s.local_start, a.timezone);
    return t ? [t] : [];
  }
  const slots: string[] = [];
  const firstHour =
    Number(s.local_start.slice(0, 2)) +
    Number(s.minute < Number(s.local_start.slice(3)));
  for (let hour = 0; hour < 24; hour++) {
    const t =
      String(hour).padStart(2, "0") + ":" + String(s.minute).padStart(2, "0");
    if (
      t >= s.local_start &&
      t < s.local_end &&
      (hour - firstHour) % (s.every_hours ?? 1) === 0
    ) {
      const v = localInstant(businessDate, t, a.timezone);
      if (v) slots.push(v);
    }
  }
  return slots;
}
function subscriptionCount(a: Automation) {
  if (!["hourly_checkin", "status_check"].includes(a.kind)) return 1;
  const s = a.schedule!,
    first =
      Number(s.local_start.slice(0, 2)) +
      Number(s.minute < Number(s.local_start.slice(3)));
  return Array.from({ length: 24 }, (_, h) => h).filter((h) => {
    const t =
      String(h).padStart(2, "0") + ":" + String(s.minute).padStart(2, "0");
    return (
      t >= s.local_start &&
      t < s.local_end &&
      (h - first) % (s.every_hours ?? 1) === 0
    );
  }).length;
}
function checkSubscriptionCapacity(automations: Automation[], extra = 0) {
  const reserved = automations.filter(
    (x) => x.status === "active" || (x.status === "paused" && x.paused_until),
  );
  if (
    reserved.length > 32 ||
    reserved.some(
      (a) => subscriptionCount(a) < 1 || subscriptionCount(a) > 24,
    ) ||
    reserved.reduce((n, a) => n + subscriptionCount(a), extra) > 60
  )
    fail("预计订阅超过每天60次保护值或没有有效时点，请缩小范围");
}
function checkFocusWindow(
  r: Registry,
  c: Context,
  end: string,
  taskId: string | null,
) {
  const settings = effectivePlanning(r, c.planningDefaults!, c.now);
  for (
    let d = DateTime.fromISO(c.now).setZone(c.zone).startOf("day");
    d.toMillis() < Date.parse(end);
    d = d.plus({ days: 1 })
  )
    if (
      settings.protected.some(
        (w) =>
          w.weekdays.includes(d.weekday) &&
          Date.parse(localInstant(d.toISODate()!, w.start, c.zone) ?? end) <
            Date.parse(end) &&
          Date.parse(localInstant(d.toISODate()!, w.end, c.zone) ?? c.now) >
            Date.parse(c.now),
      )
    )
      fail("专注会撞上保护时段，请缩短或明确调整保护安排");
  if (
    r.plans.some(
      (p) =>
        p.kind === "fixed" &&
        ["planned", "active"].includes(p.status) &&
        p.window_start < end &&
        p.window_end > c.now &&
        p.target_ref.id !== taskId,
    )
  )
    fail("专注会撞上固定安排，请先调整时长");
}
export function automationAction(
  r: Registry,
  a: Action,
  c: Context,
): string[] | null {
  if (
    ![
      "create_automation",
      "update_automation",
      "control_automation",
      "report_automation",
      "start_focus",
      "pause_focus",
      "resume_focus",
      "stop_focus",
    ].includes(a.type)
  )
    return null;
  const all = (r.automations ??= []);
  if (a.type === "report_automation") {
    const item = check(
        all.find((x) => x.id === a.target_id),
        a,
      ),
      record = c.loadDay(date(a.business_date)),
      found = record.automation_occurrences?.find(
        (x) => x.id === a.occurrence_id && x.automation_id === item.id,
      );
    if (!found) fail("找不到对应回顾，请保留原日期与实例");
    if (found!.report) (found!.report_history ??= []).push(found!.report!);
    found!.report = {
      text: str(a.report),
      source: c.source,
      at: c.now,
      ...(typeof a.to_diary === "boolean" ? { to_diary: a.to_diary } : {}),
    };
    found!.diary = undefined;
    if (a.to_diary === true) found!.to_diary = true;
    return [item.id];
  }
  if (!c.userAuthorized)
    throw new AppError("NEEDS_CONFIRMATION", "自动化和专注需要明确授权");
  if (a.type === "create_automation" || a.type === "update_automation") {
    const previous =
      a.type === "update_automation"
        ? check(
            all.find((x) => x.id === a.target_id),
            a,
          )
        : undefined;
    const raw = { ...previous, ...a };
    const kind = raw.kind as Automation["kind"];
    if (
      !["one_shot", "recurring", "hourly_checkin", "status_check"].includes(
        kind,
      )
    )
      fail("不支持的自动化类型");
    const timezone = String(raw.timezone ?? c.zone);
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      fail("需要有效IANA时区");
    }
    let due: string | null = null,
      schedule: Automation["schedule"] = null;
    if (kind === "one_shot") {
      if (a.delay_seconds !== undefined && a.due_at != null)
        fail("一次提醒的相对时长与绝对时刻只能选择一个，不能忽略其中一个时间");
      due =
        a.delay_seconds !== undefined
          ? DateTime.fromISO(c.source.accepted_at)
              .plus({ seconds: number(a.delay_seconds, 1, 2678400) })
              .toUTC()
              .toISO()!
          : iso(raw.due_at);
      if (due <= c.now) fail("原定提醒时刻已过，尚未创建；请给一个新的时刻");
    } else {
      if (a.delay_seconds !== undefined || a.due_at != null)
        fail("周期提醒使用schedule，不能忽略一次提醒的delay_seconds/due_at参数");
      const s = raw.schedule as any;
      if (kind === "recurring" && a.schedule &&
        (Object.hasOwn(a.schedule, "minute") || Object.hasOwn(a.schedule, "every_hours")))
        fail("recurring每天只在local_start发生一次；按小时发生请使用hourly_checkin或status_check，不能忽略minute/every_hours");
      if (
        !s ||
        !Array.isArray(s.weekdays) ||
        !s.weekdays.length ||
        s.weekdays.some(
          (x: unknown) =>
            !Number.isInteger(x) || Number(x) < 1 || Number(x) > 7,
        ) ||
        !localTime(s.local_start) ||
        !localTime(s.local_end) ||
        s.local_end <= s.local_start
      )
        fail("请明确重复星期和同日有效时间范围");
      schedule = {
        weekdays: [...new Set<number>(s.weekdays)],
        starts_on: date(s.starts_on),
        ends_on: s.ends_on ? date(s.ends_on) : null,
        local_start: s.local_start,
        local_end: s.local_end,
        minute: ["hourly_checkin", "status_check"].includes(kind)
          ? number(
              s.minute ??
                (kind === "status_check" ? Number(s.local_start.slice(3)) : 55),
              0,
              59,
            )
          : 0,
        every_hours: number(s.every_hours ?? 1, 1, 24),
      };
      if (schedule.ends_on && schedule.ends_on < schedule.starts_on)
        fail("重复日期反向");
    }
    const item: Automation = {
      ...(previous ?? entity("auto", c)),
      title: str(raw.title, 100),
      kind,
      status: "active",
      timezone,
      due_at: due,
      schedule,
      body: str(
        raw.body ??
          (kind === "status_check"
            ? "现在在做什么？方便时回一句。"
            : kind === "hourly_checkin"
              ? "这一小时主要做了什么？回一句就行。"
              : raw.title),
        1000,
      ),
      to_diary: raw.to_diary === true,
      strict: raw.strict === true,
      quiet_exception:
        raw.quiet_exception === true ||
        (kind === "one_shot" && Date.parse(due!) - Date.parse(c.now) <= 3600000),
      paused_until: null,
      skip_dates: previous?.skip_dates ?? [],
      approval: c.source,
    };
    const quiet = quietHours(
      r,
      c.quietDefaults ?? { start: "23:00", end: "08:00" },
      c.now,
    );
    item.quiet_exception =
      raw.quiet_exception === true ||
      (item.quiet_exception && inQuiet(c.now, c.zone, quiet));
    // A repeating schedule that starts inside the quiet window would be created
    // and then silently never delivered: refuse it instead, unless the caller
    // carries the user's explicit consent for that time.
    const scheduledStart =
      schedule && localTime(schedule.local_start)
        ? DateTime.fromISO(date(c.now.toString().slice(0, 10)) + "T" + schedule.local_start, {
            zone: timezone,
          })
        : null;
    // Refuse only a subscription that can never deliver: every one of its slots
    // falls inside the quiet hours. A wide window (06:00-22:00, or an all-day
    // hourly check) still has usable slots, and a repeating reminder is not
    // judged by its start minute alone.
    const focus = currentFocus(r, c.loadDay);
    const deliverable =
      kind === "one_shot"
        ? !!due && !inQuiet(due, c.zone, quiet)
        : (() => {
            const localToday = DateTime.fromISO(date(c.now.toString().slice(0, 10)), {
              zone: timezone,
            }).toISODate();
            const slots = localToday ? automationSlots(item, localToday) : [];
            return slots.length === 0 || slots.some((x) => !inQuiet(x, c.zone, quiet));
          })();
    if (!item.quiet_exception && !deliverable)
      fail(
        "提醒落在静默时段，尚未创建；建议改到静默结束后，带上用户明确同意的 quiet_exception，或先调整明确的静默规则",
      );
    checkSubscriptionCapacity(
      [...all.filter((x) => x.id !== item.id), item],
      focus && ["active", "paused", "needs_resume"].includes(focus.status)
        ? 2 * focus.rounds - 1
        : 0,
    );
    if (previous) {
      touch(item, c);
      Object.assign(previous, item);
    } else all.push(item);
    return [item.id];
  }
  if (a.type === "control_automation") {
    const item = check(
      all.find((x) => x.id === a.target_id),
      a,
    );
    if (!["pause", "resume", "stop", "skip_today"].includes(String(a.control)))
      fail("自动化控制无效");
    if (a.control === "resume") {
      const focus = currentFocus(r, c.loadDay);
      checkSubscriptionCapacity(
        all.map((x) => (x.id === item.id ? { ...x, status: "active" } : x)),
        focus && ["active", "paused", "needs_resume"].includes(focus.status)
          ? 2 * focus.rounds - 1
          : 0,
      );
      if (item.kind === "one_shot" && item.due_at! <= c.now)
        fail("这条一次提醒已经过时，请设一个新时点");
    }
    if (a.control === "skip_today")
      item.skip_dates.push(
        DateTime.fromISO(c.now).setZone(item.timezone).toISODate()!,
      );
    else {
      item.status =
        a.control === "resume"
          ? "active"
          : a.control === "stop"
            ? "retired"
            : "paused";
      item.paused_until = a.ends_at ? iso(a.ends_at) : null;
    }
    touch(item, c);
    return [item.id];
  }
  const focus = currentFocus(r, c.loadDay);
  if (a.type === "start_focus") {
    if (focus && ["active", "paused", "needs_resume"].includes(focus.status))
      fail("已有专注会话，请先停止或继续它");
    const work = number(a.work_minutes ?? 25, 1, 120),
      rest = number(a.break_minutes ?? 5, 1, 120),
      rounds = number(a.rounds ?? 4, 1, 12);
    checkSubscriptionCapacity(all, 2 * rounds - 1);
    const task = a.task_ref
      ? r.tasks.find(
          (x) =>
            x.id === a.task_ref &&
            x.approval &&
            !["done", "cancelled"].includes(x.status),
        )
      : null;
    if (a.task_ref && !task) fail("专注关联的任务不可用");
    const end = DateTime.fromISO(c.now)
      .plus({ minutes: work * rounds + rest * (rounds - 1) })
      .toUTC()
      .toISO()!;
    checkFocusWindow(r, c, end, task?.id ?? null);
    const businessDate = DateTime.fromISO(c.now).setZone(c.zone).toISODate()!;
    r.focus_date = businessDate;
    c.loadDay(businessDate).focus = {
      ...entity("focus", c),
      task_ref: task?.id ?? null,
      work_minutes: work,
      break_minutes: rest,
      rounds,
      round_index: 1,
      phase: "working",
      status: "active",
      phase_started_at: c.now,
      phase_due_at: DateTime.fromISO(c.now)
        .plus({ minutes: work })
        .toUTC()
        .toISO()!,
      remaining_ms: work * 60000,
      quiet_exception: inQuiet(
        c.now,
        c.zone,
        quietHours(
          r,
          c.quietDefaults ?? { start: "23:00", end: "08:00" },
          c.now,
        ),
      ),
      source: c.source,
    };
    return [c.loadDay(businessDate).focus!.id];
  }
  const f = check(focus, a);
  if (a.type === "pause_focus") {
    if (f.status !== "active") fail("当前计时没有运行");
    f.remaining_ms = Math.max(
      0,
      Date.parse(f.phase_due_at) - Date.parse(c.now),
    );
    f.status = "paused";
  } else if (a.type === "resume_focus") {
    if (!["paused", "needs_resume"].includes(f.status))
      fail("当前会话无需恢复");
    const remaining = f.rounds - f.round_index,
      minutes =
        f.remaining_ms / 60000 +
        remaining * f.work_minutes +
        Math.max(0, remaining - (f.phase === "break" ? 1 : 0)) *
          f.break_minutes;
    checkFocusWindow(
      r,
      c,
      DateTime.fromISO(c.now).plus({ minutes }).toUTC().toISO()!,
      f.task_ref,
    );
    f.phase_started_at = c.now;
    f.phase_due_at = new Date(
      Date.parse(c.now) + Math.max(1000, f.remaining_ms),
    ).toISOString();
    f.status = "active";
  } else f.status = "cancelled";
  touch(f, c);
  return [f.id];
}
export function occurrenceId(
  automation: string,
  version: number,
  slot: string,
) {
  return "occ_" + hash(automation + ":" + version + ":" + slot).slice(0, 24);
}
