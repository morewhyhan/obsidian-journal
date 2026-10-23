import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import type { Store } from "./store.js";
import { atomicWrite, id } from "./files.js";
export function cleanup(store: Store) {
  const now = store.now(),
    r = store.config.retention,
    ago = (days: number) =>
      DateTime.fromISO(now).minus({ days }).toUTC().toISO();
  let removed = 0;
  store.db.transaction(() => {
    store.db
      .prepare(
        "UPDATE outbox SET status='abandoned',finished_at=?,updated_at=? WHERE status IN ('unknown','failed') AND expires_at<?",
      )
      .run(now, now, ago(r.unknown_abandon_after_window_days));
    store.db
      .prepare(
        "UPDATE outbox SET body=NULL WHERE status IN ('sent','cancelled','expired','abandoned') AND finished_at<?",
      )
      .run(ago(r.outbox_body_days));
    removed += store.db
      .prepare(
        "DELETE FROM outbox WHERE status IN ('sent','cancelled','expired','abandoned') AND finished_at<?",
      )
      .run(ago(r.outbox_receipt_days)).changes;
    removed += store.db
      .prepare(
        "DELETE FROM inbox WHERE status IN ('processed','failed','ignored') AND processed_at<?",
      )
      .run(ago(r.inbox_terminal_days)).changes;
    for (;;) {
      const result = store.db
        .prepare(
          "DELETE FROM events WHERE status IN ('applied','cancelled') AND completed_at<? AND NOT EXISTS(SELECT 1 FROM events child WHERE child.parent_id=events.id)",
        )
        .run(ago(r.events_completed_days));
      removed += result.changes;
      if (!result.changes) break;
    }
    for (const row of store.db.prepare("SELECT path FROM documents").all() as {
      path: string;
    }[])
      if (!fs.existsSync(store.files.resolve(row.path)))
        store.db.prepare("DELETE FROM documents WHERE path=?").run(row.path);
  })();
  const trash = store.files.resolve(".agent/data/trash", "internal");
  if (fs.existsSync(trash))
    for (const entry of fs.readdirSync(trash)) {
      if (!/^trash_[a-f0-9-]+\.md\.json$/.test(entry)) continue;
      const metaPath = store.files.resolve(
        ".agent/data/trash/" + entry,
        "internal",
      );
      try {
        const metadata = JSON.parse(fs.readFileSync(metaPath, "utf8")),
          recoveryId = entry.replace(/\.md\.json$/, "");
        if (
          !Number.isFinite(Date.parse(metadata.deleted_at)) ||
          Date.parse(metadata.deleted_at) >= Date.parse(ago(r.trash_days)!)
        )
          continue;
        const pending = store.db
          .prepare(
            "SELECT 1 FROM events WHERE kind IN ('document_delete','document_recover') AND status IN ('prepared','conflict') AND json_extract(payload_json,'$.recovery_id')=?",
          )
          .get(recoveryId);
        if (pending) continue;
        const content = store.files.resolve(
          ".agent/data/trash/" + entry.replace(/\.json$/, ""),
          "internal",
        );
        if (fs.existsSync(content)) fs.unlinkSync(content);
        fs.unlinkSync(metaPath);
      } catch {
        /* An invalid recovery entry remains visible to maintenance diagnostics, never guessed away. */
      }
    }
  const pages = Number(store.db.pragma("page_count", { simple: true })),
    free = Number(store.db.pragma("freelist_count", { simple: true })),
    size = Number(store.db.pragma("page_size", { simple: true })) * pages;
  const cutoff = ago(r.registry_ended_plan_days)!;
  store.commit(
    "maintenance-registry:" + localDateFor(store),
    "maintenance",
    id("maintenance"),
    (registry) => {
      registry.plans = registry.plans.filter(
        (plan) =>
          !(
            ["finished", "cancelled", "expired"].includes(plan.status) &&
            plan.window_end < cutoff
          ),
      );
      registry.controls = registry.controls.filter(
        (control) => control.ends_at >= cutoff,
      );
      registry.proposals = registry.proposals.filter(
        (proposal) => proposal.expires_at >= cutoff,
      );
      for (const proposal of registry.proposals)
        if (proposal.status === "pending" && proposal.expires_at <= now)
          proposal.status = "expired";
      return { ids: [], message: "短期安排已清理" };
    },
  );
  store.db.pragma("wal_checkpoint(PASSIVE)");
  if (
    DateTime.fromISO(now).weekday === 7 &&
    size > r.vacuum_min_database_mib * 1024 * 1024 &&
    free / pages > r.vacuum_min_free_fraction &&
    fs.statfsSync(store.root).bavail * fs.statfsSync(store.root).bsize >
      size * 2 + 1048576
  )
    store.db.exec("VACUUM");
  return { at: now, removed, database_bytes: size };
}
const localDateFor = (store: Store) =>
  DateTime.fromJSDate(store.clock(), {
    zone: store.config.timezone,
  }).toISODate()!;
export class Maintenance {
  last: { at: string; removed: number; database_bytes: number } | null = null;
  error: string | null = null;
  private initial = true;
  private busy = false;
  private marker: string;
  constructor(private store: Store) {
    this.marker = store.files.resolve(
      ".agent/data/maintenance.json",
      "internal",
    );
    if (fs.existsSync(this.marker)) {
      try {
        this.last = JSON.parse(fs.readFileSync(this.marker, "utf8"));
      } catch {
        this.error = "MAINTENANCE_MARKER_INVALID";
      }
    }
  }
  async tick() {
    if (this.busy) return;
    const local = DateTime.fromJSDate(this.store.clock(), {
      zone: this.store.config.timezone,
    });
    const today = local.toISODate(),
      lastDay = this.last
        ? DateTime.fromISO(this.last.at, {
            zone: this.store.config.timezone,
          }).toISODate()
        : null;
    const due =
      today !== lastDay &&
      (this.initial ||
        local.toFormat("HH:mm") >=
          this.store.config.retention.cleanup_local_time);
    this.initial = false;
    if (!due) return;
    this.busy = true;
    try {
      this.last = await this.store.exclusive(() => cleanup(this.store));
      atomicWrite(this.marker, JSON.stringify(this.last));
      this.error = null;
    } catch {
      this.error = "MAINTENANCE_FAILED";
    } finally {
      this.busy = false;
    }
  }
}
