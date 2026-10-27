import { DateTime } from "luxon";
import type { Registry } from "../../packages/contracts/types.js";
import { localDate } from "../../packages/calendar/index.js";
import { hash, id, canonicalJson } from "./files.js";
import { Lease } from "./deadline.js";
import type { Core } from "./core.js";
import { effectivePolicy } from "./policy.js";
import { followupKey } from "../../packages/domain/followups.js";
import { planningSettings } from "../../packages/domain/planning.js";
import {
  currentFocus,
  inQuiet,
  quietHours,
  ruleValue,
} from "../../packages/domain/assistant.js";
export interface Channel {
  send(message: {
    id: string;
    recipient: string;
    body: string;
  }): Promise<
    | { status: "sent"; externalId: string }
    | { status: "failed"; reason: string }
    | { status: "unknown"; reason: string }
  >;
  health(): { connected: boolean; lastEventAt: string | null };
}
type Candidate = {
  id: string;
  target: {
    kind: "habit" | "task" | "planning" | "automation" | "focus" | "work";
    id: string;
    business_date?: string;
    occurrence_id?: string;
  };
  noticeBody?: string;
  questionId?: string;
  version: number;
  targetVersion: number;
  start: string;
  end: string;
  text: string;
  due: string | null;
  contactClass?: "subscription" | "suggestion";
  quietException?: boolean;
  members?: Candidate[];
};
export class Scheduler {
  private languageTask?:Promise<void>;
  private language = new Map<string, string>();
  private languageRetryAfter = new Map<string, number>();
  busy = false;
  readonly tickLease = new Lease("tick", 120_000);
  lastTick: string | null = null;
  lastError: string | null = null;
  private idle: Promise<void> = Promise.resolve();
  private releaseIdle?: () => void;
  private stopped = false;
  constructor(
    public core: Core,
    public channel: Channel,
    public recipient: string,
  ) {}
  private quiet() {
    const s = this.core.store;
    return inQuiet(
      s.now(),
      s.config.timezone,
      quietHours(s.registry(), s.config.notifications.quiet_hours, s.now()),
    );
  }
  private paused(r: Registry, target: string) {
    const now = this.core.store.now();
    return r.controls.some(
      (p) =>
        p.starts_at <= now &&
        p.ends_at > now &&
        (p.scope === "global" || p.target_id === target),
    );
  }
  candidates(r: Registry) {
    const { store } = this.core,
      date = localDate(store.clock(), store.config.timezone),
      now = store.now(),
      items: Candidate[] = [];
    const planning = planningSettings(r, store.config.planning, now);
    const focus = currentFocus(r, (d) => store.day(d));
    for (const p of r.plans.filter((x) =>
      ["planned", "active"].includes(x.status),
    )) {
      const target =
        p.target_ref.kind === "habit"
          ? r.habits.find((x) => x.id === p.target_ref.id)
          : r.tasks.find((x) => x.id === p.target_ref.id);
      if (
        !target?.approval ||
        (p.target_ref.kind === "habit" &&
          "reminder_mode" in target &&
          target.reminder_mode === "off") ||
        !["active", "ready", "in_progress"].includes(target.status) ||
        p.needs_replan ||
        ("progress" in target && target.progress.verification_pending) ||
        ("planning" in target &&
          target.planning &&
          ((target.planning.focus_until && target.planning.focus_until > now) ||
            target.planning.depends_on.some(
              (dep) => r.tasks.find((t) => t.id === dep)?.status !== "done",
            ) ||
            target.planning.postponements >= planning.postponement_threshold))
      )
        continue;
      items.push({
        id: p.id,
        target: p.target_ref,
        version: p.version,
        targetVersion: target.version,
        start: p.window_start,
        end: p.window_end,
        text:
          p.next_action +
          this.core.coordinator
            .preparation(p)
            .map(
              (ref) =>
                "（[[" +
                ref.path.replace(/\.md$/, "") +
                (ref.heading ? "#" + ref.heading : "") +
                "]]）",
            )
            .join(""),
        due: "due_at" in target ? target.due_at : null,
        contactClass: "subscription",
      });
    }
    // A window can cross midnight; the opportunity still belongs to its start date.
    for (const h of r.habits.filter(
      (x) =>
        x.status === "active" &&
        x.approval &&
        x.anchor.kind === "time_window" &&
        (x.reminder_mode ?? "window") === "window",
    )) {
      for (const businessDate of [
        DateTime.fromISO(date).minus({ days: 1 }).toISODate()!,
        date,
      ]) {
        if (
          !h.recurrence.weekdays.includes(
            DateTime.fromISO(businessDate).weekday,
          ) ||
          h.recurrence.starts_on > businessDate ||
          (h.recurrence.ends_on && h.recurrence.ends_on < businessDate)
        )
          continue;
        if (
          r.plans.some(
            (p) =>
              p.target_ref.id === h.id &&
              p.target_ref.business_date === businessDate &&
              p.status !== "cancelled",
          )
        )
          continue;
        const anchor = h.anchor as { local_start: string; local_end: string },
          start = DateTime.fromISO(businessDate + "T" + anchor.local_start, {
            zone: store.config.timezone,
          }),
          end = DateTime.fromISO(businessDate + "T" + anchor.local_end, {
            zone: store.config.timezone,
          });
        items.push({
          id: "habit:" + h.id + ":" + businessDate,
          target: { kind: "habit", id: h.id, business_date: businessDate },
          version: h.version,
          targetVersion: h.version,
          start: start.toUTC().toISO()!,
          end: (end <= start ? end.plus({ days: 1 }) : end).toUTC().toISO()!,
          text: h.min_behavior,
          due: null,
          contactClass: "subscription",
        });
      }
    }
    for (const h of r.habits.filter(
      (x) =>
        x.status === "active" &&
        x.approval &&
        x.anchor.kind === "event" &&
        (x.reminder_mode ?? "window") === "window",
    )) {
      const occurred = store
        .day(date)
        .corrections.find(
          (x) =>
            x.id === "event:" + h.id + ":" + date &&
            x.new_status === "occurred",
        );
      if (
        !occurred ||
        r.plans.some(
          (p) =>
            p.target_ref.id === h.id &&
            p.target_ref.business_date === date &&
            p.status !== "cancelled",
        )
      )
        continue;
      items.push({
        id: "habit:" + h.id + ":" + date,
        target: { kind: "habit", id: h.id, business_date: date },
        version: h.version,
        targetVersion: h.version,
        start: occurred.at,
        end: DateTime.fromISO(date, { zone: store.config.timezone })
          .plus({ days: 1 })
          .startOf("day")
          .toUTC()
          .toISO()!,
        text: h.min_behavior,
        due: null,
        contactClass: "subscription",
      });
    }
    for(const f of r.followups??[]) {
      if(!f.work || f.work.owner!=="user" || f.status!=="waiting_user" || f.next_check_at && f.next_check_at>now)continue;
      const question=followupKey(f,now);
      if(f.asked_keys.includes(question) || f.asked_keys.length>=2 || r.controls.some(c=>c.starts_at<=now && c.ends_at>now &&
        (c.scope==="global" || c.target_id===f.id || f.work!.refs?.some(ref=>ref.id===c.target_id))))continue;
      items.push({id:"work-notice:"+question,target:{kind:"work",id:f.id},version:1,targetVersion:1,
        start:f.next_check_at??f.updated_at,end:DateTime.fromISO(f.next_check_at??f.updated_at).plus({days:1}).toUTC().toISO()!,
        text:f.work.next_action,noticeBody:f.work.summary+"；"+f.work.next_action,questionId:question,
        due:f.next_check_at??f.updated_at,contactClass:"suggestion"});
    }
    for (const notice of this.core.coordinator.notices())
      items.push({
        id: notice.id,
        target: { kind: "planning", id: notice.id, business_date: notice.date },
        version: notice.version,
        targetVersion: notice.version,
        start: notice.start,
        end: notice.end,
        text: notice.body,
        noticeBody: notice.body,
        questionId: notice.questionId,
        due: notice.start,
        contactClass: notice.id.includes("planning:night:")
          ? "subscription"
          : "suggestion",
      });
    for (const o of this.core.assistant.occurrences()) {
      const a =
        o.kind === "automation"
          ? r.automations?.find((x) => x.id === o.automation_id)
          : focus;
      if (
        o.status !== "scheduled" ||
        !a ||
        a.version !== o.version ||
        o.report ||
        ("last_attempted_at" in a &&
          a.last_attempted_at &&
          o.due_at <= a.last_attempted_at) ||
        ("status" in a && ["paused", "retired", "cancelled"].includes(a.status))
      )
        continue;
      if (
        o.kind === "automation" &&
        "kind" in a &&
        ["hourly_checkin", "status_check"].includes(a.kind) &&
        !("strict" in a && a.strict) &&
        focus?.status === "active" &&
        focus.phase === "working" &&
        ruleValue(r, "contact.focus_protection", true, now)
      )
        continue;
      if (
        o.kind === "automation" &&
        "kind" in a &&
        a.kind === "status_check" &&
        (o.checkin_status === "skip" || (this.core.agent && !o.checkin_status))
      )
        continue;
      const check =
        o.kind === "automation" && "kind" in a && a.kind === "status_check"
          ? this.core.assistant.knownBusy()
            ? null
            : { body: o.checkin_status === "ready" ? o.body : a.body }
          : undefined;
      if (check === null) continue;
      items.push({
        id: "occ:" + o.slot_key,
        target: {
          kind: o.kind,
          id: o.automation_id,
          business_date: o.business_date,
          occurrence_id: o.id,
        },
        version: o.version,
        targetVersion: o.version,
        start: o.due_at,
        end: o.expires_at,
        text: check?.body ?? o.body,
        noticeBody: check?.body ?? o.body,
        due: o.due_at,
        contactClass: "subscription",
        quietException: o.quiet_exception,
      });
    }
    const available = items
      .filter(
        (x) =>
          x.start <= now &&
          x.end > now &&
          !(
            focus?.status === "active" &&
            focus.phase === "working" &&
            ruleValue(r, "contact.focus_protection", true, now) &&
            (x.target.kind === "habit" ||
              (x.target.kind === "task" &&
                r.plans.find((p) => p.id === x.id)?.kind !== "fixed"))
          ) &&
          !this.paused(r, x.target.id) &&
          !(
            x.target.kind === "habit" &&
            store
              .day(x.target.business_date!)
              .occurrences.some(
                (o) => o.habit_id === x.target.id && o.status !== "unreported",
              )
          ),
      )
      .sort(
        (a, b) =>
          (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
          a.start.localeCompare(b.start) ||
          a.id.localeCompare(b.id),
      );
    const groups = new Map<string, Candidate[]>();
    for (const c of available) {
      // An exact user-specified message must not depend on another item's LLM composition.
      if(this.literal(c)!==null)continue;
      if (c.contactClass !== "subscription" || !this.permitted(c.target.id, c))
        continue;
      const occupied = store.db
        .prepare(
          "SELECT 1 FROM outbox o,json_each(o.source_versions_json) v WHERE v.key=? AND o.status IN ('sent','sending','unknown','abandoned') LIMIT 1",
        )
        .get(c.id);
      if (occupied) continue;
      const key =
        c.start.slice(0, 16) +
        ":" +
        (this.quiet() ? !!c.quietException : "awake");
      const group = groups.get(key) ?? [];
      group.push(c);
      groups.set(key, group);
    }
    const merged = new Set<string>(),
      output: Candidate[] = [];
    for (const group of groups.values())
      for (let n = 0; n < group.length; n += 3) {
        const part = group.slice(n, n + 3);
        if (
          part.length < 2 ||
          part.map((c) => this.body(c)).join("\n").length > 1800
        )
          continue;
        part.forEach((c) => merged.add(c.id));
        output.push({
          ...part[0],
          id:
            "merged:" +
            hash(
              part
                .map((c) => c.id)
                .sort()
                .join("|"),
            ),
          members: part,
          noticeBody: part.map((c) => this.body(c)).join("\n"),
          end: part.map((c) => c.end).sort()[0],
        });
      }
    return [...available.filter((c) => !merged.has(c.id)), ...output].sort(
      (a, b) =>
        (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
        a.id.localeCompare(b.id),
    );
  }
  private permitted(targetId: string, candidate?: Candidate) {
    const store = this.core.store;
    return (
      effectivePolicy(store).capabilities.contact &&
      store.state.acceptsBackground() &&
      !this.paused(store.registry(), targetId) &&
      (!this.quiet() || !!candidate?.quietException) &&
      (!store.recoveryUntil || store.recoveryUntil <= store.now())
    );
  }
  private budget(
    candidate?: Candidate,
    subscription = candidate?.contactClass === "subscription",
  ) {
    const { store } = this.core,
      now = store.clock(),
      date = localDate(now, store.config.timezone);
    let count = 0,
      last = "",
      lastAny = "",
      subscriptions = 0;
    for (const row of store.db
      .prepare(
        "SELECT attempts_json,source_versions_json FROM outbox WHERE counts_as_proactive=1",
      )
      .all() as any[]) {
      const occupied = (JSON.parse(row.attempts_json) as any[]).filter((x) =>
        ["sending", "sent", "unknown"].includes(x.result),
      );
      const isSubscription =
        JSON.parse(row.source_versions_json)["contact:subscription"] === 1;
      if (occupied.some((x) => x.business_date === date)) {
        if (isSubscription) subscriptions++;
        else count++;
      }
      for (const a of occupied) {
        if (a.at > lastAny) lastAny = a.at;
        if (!isSubscription && a.at > last) last = a.at;
      }
    }
    const r = store.registry(),
      planning = planningSettings(r, store.config.planning, store.now());
    if (subscription)
      return (
        subscriptions < 60 &&
        (!lastAny || now.getTime() - Date.parse(lastAny) >= 10000)
      );
    const reserve =
      candidate?.target.kind !== "planning" &&
      planning.enabled &&
      DateTime.fromJSDate(now, { zone: store.config.timezone }).toFormat(
        "HH:mm",
      ) < planning.evening_time &&
      r.tasks.some(
        (t) =>
          !!t.approval &&
          ["ready", "in_progress", "blocked"].includes(t.status),
      )
        ? 1
        : 0;
    return (
      count <
        ruleValue(
          r,
          "contact.suggestion_cap",
          store.config.notifications.daily_proactive_message_cap,
          store.now(),
        ) -
          reserve &&
      (!last ||
        now.getTime() - Date.parse(last) >=
          ruleValue(
            r,
            "contact.minimum_gap_minutes",
            store.config.notifications.minimum_gap_minutes,
            store.now(),
          ) *
            60000)
    );
  }
  private body(candidate: Candidate) {
    if (candidate.noticeBody) return candidate.noticeBody;
    const start = DateTime.fromISO(candidate.start)
        .setZone(this.core.store.config.timezone)
        .toFormat("HH:mm"),
      end = DateTime.fromISO(candidate.end)
        .setZone(this.core.store.config.timezone)
        .toFormat("HH:mm");
    if (candidate.target.kind === "habit")
      return "现在方便的话，" + candidate.text + "。";
    return (
      candidate.text +
      (candidate.due
        ? "；截止 " +
          DateTime.fromISO(candidate.due, {
            zone: this.core.store.config.timezone,
          }).toFormat("MM-dd HH:mm")
        : "") +
      "。这段到" +
      end +
      "。"
    );
  }
  private languageKey(candidate: Candidate, followUp: boolean) {
    const r = this.core.store.registry();
    return hash(canonicalJson([candidate, followUp, r.rules_revision, r.planning_version]));
  }
  private literal(candidate: Candidate) {
    if (candidate.target.kind !== "automation" || candidate.members) return null;
    const a = this.core.store.registry().automations?.find(a => a.id === candidate.target.id);
    return a?.kind === "one_shot" ? a.body : null;
  }
  private async prepareLanguage() {
    if (this.core.agent?.executionMode !== "tools-v2" || !this.core.agent.compose) return;
    if (!this.channel.health().connected) return;
    // No write lock is held during model I/O. Revalidation below protects any
    // completion, pause, rule change or reschedule that happens while it runs.
    let generated = 0;
    for (const candidate of this.candidates(this.core.store.registry())) {
      if (!this.permitted(candidate.target.id, candidate) || this.literal(candidate) !== null) continue;
      const sent = this.core.store.db.prepare("SELECT count(*) n FROM outbox o,json_each(o.source_versions_json) v WHERE v.key=? AND o.status IN ('sent','sending','unknown','abandoned')")
        .get(candidate.id) as { n: number };
      const cap = candidate.members || ["planning", "automation", "focus"].includes(candidate.target.kind) ? 1 : this.core.store.config.notifications.per_plan_reminder_cap;
      if (sent.n >= cap) continue;
      const followUp = sent.n > 0;
      if (!this.budget(candidate, !followUp && candidate.contactClass === "subscription")) continue;
      const key = this.languageKey(candidate, followUp);
      if (this.language.has(key) || (this.languageRetryAfter.get(key) ?? 0) > Date.now()) continue;
      if (generated++ >= 3) break;
      try {
        const { text } = await this.core.agent.compose({
          purpose: followUp ? "follow_up" : "reminder",
          now: this.core.store.now(), timezone: this.core.store.config.timezone,
          candidate, // Machine facts, not a prewritten user-visible response.
          preferences: this.core.assistant.preferences(candidate.text, [], "support").selected,
          constraints: "用户行为未知；未反馈不等于没做；只推动当前一件事，不加承诺、打分或无必要问题。",
        });
        if (!text.trim() || text.length > 1800) throw new Error("INVALID_LANGUAGE");
        this.language.set(key, text);
        this.languageRetryAfter.delete(key);
        while (this.language.size > 64) this.language.delete(this.language.keys().next().value!);
      } catch {
        this.lastError = "MESSAGE_GENERATION_FAILED";
        this.languageRetryAfter.set(key, Date.now() + 30000);
        while (this.languageRetryAfter.size > 64) this.languageRetryAfter.delete(this.languageRetryAfter.keys().next().value!);
      }
    }
  }
  async flushReceipts() {
    for (let i = 0; i < 8 && !this.stopped; i++) {
      if (this.busy) await this.drain();
      if (!(await this.tick(true))) break;
    }
  }
  close() {
    this.stopped = true;
  }
  async tick(receiptsOnly = false) {
    if (this.stopped) return;
    // A tick lease expires on its own: a hung dispatch cannot block the loop.
    if (this.tickLease.expired) this.lastError = "TICK_GUARD_RECOVERED";
    const lease = this.tickLease.tryAcquire();
    if (lease === null) return;
    this.busy = true;
    this.idle = new Promise((resolve) => {
      this.releaseIdle = resolve;
    });
    const { store } = this.core;
    this.lastTick = store.now();
    try {
      if (!receiptsOnly && !this.languageTask) {
        // Dispatch must never wait for a different candidate's model request.
        this.languageTask=this.prepareLanguage().catch(()=>{this.lastError="MESSAGE_GENERATION_FAILED";})
          .finally(()=>{this.languageTask=undefined;});
      }
      const dispatch = await store.exclusive(() => {
        this.core.recoverPending();
        const claim = store.db.transaction(() => {
          store.db
            .prepare(
              "UPDATE outbox SET status='expired',finished_at=?,updated_at=? WHERE status IN ('pending','failed') AND expires_at<=?",
            )
            .run(store.now(), store.now(), store.now());
          const available = receiptsOnly
            ? []
            : this.candidates(store.registry());
          // Refresh unsent material from the approved current version; never reset attempt or per-plan counts.
          for (const candidate of available) {
            const r = store.registry();
            if (!this.permitted(candidate.target.id, candidate)) continue;
            const cap =
              candidate.members ||
              ["planning", "automation", "focus"].includes(
                candidate.target.kind,
              )
                ? 1
                : Math.max(1, store.config.notifications.per_plan_reminder_cap);
            const priorRows = store.db
              .prepare(
                "SELECT o.* FROM outbox o WHERE EXISTS (SELECT 1 FROM json_each(o.source_versions_json) v WHERE v.key=?) AND o.message_kind IN ('initial','follow_up')",
              )
              .all(candidate.id) as any[];
            const occupied = priorRows.filter((row) =>
              ["sent", "unknown", "sending"].includes(row.status),
            );
            if (
              cap === 0 ||
              occupied.length >= cap ||
              occupied.some(
                (row) => row.status === "unknown" || row.status === "sending",
              )
            )
              continue;
            const initialKey = candidate.id + ":initial",
              prior =
                (store.db
                  .prepare("SELECT * FROM outbox WHERE dedupe_key=?")
                  .get(initialKey) as any) ??
                priorRows.find((row) =>
                  ["sent", "sending", "unknown", "abandoned"].includes(
                    row.status,
                  ),
                );
            let kind = "initial",
              key = initialKey;
            if (prior?.status === "sent") {
              const last =
                occupied.sort((a, b) =>
                  (b.sent_at ?? "").localeCompare(a.sent_at ?? ""),
                )[0] ?? prior;
              const sent = last.sent_at ?? last.attempt_started_at;
              if (
                !sent ||
                Date.parse(store.now()) - Date.parse(sent) <
                  store.config.notifications.follow_up_after_minutes * 60000
              )
                continue;
              if (
                candidate.target.kind === "habit" &&
                store.config.notifications
                  .habit_follow_up_requires_recent_engagement
              ) {
                const engaged = store.db
                  .prepare(
                    "SELECT received_at FROM inbox ORDER BY received_at DESC LIMIT 1",
                  )
                  .get() as any;
                if (
                  !engaged ||
                  Date.parse(store.now()) - Date.parse(engaged.received_at) >
                    store.config.notifications.recent_engagement_hours * 3600000
                )
                  continue;
              }
              kind = "follow_up";
              key =
                candidate.id +
                ":follow_up" +
                (occupied.length > 1 ? ":" + occupied.length : "");
            } else if (
              prior &&
              ["unknown", "abandoned", "sending"].includes(prior.status)
            )
              continue;
            const nativeBody = this.core.agent?.executionMode === "tools-v2"
              ? this.literal(candidate) ?? this.language.get(this.languageKey(candidate, kind === "follow_up"))
              : null;
            if (this.core.agent?.executionMode === "tools-v2" && !nativeBody) continue;
            // Fallback wording stays factual: it repeats what the user asked for
            // or the saved next step, never a friendly template that pretends to
            // be the assistant's own voice.
            const body = nativeBody ?? candidate.noticeBody ?? candidate.text,
              versions = JSON.stringify({
                [candidate.id]: candidate.version,
                [candidate.target.id]: candidate.targetVersion,
                ...Object.fromEntries(
                  (candidate.members ?? []).flatMap((c) => [
                    [c.id, c.version],
                    [c.target.id, c.targetVersion],
                  ]),
                ),
                ["contact:" +
                (kind === "follow_up"
                  ? "suggestion"
                  : (candidate.contactClass ?? "suggestion"))]: 1,
                ...Object.fromEntries(
                  (candidate.members ?? [candidate])
                    .filter((c) => c.questionId)
                    .map((c) => ["question:" + c.questionId, 1]),
                ),
              });
            store.db
              .prepare(
                "INSERT OR IGNORE INTO outbox(id,channel,recipient_ref,dedupe_key,target_refs_json,source_versions_json,message_kind,body,content_hash,scheduled_at,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                id("out"),
                "qq",
                this.recipient,
                key,
                JSON.stringify([
                  ...(candidate.members ?? [candidate])
                    .map((c) => c.target)
                    .filter((c) => c.kind !== "planning"),
                  ...r.proposals
                    .filter(
                      (p) =>
                        p.status === "pending" &&
                        p.expires_at > store.now() &&
                        (candidate.members ?? [candidate]).some(
                          (c) =>
                            c.target.kind === "planning" &&
                            (r.followups?.some(
                              (f) =>
                                c.questionId?.startsWith(f.id + "@") &&
                                f.analysis?.proposal_id === p.id,
                            ) ||
                              (c.id.includes("planning:night:") &&
                                p.source.channel === "coordinator" &&
                                p.source.external_id.startsWith(
                                  "planning:" + c.target.business_date + ":",
                                ))),
                        ),
                    )
                    .map((p) => ({ kind: "proposal", id: p.id })),
                ]),
                versions,
                kind,
                body,
                hash(body),
                store.now(),
                candidate.end,
                store.now(),
                store.now(),
              );
            store.db
              .prepare(
                "UPDATE outbox SET body=?,content_hash=?,source_versions_json=?,expires_at=?,updated_at=?,status=CASE WHEN status IN ('cancelled','expired') AND attempts=0 THEN 'pending' ELSE status END WHERE dedupe_key=? AND status IN ('pending','failed','cancelled','expired')",
              )
              .run(body, hash(body), versions, candidate.end, store.now(), key);
          }
          if (!this.channel.health().connected) return null;
          const pending = store.db
            .prepare(
              "SELECT * FROM outbox WHERE status IN ('pending','failed') AND attempts<? AND scheduled_at<=? AND expires_at>? ORDER BY counts_as_proactive,scheduled_at,rowid",
            )
            .all(
              store.config.notifications.delivery_retry_cap + 1,
              store.now(),
              store.now(),
            ) as any[];
          for (const row of pending) {
            if (receiptsOnly && row.counts_as_proactive) continue;
            if (this.core.agent?.executionMode === "tools-v2" && row.message_kind === "receipt" && JSON.parse(row.source_versions_json).language !== "llm") {
              store.db.prepare("UPDATE outbox SET status='cancelled',finished_at=?,updated_at=? WHERE id=?").run(store.now(),store.now(),row.id);
              continue;
            }
            const part =
              row.message_kind === "receipt" &&
              row.dedupe_key.match(/^(.*:reply):(\d+)$/);
            if (part) {
              const n = Number(part[2]);
              const previous = store.db
                .prepare("SELECT status FROM outbox WHERE dedupe_key=?")
                .get(part[1] + (n === 2 ? "" : ":" + (n - 1))) as any;
              if (previous?.status !== "sent") continue;
            }
            if (row.counts_as_proactive) {
              const candidate = available.find(
                (c) =>
                  row.dedupe_key === c.id + ":initial" ||
                  row.dedupe_key.startsWith(c.id + ":follow_up"),
              );
              if (
                !candidate ||
                !this.permitted(candidate.target.id, candidate)
              ) {
                store.db
                  .prepare(
                    "UPDATE outbox SET status='cancelled',finished_at=?,updated_at=? WHERE id=?",
                  )
                  .run(store.now(), store.now(), row.id);
                continue;
              }
              if (this.core.agent?.executionMode === "tools-v2") {
                const currentText = this.literal(candidate) ?? this.language.get(this.languageKey(candidate, row.message_kind === "follow_up"));
                if (!currentText || row.body !== currentText) continue;
              }
              const cap =
                candidate.members ||
                ["planning", "automation", "focus"].includes(
                  candidate.target.kind,
                )
                  ? 1
                  : Math.max(
                      1,
                      store.config.notifications.per_plan_reminder_cap,
                    );
              const already = store.db
                .prepare(
                  "SELECT count(*) n FROM outbox o WHERE status IN ('sent','sending','unknown') AND EXISTS(SELECT 1 FROM json_each(o.source_versions_json) v WHERE v.key=?)",
                )
                .get(candidate.id) as { n: number };
              if (already.n >= cap) {
                store.db
                  .prepare(
                    "UPDATE outbox SET status='cancelled',finished_at=?,updated_at=? WHERE id=?",
                  )
                  .run(store.now(), store.now(), row.id);
                continue;
              }
              if (
                !this.budget(
                  candidate,
                  row.message_kind !== "follow_up" &&
                    candidate.contactClass === "subscription",
                )
              )
                continue;
              // Hard deadlines win even when an earlier disconnected tick enqueued a habit first.
              const first = available.find(
                (c) =>
                  this.permitted(c.target.id, c) &&
                  (this.core.agent?.executionMode!=="tools-v2" || this.literal(c)!==null ||
                    this.language.has(this.languageKey(c,false)) || this.language.has(this.languageKey(c,true))) &&
                  pending.some(
                    (p) =>
                      p.dedupe_key === c.id + ":initial" ||
                      p.dedupe_key.startsWith(c.id + ":follow_up"),
                  ),
              );
              if (first && first.id !== candidate.id) continue;
            }
            const attempts = JSON.parse(row.attempts_json);
            attempts.push({
              at: store.now(),
              business_date: localDate(store.clock(), store.config.timezone),
              result: "sending",
            });
            store.db
              .prepare(
                "UPDATE outbox SET status='sending',attempts=attempts+1,attempts_json=?,business_date=?,attempt_started_at=?,claimed_until=?,updated_at=? WHERE id=? AND status IN ('pending','failed')",
              )
              .run(
                JSON.stringify(attempts),
                localDate(store.clock(), store.config.timezone),
                store.now(),
                DateTime.fromJSDate(store.clock())
                  .plus({
                    seconds: store.config.scheduler.delivery_lease_seconds,
                  })
                  .toUTC()
                  .toISO(),
                store.now(),
                row.id,
              );
            return { row: { ...row, attempts: row.attempts + 1 }, attempts };
          }
          return null;
        })();
        if (!claim) return null;
        this.core.coordinator.contactState(
          claim.row.id,
          claim.row.source_versions_json,
          "sending",
          claim.row.attempts,
        );
        // Commit the durable claim before starting I/O, without yielding the writer turn.
        let delivery: ReturnType<Channel["send"]>;
        try {
          delivery = this.channel.send({
            id: claim.row.id,
            recipient: claim.row.recipient_ref,
            body: claim.row.body,
          });
        } catch {
          delivery = Promise.resolve({
            status: "unknown",
            reason: "CHANNEL_EXCEPTION",
          });
        }
        return { ...claim, delivery };
      });
      if (!dispatch) return;
      let timeout: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        dispatch.delivery.catch(() => ({
          status: "unknown" as const,
          reason: "CHANNEL_EXCEPTION",
        })),
        new Promise<{ status: "unknown"; reason: string }>((resolve) => {
          timeout = setTimeout(
            () => resolve({ status: "unknown", reason: "CHANNEL_TIMEOUT" }),
            store.config.channel.send_timeout_seconds * 1000,
          );
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      await store.exclusive(() => {
        dispatch.attempts.at(-1).result = result.status;
        const row = dispatch.row;
        const delay =
          store.config.notifications.delivery_retry_delays_seconds[
            Math.min(row.attempts - 1, 1)
          ];
        store.db
          .prepare(
            "UPDATE outbox SET status=?,attempts_json=?,external_id=?,sent_at=?,finished_at=?,claimed_until=NULL,scheduled_at=?,updated_at=? WHERE id=?",
          )
          .run(
            result.status,
            JSON.stringify(dispatch.attempts),
            result.status === "sent" ? result.externalId : null,
            result.status === "sent" ? store.now() : null,
            result.status === "sent" ? store.now() : null,
            result.status === "failed"
              ? DateTime.fromJSDate(store.clock())
                  .plus({ seconds: delay })
                  .toUTC()
                  .toISO()
              : row.scheduled_at,
            store.now(),
            row.id,
          );
        this.core.coordinator.contactState(
          row.id,
          row.source_versions_json,
          result.status,
          row.attempts,
        );
      });
      this.lastError = null;
      return result.status === "sent";
    } catch (error) {
      this.lastError = error instanceof Error ? error.name : "SCHEDULER_ERROR";
    } finally {
      this.tickLease.release(lease);
      this.busy = false;
      this.releaseIdle?.();
    }
  }
  async drain(language = false) {
    await this.idle;
    if(language) await this.languageTask;
  }
}
