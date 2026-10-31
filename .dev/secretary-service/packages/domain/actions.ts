import { DateTime } from "luxon";
import {
  AppError,
  type Action,
  type Registry,
  type Day,
  type Source,
  type Entity,
  type Habit,
  type Task,
  type Plan,
  type NoteRef,
  type PlanningSettings,
  HABIT_STATUSES,
  HABIT_OCCURRENCE_STATUSES,
  TASK_UPDATE_STATUSES,
  CRITERION_STATUSES,
} from "../contracts/types.js";
import { id } from "../shared/identity.js";
import type { FactDraft } from "../contracts/facts.js";
import { workAction } from "./work.js";
import { day } from "../calendar/index.js";
import { earliestSlot } from "./scheduling.js";
import {
  ruleAction,
  automationAction,
  syncPlanningRules,
} from "./assistant.js";
import {
  updateTaskPlanning,
  planningSettings,
  taskPlanning,
  validatePlanningSettings,
  bufferMinutesFor,
  reflow,
} from "./planning.js";
type Context = {
  operation: string;
  source: Source;
  now: string;
  zone: string;
  loadDay: (date: string) => Day;
  userAuthorized: boolean;
  verified?: Map<string, Source>;
  rememberFact?: (fact: string, meta?: Omit<FactDraft, "content">) => void;
  forgetFact?: (targetId: string, expectedVersion: number) => unknown;
  validateNoteRef?: (path: string) => void;
  planningDefaults?: PlanningSettings;
};
/** Reserve for the date of the first supplied window; unknown availability keeps the caller's windows. */
function slotReserve(registry: Registry, c: Context, windows: unknown) {
  if (!c.planningDefaults || !Array.isArray(windows) || !windows.length) return 0;
  const first = windows[0] as { start?: unknown };
  if (typeof first?.start !== "string") return 0;
  const at = DateTime.fromISO(first.start, { setZone: true });
  const date = at.isValid ? at.setZone(c.zone).toISODate() : null;
  return date
    ? bufferMinutesFor(planningSettings(registry, c.planningDefaults, c.now), date)
    : 0;
}
export const verificationKey = (
  taskId: string,
  criterion: {
    id: string;
    kind: string;
    description?: string;
    artifact_ref: string | null;
    target: number | null;
    unit: string | null;
    artifact_check?: Task["acceptance"][number]["artifact_check"];
  },
) =>
  JSON.stringify([
    taskId,
    criterion.id,
    criterion.kind,
    criterion.description ?? null,
    criterion.artifact_ref,
    criterion.target,
    criterion.unit,
    criterion.artifact_check ?? null,
  ]);
const text = (v: unknown, name: string, max = 2000) => {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new AppError("INVALID_FIELD", `${name}不完整`);
  return v.trim();
};
const quantity = (v: any) => {
  if (v == null) return null;
  if (!Number.isFinite(v.value) || v.value < 0)
    throw new AppError("INVALID_QUANTITY", "数量应为非负数");
  return { value: v.value, unit: text(v.unit, "单位", 30) };
};
function checkVersion(
  entity: Entity | undefined,
  a: Action,
  versions: Map<string, number>,
) {
  if (!entity) throw new AppError("ITEM_NOT_FOUND", "事项不存在", 404);
  if (
    a.expected_version !== undefined &&
    (versions.get(entity.id) ?? entity.version) !== a.expected_version
  )
    throw new AppError("VERSION_CONFLICT", "事项已变化，请重新读取", 409, {
      version: entity.version,
    });
  return entity;
}
function stamp(entity: Entity, c: Context) {
  entity.version++;
  entity.updated_at = c.now;
  entity.last_operation_id = c.operation;
}
function base(prefix: string, c: Context): Entity {
  return {
    id: id(prefix),
    version: 1,
    created_at: c.now,
    updated_at: c.now,
    last_operation_id: c.operation,
  };
}
function accept(c: Context) {
  if (!c.userAuthorized)
    throw new AppError("NEEDS_CONFIRMATION", "新承诺需要用户接受", 422);
  return c.source;
}
function reminderMode(value: unknown): Habit["reminder_mode"] {
  if (!["window", "opportunistic", "off"].includes(String(value)))
    throw new AppError("INVALID_REMINDER_MODE", "习惯提示方式无效");
  return value as Habit["reminder_mode"];
}
function timestamp(value: unknown) {
  const str = text(value, "时间");
  if (
    !DateTime.fromISO(str, { setZone: true }).isValid ||
    !/[zZ]|[+-]\d\d:\d\d$/.test(str)
  )
    throw new AppError("INVALID_TIME", "时间必须包含时区");
  return DateTime.fromISO(str).toUTC().toISO()!;
}
function reportTime(a:Action,c:Context) {
  const performed=a.performed_at==null ? null : timestamp(a.performed_at);
  const date=a.business_date==null ? (performed ? DateTime.fromISO(performed,{zone:c.zone}).toISODate()! : null) : text(a.business_date,"发生日期",10);
  if(date) day(date);
  if((performed && performed>c.now) || (date && date>DateTime.fromISO(c.now,{zone:c.zone}).toISODate()!) ||
    (performed && DateTime.fromISO(performed,{zone:c.zone}).toISODate()!==date))
    throw new AppError("INVALID_PERFORMED_AT","发生时间须已发生且与日期一致；未知不要猜测");
  return {performed_at:performed,business_date:date,reported_at:c.now};
}
function allowDeadline(t:Task|undefined,end:string,a:Action,c:Context) {
  if(t?.due_at && end>t.due_at) {
    if(a.overdue_recovery!==true) throw new AppError("DEADLINE_WINDOW_CONFLICT","执行时段超过硬截止，需要明确选择逾期补救，原截止保持不变");
    return accept(c);
  }
  return undefined;
}
function criteria(value: any, verification: "self_report" | "tool") {
  if (!Array.isArray(value) || value.length > 20)
    throw new AppError("INVALID_ACCEPTANCE", "需要验收条件");
  const ids = new Set<string>();
  return value.map((x: any, i: number) => {
    if (!x || typeof x !== "object")
      throw new AppError("INVALID_ACCEPTANCE", "无效验收条件");
    const criterionId = x.id ?? `c${i + 1}`;
    if (
      typeof criterionId !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(criterionId) ||
      ["constructor", "prototype", "__proto__"].includes(criterionId) ||
      ids.has(criterionId)
    )
      throw new AppError("INVALID_ACCEPTANCE", "验收条件ID需要唯一");
    ids.add(criterionId);
    if (
      x.verification !== undefined &&
      !["self_report", "tool"].includes(x.verification)
    )
      throw new AppError("INVALID_ACCEPTANCE", "无效验收方式");
    if (!["check", "count", "artifact"].includes(x.kind))
      throw new AppError("INVALID_ACCEPTANCE", "不支持的验收类型");
    if (
      x.kind === "count" &&
      (!Number.isFinite(x.target) || x.target < 0 || !x.unit)
    )
      throw new AppError("INVALID_ACCEPTANCE", "数量验收需要目标和单位");
    if (x.artifact_check !== undefined && (
      x.kind !== "artifact" || !x.artifact_check ||
      !["exists_nonempty", "contains_all"].includes(x.artifact_check.kind) ||
      Object.keys(x.artifact_check).some((k) => !["kind", "terms"].includes(k)) ||
      (x.artifact_check.kind === "contains_all" && (
        !Array.isArray(x.artifact_check.terms) || !x.artifact_check.terms.length ||
        x.artifact_check.terms.length > 20 || x.artifact_check.terms.some((t: unknown) => typeof t !== "string" || !t.trim() || t.length > 500)
      ))
    )) throw new AppError("INVALID_ACCEPTANCE", "交付物检查需要明确、可执行的规则");
    return {
      id: criterionId,
      kind: x.kind,
      description: text(x.description, "验收条件"),
      target: x.kind === "count" ? x.target : null,
      unit: x.kind === "count" ? text(x.unit, "单位", 30) : null,
      verification: x.verification ?? verification,
      artifact_ref:
        x.artifact_ref == null
          ? null
          : text(x.artifact_ref, "交付物路径", 1024),
      ...(x.artifact_check ? { artifact_check: structuredClone(x.artifact_check) } : {}),
    };
  });
}
function recurrence(value: any): Habit["recurrence"] {
  if (
    !value ||
    !Array.isArray(value.weekdays) ||
    !value.weekdays.length ||
    value.weekdays.some((n: any) => !Number.isInteger(n) || n < 1 || n > 7)
  )
    throw new AppError("INVALID_RECURRENCE", "需要有效重复星期");
  day(value.starts_on);
  if (value.ends_on) {
    day(value.ends_on);
    if (value.ends_on < value.starts_on)
      throw new AppError("INVALID_RECURRENCE", "结束日不能早于开始日");
  }
  return {
    weekdays: [...new Set<number>(value.weekdays)],
    starts_on: value.starts_on,
    ends_on: value.ends_on ?? null,
  };
}
function anchor(value: any): Habit["anchor"] {
  if (value?.kind === "event")
    return { kind: "event", event_key: text(value.event_key, "事件名称", 100) };
  if (
    value?.kind !== "time_window" ||
    !/^\d\d:\d\d$/.test(value.local_start) ||
    !/^\d\d:\d\d$/.test(value.local_end) ||
    !DateTime.fromFormat(value.local_start, "HH:mm").isValid ||
    !DateTime.fromFormat(value.local_end, "HH:mm").isValid ||
    value.local_start === value.local_end
  )
    throw new AppError("INVALID_ANCHOR", "需要有效时间窗口");
  return {
    kind: "time_window",
    local_start: value.local_start,
    local_end: value.local_end,
  };
}
function noteRefs(value: unknown, c: Context): NoteRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12)
    throw new AppError("INVALID_NOTE_REFS", "关联笔记过多");
  return value.map((ref) => {
    if (
      !ref ||
      !["motivation", "plan", "method", "evidence"].includes(ref.relation)
    )
      throw new AppError("INVALID_NOTE_REFS", "关联类型不正确");
    const path = text(ref.path, "笔记路径", 1024);
    if (!c.validateNoteRef)
      throw new AppError("REFERENCE_UNAVAILABLE", "当前不可验证笔记关联");
    c.validateNoteRef(path);
    return {
      path,
      heading: ref.heading == null ? null : text(ref.heading, "标题", 200),
      relation: ref.relation,
    };
  });
}
function supporting(value: unknown, r: Registry) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    value.some(
      (x) => typeof x !== "string" || !r.habits.some((h) => h.id === x),
    )
  )
    throw new AppError("INVALID_RELATION", "关联习惯不存在");
  return [...new Set<string>(value)];
}
export function applyActions(
  registry: Registry,
  actions: Action[],
  c: Context,
) {
  const ids: string[] = [];
  // Explicit moves in one commit may temporarily overlap (for example, swapping
  // two blocks). Validate their final state before the draft can be committed.
  const moving=new Set(actions.filter(a=>a.type==="reschedule").map(a=>a.target_id));
  const assistantContext = {
    ...c,
    rulesBaseRevision: registry.rules_revision ?? 0,
  };
  const versions = new Map(
    [
      ...registry.habits,
      ...registry.tasks,
      ...registry.plans,
      ...registry.proposals,
    ].map((item) => [item.id, item.version]),
  );
  const version = (entity: Entity | undefined, action: Action) =>
    checkVersion(entity, action, versions);
  const find = (a: Action) =>
    registry.habits.find((x) => x.id === a.target_id) ??
    registry.tasks.find((x) => x.id === a.target_id);
  const touch = (entity: Entity) => {
    stamp(entity, c);
    ids.push(entity.id);
  };
  const syncNextAction = (task: Task, patch: any) => {
    if (typeof patch?.next_action !== "string") return;
    for (const plan of registry.plans.filter((p) => p.target_ref.id === task.id && ["planned", "active"].includes(p.status))) {
      plan.next_action = task.planning!.next_action!;
      touch(plan); // A fixed time does not freeze the user's next-action wording.
    }
  };
  for (const a of actions) {
    const assistantIds =
      workAction(registry,a,c) ?? ruleAction(registry, a, assistantContext) ??
      automationAction(registry, a, c);
    if (assistantIds) {
      ids.push(...assistantIds);
      continue;
    }
    switch (a.type) {
      case "create_habit": {
        const repeat = recurrence(a.recurrence),
          prompt = anchor(a.anchor),
          status = a.status === "draft" ? "draft" : "active";
        const h: Habit = {
          ...base("habit", c),
          title: text(a.title, "习惯名称", 200),
          min_behavior: text(a.min_behavior, "最小行为", 500),
          minimum_quantity: quantity(a.minimum_quantity),
          optional_target: quantity(a.optional_target),
          status,
          approval: status === "draft" ? null : accept(c),
          note_refs: noteRefs(a.note_refs, c),
          recurrence: repeat,
          anchor: prompt,
          reminder_mode:
            a.reminder_mode === undefined
              ? "opportunistic"
              : reminderMode(a.reminder_mode),
        };
        registry.habits.push(h);
        ids.push(h.id);
        break;
      }
      case "create_task": {
        const verification = a.verification === "tool" ? "tool" : "self_report",
          status = a.status === "draft" ? "draft" : "ready",
          acceptance = criteria(a.acceptance ?? [], verification);
        if (status !== "draft" && !acceptance.length)
          throw new AppError("INVALID_ACCEPTANCE", "任务启用前需要验收条件");
        const t: Task = {
          ...base("task", c),
          title: text(a.title, "任务名称", 200),
          outcome: text(a.outcome, "任务成果"),
          acceptance,
          due_at: a.due_at ? timestamp(a.due_at) : null,
          verification,
          status,
          done_at: null,
          parent_task_id:
            typeof a.parent_task_id === "string" ? a.parent_task_id : null,
          supporting_habit_ids: supporting(a.supporting_habit_ids, registry),
          approval: status === "draft" ? null : accept(c),
          note_refs: noteRefs(a.note_refs, c),
          progress: { criteria: {}, last_report: null },
        };
        if (
          t.parent_task_id &&
          !registry.tasks.some((x) => x.id === t.parent_task_id)
        )
          throw new AppError("INVALID_RELATION", "父任务不存在");
        registry.tasks.push(t);
        if (a.planning !== undefined)
          updateTaskPlanning(t, a.planning, registry);
        if (a.initial_plan && !t.planning)
          updateTaskPlanning(
            t,
            {
              next_action: (a.initial_plan as any).next_action,
              remaining_minutes: (a.initial_plan as any).duration_minutes,
            },
            registry,
          );
        ids.push(t.id);
        if (a.initial_plan !== undefined) {
          if (
            !a.initial_plan ||
            typeof a.initial_plan !== "object" ||
            Array.isArray(a.initial_plan)
          )
            throw new AppError("INVALID_WINDOW", "初始安排需要完整时间窗口");
          const scheduled = applyActions(
            registry,
            [
              {
                ...a.initial_plan,
                type: "schedule",
                target_id: t.id,
                expected_version: t.version,
              },
            ],
            c,
          );
          if ((a.initial_plan as any).overdue_recovery!==true && t.due_at && registry.plans.some((p) => scheduled.ids.includes(p.id) && p.window_end > t.due_at!))
            throw new AppError("DEADLINE_WINDOW_CONFLICT", "新任务的执行窗口超过同时设置的硬截止；核对时区或明确调整方案，不能静默修改截止");
          ids.push(...scheduled.ids);
        }
        break;
      }
      case "update_habit": {
        const h = version(
          registry.habits.find((x) => x.id === a.target_id),
          a,
        ) as Habit;
        accept(c);
        if (a.min_behavior !== undefined) {
          const next = text(a.min_behavior, "最小行为", 500);
          if (next !== h.min_behavior) {
            h.definition_history ??= [];
            h.definition_history.push({
              version: h.version,
              min_behavior: h.min_behavior,
              minimum_quantity: h.minimum_quantity ?? null,
              effective_until: DateTime.fromISO(c.now, { zone: c.zone })
                .minus({ days: 1 })
                .toISODate()!,
            });
            h.min_behavior = next;
          }
        }
        if (a.optional_target !== undefined)
          h.optional_target = quantity(a.optional_target);
        if (a.minimum_quantity !== undefined) {
          if (!h.definition_history?.some((x) => x.version === h.version))
            (h.definition_history ??= []).push({
              version: h.version,
              min_behavior: h.min_behavior,
              minimum_quantity: h.minimum_quantity ?? null,
              effective_until: DateTime.fromISO(c.now, { zone: c.zone })
                .minus({ days: 1 })
                .toISODate()!,
            });
          h.minimum_quantity = quantity(a.minimum_quantity);
        }
        if (a.recurrence !== undefined) h.recurrence = recurrence(a.recurrence);
        if (a.anchor !== undefined) h.anchor = anchor(a.anchor);
        if (a.reminder_mode !== undefined)
          h.reminder_mode = reminderMode(a.reminder_mode);
        if (a.note_refs !== undefined) h.note_refs = noteRefs(a.note_refs, c);
        if (a.title !== undefined) h.title = text(a.title, "名称", 200);
        if (a.status !== undefined) {
          if (!(HABIT_STATUSES as readonly string[]).includes(String(a.status)))
            throw new AppError("INVALID_STATUS", "无效状态");
          h.status = a.status as Habit["status"];
        }
        h.approval = c.source;
        touch(h);
        break;
      }
      case "update_task": {
        if (["next_action", "remaining_minutes", "blocker"].some((key) => a[key] !== undefined))
          throw new AppError("TASK_PLANNING_NESTING", "任务下一步、剩余时长与阻碍须放planning对象，不能静默忽略顶层字段");
        const t = version(
          registry.tasks.find((x) => x.id === a.target_id),
          a,
        ) as Task;
        accept(c);
        const previous = {
          status: t.status,
          done_at: t.done_at,
          outcome: t.outcome,
          acceptance: structuredClone(t.acceptance),
        };
        const resultChanged =
          a.acceptance !== undefined ||
          (a.outcome !== undefined && a.outcome !== t.outcome) ||
          (a.verification !== undefined && a.verification !== t.verification);
        if (a.verification !== undefined) {
          if (!["self_report", "tool"].includes(String(a.verification)))
            throw new AppError("INVALID_ACCEPTANCE", "无效验收方式");
          t.verification = a.verification as Task["verification"];
          if (a.acceptance === undefined)
            t.acceptance = t.acceptance.map((condition) => ({
              ...condition,
              verification: t.verification,
            }));
        }
        if (a.title !== undefined) t.title = text(a.title, "名称", 200);
        if (a.outcome !== undefined) t.outcome = text(a.outcome, "成果");
        if (a.due_at !== undefined)
          t.due_at = a.due_at ? timestamp(a.due_at) : null;
        if (a.acceptance !== undefined) {
          t.acceptance = criteria(a.acceptance, t.verification);
          if (!t.acceptance.length)
            throw new AppError("INVALID_ACCEPTANCE", "不能清空验收条件");
          t.progress.criteria = {};
          if (t.status === "done") {
            t.status = "in_progress";
            t.done_at = null;
          }
        }
        if (resultChanged) {
          t.progress.criteria = {};
          t.progress.verification_pending = false;
          if (t.status === "done") {
            t.status = "in_progress";
            t.done_at = null;
          }
        }
        if (a.supporting_habit_ids !== undefined)
          t.supporting_habit_ids = supporting(a.supporting_habit_ids, registry);
        if (a.note_refs !== undefined) t.note_refs = noteRefs(a.note_refs, c);
        if (a.status !== undefined) {
          if (
            !(TASK_UPDATE_STATUSES as readonly string[]).includes(
              String(a.status),
            )
          )
            throw new AppError("INVALID_STATUS", "通过验收操作完成或取消任务");
          if (a.status !== "draft" && !t.acceptance.length)
            throw new AppError("INVALID_ACCEPTANCE", "需要验收条件");
          t.status = a.status as Task["status"];
          t.done_at = null;
        }
        if (a.parent_task_id !== undefined) {
          const parent = a.parent_task_id;
          if (
            parent !== null &&
            (typeof parent !== "string" ||
              parent === t.id ||
              !registry.tasks.some((x) => x.id === parent))
          )
            throw new AppError("INVALID_RELATION", "无效父任务");
          const seen = new Set([t.id]);
          let cursor = registry.tasks.find((x) => x.id === parent);
          while (cursor) {
            if (seen.has(cursor.id))
              throw new AppError("INVALID_RELATION", "父任务不能成环");
            seen.add(cursor.id);
            cursor = registry.tasks.find(
              (x) => x.id === cursor!.parent_task_id,
            );
          }
          t.parent_task_id = parent as string | null;
        }
        if (a.planning !== undefined) {
          updateTaskPlanning(t, a.planning, registry);
          syncNextAction(t, a.planning);
        }
        if (previous.status === "done" && t.status !== "done")
          c.loadDay(
            DateTime.fromISO(c.now, { zone: c.zone }).toISODate()!,
          ).corrections.push({
            id: t.id,
            target_kind: "task",
            title_snapshot: t.title,
            old_status: previous.status,
            new_status: t.status,
            done_at: previous.done_at,
            outcome_snapshot: previous.outcome,
            acceptance_snapshot: previous.acceptance,
            source: c.source,
            at: c.now,
          });
        t.approval = c.source;
        touch(t);
        break;
      }
      case "set_planning": {
        accept(c);
        if (
          !c.planningDefaults ||
          !a.preferences ||
          typeof a.preferences !== "object" ||
          Array.isArray(a.preferences)
        )
          throw new AppError("PLANNING_INVALID", "需要计划偏好");
        const patch = a.preferences as Partial<PlanningSettings>;
        if (
          a.expected_planning_version !== undefined &&
          a.expected_planning_version !== (registry.planning_version ?? 0)
        )
          throw new AppError(
            "VERSION_CONFLICT",
            "可用时间或计划偏好已在别处更新，请重新读取",
            409,
          );
        if (
          Object.keys(patch).some((k) => !Object.hasOwn(c.planningDefaults!, k))
        )
          throw new AppError("PLANNING_INVALID", "计划偏好包含未知字段");
        const settings = {
          ...planningSettings(registry, c.planningDefaults, c.now),
          ...patch,
        };
        validatePlanningSettings(settings);
        syncPlanningRules(registry, patch, c);
        registry.planning_version = (registry.planning_version ?? 0) + 1;
        break;
      }
      case "configure_task": {
        if (["next_action", "remaining_minutes", "blocker"].some((key) => a[key] !== undefined))
          throw new AppError("TASK_PLANNING_NESTING", "任务下一步、剩余时长与阻碍须放planning对象，不能静默忽略顶层字段");
        const t = version(
          registry.tasks.find((x) => x.id === a.target_id),
          a,
        ) as Task;
        accept(c);
        const oldAction = t.planning?.next_action;
        updateTaskPlanning(t, a.planning, registry);
        if (
          c.source.channel !== "coordinator" &&
          ((a.planning as any).enabled === true ||
            (t.planning?.next_action && t.planning.next_action !== oldAction))
        )
          t.planning!.postponements = 0;
        syncNextAction(t, a.planning);
        if (
          a.planning &&
          (a.planning as any).blocker === null &&
          t.status === "blocked"
        )
          t.status = "in_progress";
        touch(t);
        break;
      }
      case "report_execution": {
        const occurred=reportTime(a,c);
        const t = version(
          registry.tasks.find((x) => x.id === a.target_id),
          a,
        ) as Task;
        if (!t.approval || ["draft", "done", "cancelled"].includes(t.status))
          throw new AppError("TASK_NOT_ACTIVE", "先明确重新打开任务");
        if (
          ![
            "started",
            "progress",
            "not_started",
            "not_done",
            "blocked",
          ].includes(String(a.execution))
        )
          throw new AppError(
            "INVALID_PROGRESS",
            "需要明确开始、进展、未完成或受阻",
          );
        const patch: any = {};
        if (a.next_action !== undefined) patch.next_action = a.next_action;
        if (a.remaining_minutes !== undefined)
          patch.remaining_minutes = a.remaining_minutes;
        if (a.blocker !== undefined) patch.blocker = a.blocker;
        updateTaskPlanning(t, patch, registry);
        const p = taskPlanning(t);
        p.feedback = a.execution as
          "started" | "progress" | "not_started" | "not_done" | "blocked";
        p.feedback_at = c.now;
        p.execution_history = [
          ...(p.execution_history ?? []),
          {
            at: c.now,
            performed_at:occurred.performed_at,
            business_date:occurred.business_date,
            execution: p.feedback,
            next_action: p.next_action,
            source: c.source,
          },
        ].slice(-24);
        if (a.effort_minutes !== undefined) {
          if (
            !Number.isInteger(a.effort_minutes) ||
            Number(a.effort_minutes) < 0 ||
            Number(a.effort_minutes) > 1440
          )
            throw new AppError("INVALID_PROGRESS", "实际投入应为0到1440分钟");
          p.reported_work_minutes =
            (p.reported_work_minutes ?? 0) + Number(a.effort_minutes);
          t.progress.report_source = c.source;
        }
        const historic=(occurred.performed_at ? Date.parse(c.now)-Date.parse(occurred.performed_at)>300000 :
          occurred.business_date && occurred.business_date!==DateTime.fromISO(c.now,{zone:c.zone}).toISODate());
        p.focus_until = !historic && ["started", "progress"].includes(String(a.execution))
          ? DateTime.fromISO(c.now)
              .plus({ minutes: Math.min(p.remaining_minutes ?? 25, 240) })
              .toUTC()
              .toISO()
          : null;
        if (typeof a.report === "string") {
          t.progress.last_report = text(a.report, "进展说明", 500);
          t.progress.report_source = c.source;
        }
        t.status =
          a.execution === "blocked"
            ? "blocked"
            : a.execution === "not_started"
              ? "ready"
              : "in_progress";
        const plans = registry.plans.filter(
          (x) =>
            x.target_ref.id === t.id &&
            (occurred.business_date ? x.status!=="cancelled" : ["planned", "active"].includes(x.status)),
        );
        const plan = a.plan_id
          ? plans.find((x) => x.id === a.plan_id)
          : plans
              .filter((x) => occurred.performed_at ? x.window_start<=occurred.performed_at && x.window_end>occurred.performed_at :
                occurred.business_date ? DateTime.fromISO(x.window_start,{zone:c.zone}).toISODate()===occurred.business_date : x.window_start<=c.now)
              .sort((x, y) => y.window_start.localeCompare(x.window_start))[0];
        if (a.plan_id && !plan)
          throw new AppError("ITEM_NOT_FOUND", "安排不属于该任务");
        if (plan) {
          plan.execution = p.feedback;
          plan.execution_at = occurred.performed_at ?? c.now;
          if (typeof a.next_action === "string")
            plan.next_action = a.next_action;
          if (
            ["not_started", "not_done", "blocked"].includes(String(a.execution))
          ) {
            plan.status = "expired";
            p.focus_until = null;
          }
          touch(plan);
        }
        touch(t);
        break;
      }
      case "report_habit": {
        const h = version(
            registry.habits.find((x) => x.id === a.target_id),
            a,
          ) as Habit,
          date = text(a.business_date, "日期", 10);
        day(date);
        if (
          !(HABIT_OCCURRENCE_STATUSES as readonly string[]).includes(
            String(a.status),
          )
        )
          throw new AppError("INVALID_STATUS", "无效行为状态");
        const d = c.loadDay(date),
          key = h.id + ":" + date + ":default",
          old = d.occurrences.find((x) => x.id === key);
        const definition = h.definition_history?.find(
          (x) => date <= x.effective_until,
        );
        const minimum =
          old && "minimum_quantity_snapshot" in old
            ? old.minimum_quantity_snapshot
            : definition
              ? (definition.minimum_quantity ?? null)
              : (h.minimum_quantity ?? null);
        const reportedQuantity = quantity(a.quantity);
        const reportedStatus =
          a.status === "did" &&
          minimum &&
          reportedQuantity &&
          (reportedQuantity.unit !== minimum.unit ||
            reportedQuantity.value < minimum.value)
            ? "partial"
            : (a.status as any);
        const performed = a.performed_at == null ? null : timestamp(a.performed_at);
        if (performed && (
          !["did", "partial"].includes(reportedStatus) || performed > c.now ||
          DateTime.fromISO(performed, { zone: c.zone }).toISODate() !== date
        )) throw new AppError("INVALID_PERFORMED_AT", "实际发生时间须已发生、属于报告日期，且对应已做或部分完成；未知时不要猜测");
        const nextPerformed = ["did", "partial"].includes(reportedStatus)
          ? (a.performed_at === undefined ? old?.performed_at ?? null : performed) : null;
        if (old) {
          d.corrections.push({
            id: key,
            old_status: old.status,
            new_status: reportedStatus,
            old_performed_at: old.performed_at ?? null,
            new_performed_at: nextPerformed,
            source: c.source,
            at: c.now,
          });
          old.status = reportedStatus;
          old.quantity = quantity(a.quantity);
          old.optional_target_met =
            typeof a.optional_target_met === "boolean"
              ? a.optional_target_met
              : null;
          old.source = c.source;
          old.reported_at = c.now;
          old.performed_at = nextPerformed;
          old.operation_id = c.operation;
        } else {
          const definition = h.definition_history?.find(
            (x) => date <= x.effective_until,
          );
          d.occurrences.push({
            id: key,
            habit_id: h.id,
            slot_key: "default",
            definition_version: definition?.version ?? h.version,
            min_behavior_snapshot: definition?.min_behavior ?? h.min_behavior,
            status: reportedStatus,
            minimum_quantity_snapshot: minimum,
            quantity: quantity(a.quantity),
            optional_target_met:
              typeof a.optional_target_met === "boolean"
                ? a.optional_target_met
                : null,
            source: c.source,
            reported_at: c.now,
            performed_at: nextPerformed,
            operation_id: c.operation,
          });
        }
        ids.push(h.id);
        for (const p of registry.plans)
          if (
            p.target_ref.id === h.id &&
            p.target_ref.business_date === date &&
            a.status !== "unreported"
          ) {
            p.status = "finished";
            touch(p);
          }
        break;
      }
      case "report_event": {
        const h = version(
          registry.habits.find((h) => h.id === a.target_id),
          a,
        ) as Habit;
        if (
          h.anchor.kind !== "event" ||
          h.anchor.event_key !== a.event_key ||
          h.status !== "active" ||
          !h.approval
        )
          throw new AppError(
            "EVENT_NOT_REGISTERED",
            "这个事件尚未关联已接受的习惯",
          );
        const date = DateTime.fromISO(c.now, { zone: c.zone }).toISODate()!;
        if (a.business_date && a.business_date !== date)
          throw new AppError(
            "EVENT_NOT_CURRENT",
            "历史事件只作记录，不触发现在的提示",
          );
        const record = c.loadDay(date),
          key = "event:" + h.id + ":" + date;
        if (!record.corrections.some((item) => item.id === key))
          record.corrections.push({
            id: key,
            target_kind: "habit",
            title_snapshot: h.anchor.event_key,
            old_status: "unreported",
            new_status: "occurred",
            source: c.source,
            at: c.now,
          });
        ids.push(h.id);
        break;
      }
      case "update_task_progress": {
        const t = version(
          registry.tasks.find((x) => x.id === a.target_id),
          a,
        ) as Task;
        if (["done", "cancelled", "draft"].includes(t.status))
          throw new AppError(
            "TASK_NOT_ACTIVE",
            "先明确重新打开任务，再更新进展",
          );
        const report =
          a.report === undefined ? undefined : text(a.report, "进展说明", 500);
        if (a.criterion_id === undefined) {
          if (!report)
            throw new AppError("INVALID_PROGRESS", "需要进展说明或验收条件");
        } else {
          const criterion = t.acceptance.find((x) => x.id === a.criterion_id);
          if (!criterion)
            throw new AppError("INVALID_CRITERION", "验收项不存在");
          const previous = t.progress.criteria[criterion.id],
            value = a.value == null ? null : Number(a.value);
          if (value !== null && (!Number.isFinite(value) || value < 0))
            throw new AppError("INVALID_PROGRESS", "进展应为非负数");
          if (
            criterion.kind === "count" &&
            (value !== null || a.unit !== undefined) &&
            a.unit !== criterion.unit
          )
            throw new AppError("UNIT_MISMATCH", "进展单位不同");
          if (
            value !== null &&
            !["total", "increment"].includes(String(a.mode))
          )
            throw new AppError("AMBIGUOUS_COUNT", "请明确这是新增还是累计");
          const total =
            value === null
              ? (previous?.reported_value ?? null)
              : a.mode === "increment"
                ? (previous?.reported_value ?? 0) + value
                : value;
          const status =
            criterion.verification === "tool" &&
            !c.verified?.has(verificationKey(t.id, criterion))
              ? "pending"
              : criterion.kind === "count"
                ? total !== null && total >= criterion.target!
                  ? "met"
                  : "pending"
                : (CRITERION_STATUSES as readonly string[]).includes(
                      String(a.status),
                    )
                  ? (a.status as "met" | "unmet" | "pending")
                  : (previous?.status ?? "pending");
          t.progress.criteria[criterion.id] = {
            reported_value: total,
            unit: criterion.unit,
            status,
            source_refs: [...(previous?.source_refs ?? []), c.source],
          };
        }
        if (report !== undefined) {
          t.progress.last_report = report;
          t.progress.report_source = c.source;
        }
        t.progress.verification_pending =
          a.verification_pending === true &&
          t.acceptance.some((condition) => condition.verification === "tool");
        t.status = a.task_status === "blocked" ? "blocked" : "in_progress";
        touch(t);
        break;
      }
      case "complete_task":
      case "reopen_task": {
        const occurred=reportTime(a,c);
        const t = version(
          registry.tasks.find((x) => x.id === a.target_id),
          a,
        ) as Task;
        if (!t.approval || !t.acceptance.length || t.status === "draft")
          throw new AppError("TASK_NOT_ACTIVE", "任务尚未形成有效承诺");
        const previousStatus = t.status,
          previousDoneAt = t.done_at;
        if (a.report !== undefined) {
          t.progress.last_report=text(a.report,"完成或更正说明",500);
          t.progress.report_source=c.source;
        }
        if (a.type === "complete_task") {
          if (t.status === "cancelled")
            throw new AppError("TASK_NOT_ACTIVE", "任务已取消，先明确重新打开");
          if (
            t.acceptance.some((condition) => {
              const progress = t.progress.criteria[condition.id];
              return (
                progress?.source_refs.some(
                  (source) => source.input_id === c.source.input_id,
                ) &&
                ((condition.kind === "count" &&
                  progress.reported_value !== null &&
                  progress.reported_value < condition.target!) ||
                  progress.status === "unmet")
              );
            })
          )
            throw new AppError(
              "ACCEPTANCE_CONTRADICTION",
              "本次反馈仍有未达到的条件，先记录进展",
            );
          if (
            t.acceptance.some(
              (x) =>
                x.verification === "tool" &&
                !c.verified?.has(verificationKey(t.id, x)),
            )
          )
            throw new AppError("VERIFICATION_PENDING", "工具验收尚未通过");
          for (const condition of t.acceptance) {
            const current = t.progress.criteria[condition.id];
            t.progress.criteria[condition.id] = {
              reported_value: current?.reported_value ?? null,
              unit: condition.unit,
              status: "met",
              source_refs: [
                ...(current?.source_refs ?? []),
                c.source,
                ...(c.verified?.get(verificationKey(t.id, condition))
                  ? [c.verified.get(verificationKey(t.id, condition))!]
                  : []),
              ],
            };
          }
          t.status = "done";
          t.done_at = c.now;
          t.completion_time=occurred;
          t.progress.verification_pending = false;
          if (t.planning) {
            t.planning.remaining_minutes = 0;
            t.planning.focus_until = null;
            t.planning.blocker = null;
          }
        } else {
          t.status = "in_progress";
          t.done_at = null;
          delete t.completion_time;
          t.progress.verification_pending = false;
          for (const p of Object.values(t.progress.criteria))
            p.status = "pending";
        }
        touch(t);
        c.loadDay(
          occurred.business_date ?? DateTime.fromISO(c.now, { zone: c.zone }).toISODate()!,
        ).corrections.push({
          id: t.id,
          target_kind: "task",
          title_snapshot: t.title,
          old_status: previousStatus,
          new_status: t.status,
          done_at: previousDoneAt ?? t.done_at,
          source: c.source,
          at: c.now,
        });
        if (a.type === "complete_task")
          for (const p of registry.plans)
            if (p.target_ref.id === t.id) {
              p.status = "finished";
              touch(p);
            }
        break;
      }
      case "schedule": {
        const target = version(find(a), a) as Habit | Task;
        if (
          !target.approval ||
          !["active", "ready", "in_progress", "blocked"].includes(target.status)
        )
          throw new AppError("ITEM_NOT_ACTIVE", "事项尚未启用");
        const duration = Number(a.duration_minutes),
          slot =
            a.available_windows === undefined
              ? null
              : earliestSlot(registry, a.available_windows, duration, c.now, undefined,
                  slotReserve(registry, c, a.available_windows));
        const start = timestamp(slot?.start ?? a.window_start),
          end = timestamp(slot?.end ?? a.window_end);
        const overdue=allowDeadline(registry.tasks.find(t=>t.id===target.id),end,a,c);
        if (
          end <= start ||
          !Number.isFinite(duration) ||
          duration <= 0 ||
          DateTime.fromISO(end).diff(DateTime.fromISO(start), "minutes")
            .minutes < duration
        )
          throw new AppError("INVALID_WINDOW", "工作块超出时间窗口");
        const hasConflict = registry.plans.some(
          (p) =>
            !moving.has(p.id) &&
            ["planned", "active"].includes(p.status) &&
            p.window_start < end &&
            p.window_end > start,
        );
        if (hasConflict && a.allow_reflow !== true)
          throw new AppError("SCHEDULE_CONFLICT", "时间与已有安排重叠", 409);
        const kind = registry.habits.some((h) => h.id === target.id)
          ? "habit"
          : "task";
        const date =
          typeof a.business_date === "string"
            ? a.business_date
            : DateTime.fromISO(start, { zone: c.zone }).toISODate()!;
        day(date);
        if (
          kind === "habit" &&
          registry.plans.some(
            (p) =>
              p.target_ref.id === target.id &&
              p.target_ref.business_date === date &&
              p.status !== "cancelled",
          )
        )
          throw new AppError("SCHEDULE_CONFLICT", "本次习惯已有安排", 409);
        const p: Plan = {
          ...(overdue ? {overdue_recovery:overdue} : {}),
          ...base("plan", c),
          target_ref: {
            kind,
            id: target.id,
            ...(kind === "habit" ? { business_date: date } : {}),
          },
          kind: a.kind === "fixed" ? "fixed" : "window",
          window_start: start,
          window_end: end,
          duration_minutes: duration,
          next_action: text(a.next_action, "下一步"),
          status: "planned",
          approval: accept(c),
          origin: "user",
          execution: "unknown",
        };
        registry.plans.push(p);
        if (hasConflict) {
          if (!c.planningDefaults)
            throw new AppError("SCHEDULE_CONFLICT", "时间与已有安排重叠", 409);
          const changed = reflow(
            registry,
            p.id,
            start,
            end,
            c.now,
            registry.planning_preferences ?? c.planningDefaults,
            c.zone,
            c.operation,
            // A background-initiated repair protects the day's reserve.
            c.source?.channel === "coordinator",
          );
          ids.push(...changed);
        }
        ids.push(p.id);
        break;
      }
      case "plan_day": {
        accept(c);
        const date = text(a.business_date, "日期", 10);
        day(date);
        const today = DateTime.fromISO(c.now, { zone: c.zone }).toISODate()!;
        if (
          date < today ||
          date >
            DateTime.fromISO(c.now, { zone: c.zone })
              .plus({ days: 31 })
              .toISODate()!
        )
          throw new AppError(
            "INVALID_DATE",
            "仅整理今天及未来31天的安排，不改历史",
          );
        break;
      }
      case "reject_proposal": {
        const p = version(
          registry.proposals.find((p) => p.id === a.target_id),
          a,
        ) as Registry["proposals"][number];
        p.status = "cancelled";
        touch(p);
        break;
      }
      case "reschedule": {
        if (a.plan_id !== undefined || registry.tasks.some((t) => t.id === a.target_id) || registry.habits.some((h) => h.id === a.target_id))
          throw new AppError("PLAN_TARGET_REQUIRED", "改期的target_id和expected_version须对应安排本身，不能使用任务id加plan_id");
        const p = version(
          registry.plans.find((x) => x.id === a.target_id),
          a,
        ) as Plan;
        if (p.kind === "fixed") accept(c);
        const duration = a.duration_minutes === undefined ? p.duration_minutes : Number(a.duration_minutes);
        if (!Number.isFinite(duration) || duration <= 0)
          throw new AppError("INVALID_WINDOW", "工作时长必须大于零");
        if (a.kind !== undefined && !["fixed", "window", "flexible"].includes(String(a.kind)))
          throw new AppError("INVALID_WINDOW", "无效安排类型");
        if (a.kind !== undefined) accept(c);
        const slot =
          a.available_windows === undefined
            ? null
            : earliestSlot(
                registry,
                a.available_windows,
                duration,
                c.now,
                p.id,
                slotReserve(registry, c, a.available_windows),
              );
        const start = timestamp(slot?.start ?? a.window_start),
          end = timestamp(slot?.end ?? a.window_end);
        const overdue=allowDeadline(registry.tasks.find(t=>t.id===p.target_ref.id),end,a,c);
        if (
          end <= start ||
          DateTime.fromISO(end).diff(DateTime.fromISO(start), "minutes")
            .minutes < duration
        )
          throw new AppError("INVALID_WINDOW", "无效工作窗口");
        if (
          registry.plans.some(
            (other) =>
              other.id !== p.id &&
              !moving.has(other.id) &&
              ["planned", "active"].includes(other.status) &&
              other.window_start < end &&
              other.window_end > start,
          )
        )
          throw new AppError("SCHEDULE_CONFLICT", "安排重叠", 409);
        p.window_start = start;
        p.overdue_recovery=overdue;
        p.window_end = end;
        p.duration_minutes = duration;
        if (a.kind !== undefined) p.kind = a.kind as Plan["kind"];
        if (a.next_action !== undefined) p.next_action = text(a.next_action, "下一步", 500);
        p.needs_replan = false;
        p.execution = "unknown";
        const task = registry.tasks.find((x) => x.id === p.target_ref.id);
        if (task) {
          task.planning = {
            ...taskPlanning(task),
            postponements: taskPlanning(task).postponements + 1,
            focus_until: null,
            ...(a.next_action !== undefined ? { next_action: p.next_action } : {}),
          };
          touch(task);
        }
        touch(p);
        break;
      }
      case "pause_contact": {
        // A pause aimed at an id that is not a real business object pauses
        // nothing while the assistant can still tell the user it stopped
        // everything. Refuse instead of recording a hollow control.
        if (a.target_id) {
          const exists = [
            ...registry.tasks,
            ...registry.habits,
            ...registry.plans,
            ...(registry.automations ?? []),
            ...registry.proposals,
          ].some((x) => x.id === a.target_id);
          if (!exists)
            throw new AppError(
              "PAUSE_TARGET_INVALID",
              "暂停对象不存在：需要停掉全部主动联系时不要填 target_id；只停某件事时用任务、习惯、安排或自动化的 id",
              400,
            );
        }
        const ends = a.ends_at
          ? timestamp(a.ends_at)
          : DateTime.fromISO(c.now, { zone: c.zone })
              .plus({ days: 1 })
              .startOf("day")
              .toUTC()
              .toISO()!;
        const control = {
          ...base("pause", c),
          scope: a.target_id ? ("item" as const) : ("global" as const),
          target_id: a.target_id ?? null,
          starts_at: c.now,
          ends_at: ends,
          reason_source: c.source,
        };
        registry.controls.push(control);
        ids.push(control.id);
        break;
      }
      case "resume_contact": {
        for (const p of registry.controls)
          if (
            p.ends_at > c.now &&
            (!a.target_id || p.target_id === a.target_id)
          ) {
            p.ends_at = c.now;
            touch(p);
          }
        break;
      }
      case "cancel_item": {
        accept(c);
        const target = version(find(a), a) as Habit | Task;
        if ("min_behavior" in target) target.status = "retired";
        else target.status = "cancelled";
        touch(target);
        for (const p of registry.plans)
          if (p.target_ref.id === target.id) {
            p.status = "cancelled";
            touch(p);
          }
        break;
      }
      case "remember_fact": {
        accept(c);
        if (a.kind && a.kind !== "user_confirmed")
          throw new AppError("FACT_NOT_CONFIRMED", "推测不写入稳定偏好");
        if (!c.rememberFact)
          throw new AppError("FACT_UNAVAILABLE", "偏好记录当前不可用");
        const scope = a.fact_scope === undefined
          ? undefined
          : Array.isArray(a.fact_scope) && a.fact_scope.length && a.fact_scope.length <= 8
            ? a.fact_scope.map((item) => text(item, "适用范围", 60))
            : null;
        if (scope === null) throw new AppError("INVALID_FACT", "适用范围需要1到8个短标签");
        c.rememberFact(text(a.fact, "明确偏好", 500), {
          kind: "user_reported",
          ...(a.fact_subject === undefined ? {} : { subject: text(a.fact_subject, "事实主体", 200) }),
          ...(scope === undefined ? {} : { scope }),
          ...(typeof a.valid_until === "string" ? { valid_until: timestamp(a.valid_until) } : {}),
          ...(typeof a.supersedes === "string" ? { supersedes: text(a.supersedes, "事实标识", 100) } : {}),
        });
        break;
      }
      case "forget_fact": {
        accept(c);
        if (!c.forgetFact)
          throw new AppError("FACT_UNAVAILABLE", "记忆撤销当前不可用");
        const targetId = text(a.target_id, "事实标识", 120);
        if (!Number.isInteger(a.expected_version) || Number(a.expected_version) < 1)
          throw new AppError("INVALID_VERSION", "撤销事实需要当前版本");
        c.forgetFact(targetId, Number(a.expected_version));
        break;
      }
      case "unlink_diary": {
        const link = registry.diary_links.find((x) => x.id === a.link_id);
        if (link) {
          registry.diary_links = registry.diary_links.filter(
            (x) => x.id !== link.id,
          );
          ids.push(link.target_ref.id);
        }
        break;
      }
      case "pending_diary_binding": {
        const link = registry.diary_links.find((x) => x.id === a.link_id);
        if (link) {
          link.status = "pending";
          stamp(link, c);
        }
        break;
      }
      default:
        throw new AppError(
          "ACTION_UNSUPPORTED",
          "不支持此操作：" + a.type,
          422,
        );
    }
  }
  if (moving.size) {
    const live=registry.plans.filter(p=>["planned","active"].includes(p.status));
    for (let i=0;i<live.length;i++) for (let j=i+1;j<live.length;j++) {
      const a=live[i],b=live[j];
      if ((moving.has(a.id)||moving.has(b.id)) && a.window_start<b.window_end && b.window_start<a.window_end)
        throw new AppError("SCHEDULE_CONFLICT","整批调整后的安排仍然重叠，未提交",409);
    }
  }
  return {
    ids: [...new Set(ids)],
    message: actions.some((a) => a.type === "pause_contact")
      ? "今天先不提醒了。"
      : "已记录。",
  };
}
