import { DateTime } from "luxon";
import type { Registry } from "../../packages/contracts/types.js";
import { localDate } from "../../packages/calendar/index.js";
import { hash, id } from "./files.js";
import type { Core } from "./core.js";
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
  target: { kind: "habit" | "task"; id: string; business_date?: string };
  version: number;
  targetVersion: number;
  start: string;
  end: string;
  text: string;
  due: string | null;
};
export class Scheduler {
  busy = false;
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
    const { config, clock } = this.core.store,
      time = DateTime.fromJSDate(clock(), { zone: config.timezone }).toFormat(
        "HH:mm",
      ),
      q = config.notifications.quiet_hours;
    return q.start > q.end
      ? time >= q.start || time < q.end
      : time >= q.start && time < q.end;
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
    for (const p of r.plans.filter((x) =>
      ["planned", "active"].includes(x.status),
    )) {
      const target =
        p.target_ref.kind === "habit"
          ? r.habits.find((x) => x.id === p.target_ref.id)
          : r.tasks.find((x) => x.id === p.target_ref.id);
      if (
        !target?.approval ||
        !["active", "ready", "in_progress", "blocked"].includes(target.status)
      )
        continue;
      items.push({
        id: p.id,
        target: p.target_ref,
        version: p.version,
        targetVersion: target.version,
        start: p.window_start,
        end: p.window_end,
        text: p.next_action,
        due: "due_at" in target ? target.due_at : null,
      });
    }
    // A window can cross midnight; the opportunity still belongs to its start date.
    for (const h of r.habits.filter(
      (x) =>
        x.status === "active" && x.approval && x.anchor.kind === "time_window",
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
        });
      }
    }
    for (const h of r.habits.filter(
      (x) => x.status === "active" && x.approval && x.anchor.kind === "event",
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
      });
    }
    return items
      .filter(
        (x) =>
          x.start <= now &&
          x.end > now &&
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
  }
  private permitted(targetId: string) {
    const store = this.core.store;
    return (
      !this.paused(store.registry(), targetId) &&
      !this.quiet() &&
      (!store.recoveryUntil || store.recoveryUntil <= store.now())
    );
  }
  private budget() {
    const { store } = this.core,
      now = store.clock(),
      date = localDate(now, store.config.timezone);
    let count = 0,
      last = "";
    for (const row of store.db
      .prepare("SELECT attempts_json FROM outbox WHERE counts_as_proactive=1")
      .all() as any[]) {
      const occupied = (JSON.parse(row.attempts_json) as any[]).filter((x) =>
        ["sending", "sent", "unknown"].includes(x.result),
      );
      if (occupied.some((x) => x.business_date === date)) count++;
      for (const a of occupied) if (a.at > last) last = a.at;
    }
    return (
      count < store.config.notifications.daily_proactive_message_cap &&
      (!last ||
        now.getTime() - Date.parse(last) >=
          store.config.notifications.minimum_gap_minutes * 60000)
    );
  }
  private body(candidate: Candidate) {
    return candidate.target.kind === "habit"
      ? "现在做这一小步就好：" + candidate.text + "。"
      : candidate.text +
          (candidate.due
            ? "；截止 " +
              DateTime.fromISO(candidate.due, {
                zone: this.core.store.config.timezone,
              }).toFormat("MM-dd HH:mm")
            : "") +
          "。";
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
    if (this.busy || this.stopped) return;
    this.busy = true;
    this.idle = new Promise((resolve) => {
      this.releaseIdle = resolve;
    });
    const { store } = this.core;
    this.lastTick = store.now();
    try {
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
            if (!this.permitted(candidate.target.id)) continue;
            const initialKey = candidate.id + ":initial",
              prior = store.db
                .prepare("SELECT * FROM outbox WHERE dedupe_key=?")
                .get(initialKey) as any;
            let kind = "initial",
              key = initialKey;
            if (prior?.status === "sent") {
              const sent = prior.sent_at ?? prior.attempt_started_at;
              if (
                !sent ||
                Date.parse(store.now()) - Date.parse(sent) <
                  store.config.notifications.follow_up_after_minutes * 60000
              )
                continue;
              if (candidate.target.kind === "habit") {
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
              key = candidate.id + ":follow_up";
            } else if (
              prior &&
              ["unknown", "abandoned", "sending"].includes(prior.status)
            )
              continue;
            const body = this.body(candidate),
              versions = JSON.stringify({
                [candidate.id]: candidate.version,
                [candidate.target.id]: candidate.targetVersion,
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
                JSON.stringify([candidate.target]),
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
                  row.dedupe_key === c.id + ":follow_up",
              );
              if (!candidate || !this.permitted(candidate.target.id)) {
                store.db
                  .prepare(
                    "UPDATE outbox SET status='cancelled',finished_at=?,updated_at=? WHERE id=?",
                  )
                  .run(store.now(), store.now(), row.id);
                continue;
              }
              if (!this.budget()) continue;
              // Hard deadlines win even when an earlier disconnected tick enqueued a habit first.
              const first = available.find(
                (c) =>
                  this.permitted(c.target.id) &&
                  pending.some(
                    (p) =>
                      p.dedupe_key === c.id + ":initial" ||
                      p.dedupe_key === c.id + ":follow_up",
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
      });
      this.lastError = null;
      return result.status === "sent";
    } catch (error) {
      this.lastError = error instanceof Error ? error.name : "SCHEDULER_ERROR";
    } finally {
      this.busy = false;
      this.releaseIdle?.();
    }
  }
  async drain() {
    await this.idle;
  }
}
