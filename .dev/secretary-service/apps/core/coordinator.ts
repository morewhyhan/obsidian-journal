import fs from "node:fs";
import { DateTime } from "luxon";
import type { Core } from "./core.js";
import {
  type Action,
  type Registry,
  type Day,
  type Source,
  type Plan,
  type PlanningIssue,
  type DailyPlanning,
} from "../../packages/contracts/types.js";
import {
  buildNight,
  collectIssues,
  nightMessage,
  planningSettings,
  planningFingerprint,
  taskPlanning,
  reflow,
  stampPlan,
  recoverySlot,
  boundaryAllows,
} from "../../packages/domain/planning.js";
import { prepareAutomaticBindings, createPeriod, project } from "./journal.js";
import { localDate, route, day } from "../../packages/calendar/index.js";
import { id, hash } from "./files.js";
import { visibleLines } from "../../packages/contracts/markdown.js";
import { syncFollowups, followupKey } from "../../packages/domain/followups.js";
import { ruleValue } from "../../packages/domain/assistant.js";
import { effectivePolicy } from "./policy.js";

export type PlanningNotice = {
  id: string;
  body: string;
  start: string;
  end: string;
  date: string;
  version: number;
  questionId?: string;
};
const live = (p: Plan) => ["planned", "active"].includes(p.status);
export class Coordinator {
  lastError: string | null = null;
  private lastScan = "";
  private lastBoundary: string;
  constructor(private core: Core) {
    const s = core.store,
      r = s.registry();
    this.lastBoundary = this.boundaryKey(
      r.planning_preferences ?? planningSettings(r, s.config.planning, s.now()),
    );
  }
  private boundaryKey(settings: ReturnType<typeof planningSettings>) {
    return planningFingerprint([
      settings.availability,
      settings.protected,
      settings.day_overrides,
    ]);
  }
  private get store() {
    return this.core.store;
  }
  private local() {
    return DateTime.fromJSDate(this.store.clock(), {
      zone: this.store.config.timezone,
    });
  }
  private currentPlans(r: Registry, date: string) {
    return r.plans.filter(
      (p) =>
        live(p) &&
        localDate(new Date(p.window_start), this.store.config.timezone) ===
          date,
    );
  }
  private snapshot(
    r: Registry,
    date: string,
    issues: PlanningIssue[],
    now: string,
    previous?: DailyPlanning,
    loadDay = (d: string) => this.store.day(d),
    operation = r.last_operation_id ?? "coordinator",
  ): DailyPlanning {
    const planIds = this.currentPlans(r, date).map((p) => p.id);
    const unique = [...new Map(issues.map((x) => [x.id, x])).values()];
    syncFollowups(r, unique, date, now, operation, loadDay);
    return {
      generated_at: previous?.generated_at ?? now,
      updated_at: now,
      status: unique.some((x) => x.severity !== "info" && x.question)
        ? "needs_user"
        : "ready",
      plan_ids: planIds,
      issues: unique,
      review: unique
        .filter((x) =>
          [
            "blocked",
            "stale",
            "repeated",
            "activation",
            "capacity",
            "estimate",
          ].includes(x.kind),
        )
        .slice(0, 3)
        .map((x) => x.recommendation),
      notice: previous?.notice ?? {
        key: "",
        body: "",
        starts_at: now,
        expires_at: now,
        kind: "risk",
      },
    };
  }
  private chooseQuestion(issues: PlanningIssue[], r = this.store.registry()) {
    const now = this.store.now();
    return [...issues]
      .sort(
        (a, b) => Number(b.severity === "risk") - Number(a.severity === "risk"),
      )
      .find(
        (x) =>
          x.question &&
          (ruleValue(r, "support.enabled", true, now) ||
            !["activation", "repeated"].includes(x.kind)) &&
          !r.controls.some(
            (c) =>
              (c.scope === "global" ||
                c.target_id === (x.task_id ?? x.habit_id)) &&
              c.starts_at <= now &&
              c.ends_at > now,
          ) &&
          !this.askedBefore(this.questionKey(x, r), r),
      );
  }
  private questionKey(x: PlanningIssue, r = this.store.registry()) {
    const f = r.followups?.find(
      (f) => f.status !== "resolved" && f.issue.id === x.id,
    );
    if (f) return followupKey(f, this.store.now());
    return (
      x.id +
      ":" +
      planningFingerprint([x.message, x.recommendation, x.question])
    );
  }
  private askedBefore(key: string, r = this.store.registry()) {
    if (r.followups?.some((f) => f.asked_keys.includes(key))) return true;
    return !!this.store.db
      .prepare(
        "SELECT 1 FROM outbox, json_each(outbox.source_versions_json) v WHERE v.key=? AND outbox.status IN ('sent','sending','unknown') LIMIT 1",
      )
      .get("question:" + key);
  }
  /** Recorded before network I/O, recovered with business files, and retained after outbox cleanup. */
  contactState(
    outboxId: string,
    versions: string,
    status: "sending" | "sent" | "unknown" | "failed",
    attempt: number,
  ) {
    const keys = Object.keys(JSON.parse(versions))
      .filter((k) => k.startsWith("question:followup:") || k.startsWith("question:work:"))
      .map((k) => k.slice(9));
    if (!keys.length) return;
    const s = this.store;
    s.commit(
      "followup-contact:" + outboxId + ":" + attempt + ":" + status,
      "coordinator",
      outboxId,
      (r, _load, op) => {
        for (const f of r.followups ?? []) {
          const key = keys.find((k) =>
            k.startsWith(f.id + "@" + f.fingerprint),
          );
          if (!key || f.status === "resolved") continue;
          f.contact = { key, outbox_id: outboxId, at: s.now(), status };
          if (status === "failed")
            f.asked_keys = f.asked_keys.filter((k) => k !== key);
          else if (!f.asked_keys.includes(key)) f.asked_keys.push(key);
          if (status !== "failed") f.status = "waiting_user";
          if(f.work && ["sent","unknown"].includes(status)) f.next_check_at=null;
          else if (["sent", "unknown"].includes(status))
            f.next_check_at =
              f.asked_keys.length < 2
                ? DateTime.fromISO(s.now())
                    .plus({
                      minutes: ruleValue(
                        r,
                        "support.review_after_minutes",
                        1440,
                        s.now(),
                      ),
                    })
                    .toUTC()
                    .toISO()!
                : null;
          f.version++;
          f.updated_at = s.now();
          f.last_operation_id = op;
        }
        return { ids: [], message: "跟进联系状态已保存" };
      },
    );
  }
  private publish(
    r: Registry,
    date: string,
    state: DailyPlanning,
    kind: "night" | "risk",
    now: string,
  ) {
    const q = this.chooseQuestion(state.issues, r);
    const shown = q
      ? state.issues.map((x) => (x.id === q.id ? x : { ...x, question: null }))
      : state.issues.map((x) => ({ ...x, question: null }));
    const followup = q
      ? r.followups?.find((f) => f.status !== "resolved" && f.issue.id === q.id)
      : undefined;
    const prepared =
      followup?.analysis?.status === "done" &&
      followup.analysis.fingerprint === followupKey(followup, now)
        ? followup.analysis.advice
        : null;
    const body =
      kind === "night"
        ? nightMessage(
            r,
            date,
            state.plan_ids,
            shown,
            this.store.config.timezone,
          )
        : q
          ? (prepared ?? q.message + "。" + q.recommendation + " " + q.question)
          : "";
    const expires =
      kind === "night"
        ? DateTime.fromISO(date, { zone: this.store.config.timezone })
            .startOf("day")
            .toUTC()
            .toISO()!
        : this.local().endOf("day").toUTC().toISO()!;
    const questionKey = q ? this.questionKey(q, r) : "";
    const key =
      kind +
      ":" +
      date +
      ":" +
      (kind === "night" ? "daily" : planningFingerprint(questionKey));
    state.notice = { key, body, starts_at: now, expires_at: expires, kind };
    if (q) state.notice.question_id = questionKey;
    if (
      q?.kind === "repeated" &&
      q.task_id &&
      !r.proposals.some(
        (p) => p.issue_key === questionKey && p.status === "pending",
      )
    ) {
      const t = r.tasks.find((t) => t.id === q.task_id)!;
      r.proposals.push({
        id: id("proposal"),
        version: 1,
        created_at: now,
        updated_at: now,
        last_operation_id: t.last_operation_id,
        summary:
          "暂停「" +
          t.title +
          "」的自动排程，保留成果和截止，重新明确下一步后再恢复。",
        actions: [
          {
            type: "configure_task",
            target_id: t.id,
            expected_version: t.version,
            planning: { enabled: false },
          },
        ],
        expires_at: DateTime.fromISO(now).plus({ hours: 24 }).toUTC().toISO()!,
        status: "pending",
        issue_key: questionKey,
        source: {
          input_id: "planning:" + key,
          channel: "coordinator",
          external_id: "planning:" + key,
          accepted_at: now,
          summary: q.recommendation,
        },
      });
    }
  }
  /** Called inside the business transaction, so feedback and its repair are one recoverable change. */
  afterActions(
    r: Registry,
    loadDay: (date: string) => Day,
    operation: string,
    source: Source,
    actions: Action[],
  ) {
    const s = this.store,
      now = s.now(),
      today = localDate(s.clock(), s.config.timezone),
      settings = planningSettings(r, s.config.planning, now);
    if (!settings.enabled && !actions.some((a) => a.type === "plan_day"))
      return { ids: [] as string[], message: "" };
    const autoMove = s.config.tasks.auto_reschedule_flexible_work_blocks;
    const changedIds: string[] = [],
      repairs: string[] = [],
      extra: PlanningIssue[] = [];
    if (
      actions.some(
        (a) =>
          a.type === "set_planning" &&
          ["availability", "protected", "day_overrides"].some(
            (k) => k in (a.preferences as object),
          ),
      )
    ) {
      for (const p of r.plans.filter(
        (x) =>
          live(x) &&
          x.window_end > now &&
          !boundaryAllows(x, settings, s.config.timezone),
      )) {
        const t = r.tasks.find((x) => x.id === p.target_ref.id);
        if (!t) continue;
        if (p.kind === "fixed") {
          extra.push({
            id: "conflict:" + t.id,
            kind: "conflict",
            task_id: t.id,
            severity: "risk",
            message: t.title + "与新的可用时间或休息边界冲突",
            recommendation: "固定事项保留，不擅自取消。",
            question: "这项固定安排需要调整吗？",
          });
          continue;
        }
        const slot = recoverySlot(r, t, p, now, settings, s.config.timezone);
        try {
          if (!autoMove || !taskPlanning(t).enabled || !slot)
            throw new Error("NO_CAPACITY");
          changedIds.push(
            ...reflow(
              r,
              p.id,
              slot.start,
              slot.end,
              now,
              settings,
              s.config.timezone,
              operation,
            ),
          );
          repairs.push(t.title + "已移出新的休息时段，截止不变");
        } catch {
          p.needs_replan = true;
          stampPlan(p, now, operation);
          changedIds.push(p.id);
          extra.push({
            id: "conflict:" + t.id,
            kind: "conflict",
            task_id: t.id,
            severity: "risk",
            message:
              t.title + (autoMove ? "排不进新空档" : "需要重新确认工作窗口"),
            recommendation: "原截止保留，这个工作提醒暂停。",
            question: "建议补一个可用时段，或决定移开哪项安排？",
          });
        }
      }
    }
    for (const a of actions.filter((x) => x.type === "report_execution")) {
      const t = r.tasks.find((x) => x.id === a.target_id);
      if (!t) continue;
      const c = taskPlanning(t);
      if (
        ["started", "progress"].includes(String(a.execution)) &&
        typeof a.remaining_minutes === "number" &&
        a.remaining_minutes > 0
      ) {
        const p = r.plans
          .filter(
            (x) => live(x) && x.target_ref.id === t.id && x.window_start <= now,
          )
          .sort((x, y) => y.window_start.localeCompare(x.window_start))[0];
        const end = DateTime.fromISO(now)
          .plus({ minutes: a.remaining_minutes })
          .toUTC()
          .toISO()!;
        if (p && end > p.window_end) {
          try {
            if (p.kind === "fixed" || !autoMove || !c.enabled)
              throw new Error("APPROVAL_REQUIRED");
            changedIds.push(
              ...reflow(
                r,
                p.id,
                p.window_start,
                end,
                now,
                settings,
                s.config.timezone,
                operation,
              ),
            );
            repairs.push(
              t.title +
                "继续到" +
                DateTime.fromISO(end, { zone: s.config.timezone }).toFormat(
                  "HH:mm",
                ) +
                "，相关弹性安排已调整，固定事项照常",
            );
          } catch {
            p.needs_replan = true;
            stampPlan(p, now, operation);
            changedIds.push(p.id);
            extra.push({
              id: "conflict:" + t.id,
              kind: "conflict",
              task_id: t.id,
              severity: "risk",
              message: t.title + "无法直接延长",
              recommendation:
                "原截止、固定事项和休息保留，受影响的提醒已暂停。",
              question: "需要移开哪项弹性安排，还是另定工作窗口？",
            });
          }
        } else if (!p && c.remaining_minutes && c.next_action && !c.blocker) {
          const placed = buildNight(
            r,
            today,
            now,
            settings,
            s.config.timezone,
            operation,
            loadDay,
            [t.id],
            autoMove,
          );
          changedIds.push(...placed.plan_ids);
        }
      }
      if (a.execution === "blocked")
        repairs.push(t.title + "的阻碍已记下，原工作提醒已停止");
      if (["not_done", "not_started"].includes(String(a.execution))) {
        c.postponements++;
        const placed = buildNight(
          r,
          today,
          now,
          settings,
          s.config.timezone,
          operation,
          loadDay,
          [t.id],
          autoMove,
        );
        const newPlan = r.plans.find(
          (p) => placed.plan_ids.includes(p.id) && p.target_ref.id === t.id,
        );
        if (newPlan) {
          changedIds.push(newPlan.id);
          repairs.push(
            t.title +
              "移到" +
              DateTime.fromISO(newPlan.window_start, {
                zone: s.config.timezone,
              }).toFormat("HH:mm") +
              "，截止不变",
          );
        } else repairs.push(t.title + "本次未完成已记下，保留待安排；截止不变");
      }
    }
    for (const a of actions.filter((a) => a.type === "plan_day")) {
      const date = String(a.business_date);
      const result = buildNight(
        r,
        date,
        now,
        settings,
        s.config.timezone,
        operation,
        loadDay,
        undefined,
        autoMove,
      );
      const record = loadDay(date);
      record.assistance = {
        status: "pending",
        revision: r.revision,
        attempts: 0,
        request_id: operation,
      };
      record.planning = this.snapshot(
        r,
        date,
        result.issues,
        now,
        record.planning,
        loadDay,
        operation,
      );
      this.publish(r, date, record.planning, "night", now);
      repairs.push(
        nightMessage(
          r,
          date,
          result.plan_ids,
          result.issues,
          s.config.timezone,
        ),
      );
      record.planning.notice.expires_at = now;
      changedIds.push(...result.plan_ids);
    }
    const meaningful = actions.some((a) =>
      [
        "set_planning",
        "configure_task",
        "update_task",
        "report_execution",
        "update_task_progress",
        "schedule",
        "reschedule",
        "complete_task",
        "cancel_item",
        "create_task",
        "plan_day",
        "report_habit",
        "update_habit",
      ].includes(a.type),
    );
    if (!meaningful) return { ids: changedIds, message: repairs.join("；") };
    const record = loadDay(today);
    const old = record.planning;
    record.planning = this.snapshot(
      r,
      today,
      [
        ...extra,
        ...collectIssues(r, today, now, settings, s.config.timezone, loadDay),
      ],
      now,
      old,
      loadDay,
      operation,
    );
    // Replies explain repairs immediately; do not send a second proactive copy of the same interaction.
    record.planning.notice.expires_at = now;
    const q = this.chooseQuestion(extra, r);
    if (q) repairs.push(q.message + "。" + q.recommendation + q.question);
    const tomorrow = this.local().plus({ days: 1 }).toISODate()!;
    const next = loadDay(tomorrow);
    if (next.planning) {
      const planned = buildNight(
        r,
        tomorrow,
        now,
        settings,
        s.config.timezone,
        operation,
        loadDay,
        undefined,
        autoMove,
      );
      next.planning = this.snapshot(
        r,
        tomorrow,
        planned.issues,
        now,
        next.planning,
        loadDay,
        operation,
      );
      next.planning.plan_ids = planned.plan_ids;
      this.publish(r, tomorrow, next.planning, "night", now);
      changedIds.push(...planned.plan_ids);
    }
    void source;
    return { ids: [...new Set(changedIds)], message: repairs.join("；") };
  }
  async tick() {
    const local = this.local(),
      now = this.store.now(),
      today = local.toISODate()!,
      boundary = this.boundaryKey(
        planningSettings(
          this.store.registry(),
          this.store.config.planning,
          now,
        ),
      );
    const scanKey =
      today +
      ":" +
      Math.floor(local.toMillis() / 300000) +
      ":" +
      this.store.registry().revision +
      ":" +
      boundary;
    if (scanKey === this.lastScan) return;
    try {
      await this.store.exclusive(() => {
        this.core.recoverPending();
        let r = this.store.registry();
        const settings = planningSettings(r, this.store.config.planning, now);
        if (
          !settings.enabled || !effectivePolicy(this.store,r).capabilities.background_write
        )
          return;
        if (
          boundary !== this.lastBoundary &&
          r.plans.some(
            (p) =>
              live(p) &&
              !p.needs_replan &&
              p.window_end > now &&
              !boundaryAllows(p, settings, this.store.config.timezone),
          )
        ) {
          const repaired = this.store.commit(
            "planning-boundary:" + scanKey,
            "coordinator",
            scanKey,
            (registry, load, operation) => {
              const result = this.afterActions(
                registry,
                load,
                operation,
                {
                  input_id: scanKey,
                  external_id: scanKey,
                  channel: "coordinator",
                  accepted_at: now,
                  summary: "有效时间规则改变",
                },
                [
                  {
                    type: "set_planning",
                    preferences: {
                      availability: settings.availability,
                      protected: settings.protected,
                      day_overrides: settings.day_overrides,
                    },
                  },
                ],
              );
              return {
                ids: result.ids,
                message: result.message || "时间边界已重新检查",
              };
            },
          );
          this.core.recoverPending();
          this.core.cancelInvalidContact();
          this.core.emit("item_changed", { ids: repaired.updated_ids });
          r = this.store.registry();
        }
        this.lastBoundary = boundary;
        const tomorrow = local.plus({ days: 1 }).toISODate()!;
        this.ensureDiary(tomorrow);
        const nightDue =
          local.toFormat("HH:mm") >= settings.evening_time &&
          !this.store.day(tomorrow).planning;
        const hasItems =
          r.tasks.some(
            (x) =>
              x.approval && !["draft", "done", "cancelled"].includes(x.status),
          ) || r.habits.some((x) => x.approval && x.status === "active");
        if (!hasItems) return;
        const issues = collectIssues(
          r,
          today,
          now,
          settings,
          this.store.config.timezone,
          (d) => this.store.day(d),
        );
        const old = this.store.day(today).planning;
        for (const t of r.tasks.filter(
          (x) =>
            x.status === "blocked" &&
            x.planning?.blocker?.review_at &&
            x.planning.blocker.review_at <= now,
        )) {
          const blocker = t.planning!.blocker!;
          issues.push({
            id: "blocked:" + t.id + ":" + blocker.review_at,
            kind: "blocked",
            task_id: t.id,
            severity: "decision",
            message: t.title + "到了约定的检查时间",
            recommendation:
              "上次在等：" +
              blocker.detail +
              "。先核对条件是否就绪，其他事项照常。",
            question: "这项现在可以继续了吗？",
          });
        }
        const actionable = this.chooseQuestion(
          issues.filter(
            (x) =>
              (x.severity === "risk" ||
                (["blocked", "activation", "repeated"].includes(x.kind) &&
                  x.question !== null)) &&
              !(
                this.store.day(tomorrow).planning?.notice.kind === "night" &&
                this.store.day(tomorrow).planning!.notice.expires_at > now &&
                this.store.day(tomorrow).planning!.notice.question_id ===
                  this.questionKey(x)
              ),
          ),
        );
        const preview = structuredClone(r);
        syncFollowups(preview, issues, today, now, "preview", (d) =>
          this.store.day(d),
        );
        const materialChanged =
          JSON.stringify(preview.followups ?? []) !==
          JSON.stringify(r.followups ?? []);
        const reviewDue =
          materialChanged ||
          (old &&
            planningFingerprint(old.issues) !== planningFingerprint(issues));
        if (!nightDue && !reviewDue && !actionable) return;
        const result = this.store.commit(
          "planning-cycle:" + scanKey,
          "coordinator",
          scanKey,
          (registry, loadDay, operation) => {
            const record = loadDay(today);
            if (reviewDue || actionable) {
              record.planning = this.snapshot(
                registry,
                today,
                issues,
                now,
                record.planning,
                loadDay,
                operation,
              );
              if (actionable)
                this.publish(registry, today, record.planning, "risk", now);
              else record.planning.notice.expires_at = now;
            }
            if (nightDue) {
              const built = buildNight(
                registry,
                tomorrow,
                now,
                settings,
                this.store.config.timezone,
                operation,
                loadDay,
                undefined,
                this.store.config.tasks.auto_reschedule_flexible_work_blocks,
              );
              const next = loadDay(tomorrow);
              next.planning = this.snapshot(
                registry,
                tomorrow,
                built.issues,
                now,
                undefined,
                loadDay,
                operation,
              );
              next.planning.plan_ids = built.plan_ids;
              this.publish(registry, tomorrow, next.planning, "night", now);
              return { ids: built.plan_ids, message: "明日安排已整理" };
            }
            return { ids: [], message: "安排风险已检查" };
          },
        );
        this.core.recoverPending();
        this.ensureDiary(tomorrow);
        this.core.emit("item_changed", { ids: result.updated_ids });
      });
      this.lastScan =
        today +
        ":" +
        Math.floor(local.toMillis() / 300000) +
        ":" +
        this.store.registry().revision +
        ":" +
        boundary;
      this.lastError = null;
    } catch {
      this.lastError = "PLANNING_FAILED";
    }
  }
  ensureDiary(date: string, acceptedExecution = false) {
    const r = this.store.registry(),
      settings = planningSettings(
        r,
        this.store.config.planning,
        this.store.now(),
      );
    if (!settings.auto_create_daily || (!this.store.day(date).planning && !acceptedExecution)) return;
    const result = createPeriod(this.store, "daily", date);
    const ids = [
      ...new Set([
        ...r.habits
          .filter(
            (h) =>
              h.status === "active" &&
              h.approval &&
              h.recurrence.weekdays.includes(DateTime.fromISO(date).weekday) &&
              h.recurrence.starts_on <= date &&
              (!h.recurrence.ends_on || h.recurrence.ends_on >= date),
          )
          .map((h) => h.id),
        ...this.currentPlans(r, date).map((p) => p.target_ref.id),
      ]),
    ];
    const unbound = ids.some(
      (target) =>
        !r.diary_links.some(
          (x) => x.target_ref.id === target && x.path === result.path,
        ),
    );
    if (unbound)
      this.store.commit(
        "planning-bind:" + date + ":" + planningFingerprint(ids),
        "coordinator",
        date,
        (registry, _, op) => {
          prepareAutomaticBindings(registry, this.store, date, ids, op);
          return { ids, message: "按模板绑定明日事项" };
        },
      );
    project(this.store, ids);
    if (result.created.length || unbound)
      this.core.emit("document_changed", { path: result.path });
  }
  notices(): PlanningNotice[] {
    if (
      !planningSettings(
        this.store.registry(),
        this.store.config.planning,
        this.store.now(),
      ).enabled
    )
      return [];
    const now = this.store.now();
    const r = this.store.registry();
    return [
      this.local().toISODate()!,
      this.local().plus({ days: 1 }).toISODate()!,
    ].flatMap((date) => {
      const planning = this.store.day(date).planning,
        notice = planning?.notice;
      const assistance = this.store.day(date).assistance;
      if (
        notice?.kind === "night" &&
        this.core.agent &&
        (!assistance || ["pending", "running"].includes(assistance.status))
      )
        return [];
      if (notice?.question_id?.startsWith("followup:")) {
        const questionId = notice.question_id;
        const f = r.followups?.find((f) =>
          questionId.startsWith(f.id + "@" + f.fingerprint),
        );
        if (
          !f ||
          f.status === "resolved" ||
          f.asked_keys.includes(questionId) ||
          r.controls.some(
            (c) =>
              c.starts_at <= now &&
              c.ends_at > now &&
              (c.scope === "global" ||
                c.target_id === (f.issue.task_id ?? f.issue.habit_id)),
          )
        )
          return [];
        if (
          ["activation", "repeated"].includes(f.issue.kind) &&
          (!ruleValue(r, "support.enabled", true, now) ||
            (this.core.agent &&
              (!f.analysis || f.analysis.status === "running")))
        )
          return [];
      }
      if (
        !notice ||
        !notice.body ||
        !notice.key ||
        notice.starts_at > now ||
        notice.expires_at <= now
      )
        return [];
      return [
        {
          id: "planning:" + notice.key,
          body: notice.body,
          start: notice.starts_at,
          end: notice.expires_at,
          date,
          version: 1,
          questionId: notice.question_id,
        },
      ];
    });
  }
  view(date: string) {
    day(date);
    const r = this.store.registry(),
      record = this.store.day(date),
      now = this.store.now();
    const settings = planningSettings(r, this.store.config.planning, now);
    const issues =
      record.planning?.issues ??
      collectIssues(r, date, now, settings, this.store.config.timezone, (d) =>
        this.store.day(d),
      );
    const plans = this.currentPlans(r, date)
      .sort((a, b) => a.window_start.localeCompare(b.window_start))
      .map((p) => ({
        ...p,
        title:
          r.tasks.find((t) => t.id === p.target_ref.id)?.title ??
          r.habits.find((h) => h.id === p.target_ref.id)?.title,
        preparation: this.preparation(p, true),
      }));
    return {
      date,
      status:
        date < this.local().toISODate()!
          ? "closed"
          : (record.planning?.status ?? "not_prepared"),
      generated_at: record.planning?.generated_at ?? null,
      updated_at: record.planning?.updated_at ?? null,
      plans,
      issues,
      followups: (r.followups ?? []).filter((f) => f.status !== "resolved"),
      review: record.planning?.review ?? [],
      preferences: settings,
      version: r.planning_version ?? 0,
      diary: this.store.files.actualPath(route("daily", date)),
      habits: r.habits
        .filter(
          (h) =>
            h.approval &&
            h.status === "active" &&
            h.recurrence.starts_on <= date &&
            (!h.recurrence.ends_on || h.recurrence.ends_on >= date) &&
            h.recurrence.weekdays.includes(DateTime.fromISO(date).weekday),
        )
        .map((h) => ({
          id: h.id,
          title: h.title,
          min_behavior: h.min_behavior,
          anchor: h.anchor,
          occurrence:
            record.occurrences.find((o) => o.habit_id === h.id) ?? null,
        })),
    };
  }
  preparation(p: Pick<Plan, "target_ref">, includeContent = false) {
    const r = this.store.registry();
    const target =
      r.tasks.find((t) => t.id === p.target_ref.id) ??
      r.habits.find((h) => h.id === p.target_ref.id);
    return (target?.note_refs ?? [])
      .filter(
        (x) =>
          x.relation === "method" ||
          x.relation === "evidence" ||
          x.relation === "plan" ||
          x.relation === "motivation",
      )
      .flatMap((x) => {
        try {
          if (!fs.existsSync(this.store.files.resolve(x.path))) return [];
          if (!includeContent)
            return [
              {
                path: x.path,
                heading: x.heading,
                relation: x.relation,
                excerpt: "",
                hash: "",
              },
            ];
          const allowed =
            !x.path.startsWith("01. Daily/") ||
            (x.heading &&
              !["禅", "随笔", "改进", "善意与美好"].includes(x.heading));
          if (!allowed)
            return [
              {
                path: x.path,
                heading: x.heading,
                relation: x.relation,
                excerpt: "",
                hash: "",
              },
            ];
          const content = this.store.files.read(x.path),
            lines = visibleLines(content);
          let start = 0,
            end = lines.length;
          if (x.heading) {
            start = lines.findIndex(
              (l) =>
                l.visible &&
                /^#+\s/.test(l.text) &&
                l.text.replace(/^#+\s+/, "").trim() === x.heading,
            );
            if (start < 0)
              return [
                {
                  path: x.path,
                  heading: x.heading,
                  relation: x.relation,
                  excerpt: "",
                  hash: hash(content),
                },
              ];
            const level = lines[start].text.match(/^#+/)![0].length;
            end = start + 1;
            while (
              end < lines.length &&
              !(
                lines[end].visible &&
                new RegExp("^#{1," + level + "} ").test(lines[end].text)
              )
            )
              end++;
            start++;
          }
          const excerpt = lines
            .slice(start, end)
            .filter((l) => l.visible)
            .map((l) => l.text)
            .join("\n")
            .slice(0, 1000);
          return [
            {
              path: x.path,
              heading: x.heading,
              relation: x.relation,
              excerpt,
              hash: hash(content),
            },
          ];
        } catch {
          return [];
        }
      })
      .slice(0, 2);
  }
}
