import type { Store } from "./store.js";

/**
 * Fact usage is recorded in SQLite at read time because the facts file is a
 * business truth file: touching it while a turn is preparing a commit would
 * invalidate that commit. The visible fields are folded in later, at a safe point.
 */
export function recordFactUsage(store: Store, factIds: string[], eventId: string, now: string) {
  if (!factIds.length || !eventId) return 0;
  let added = 0;
  const insert = store.db.prepare(
    "INSERT OR IGNORE INTO fact_usage(fact_id,event_id,at) VALUES(?,?,?)",
  );
  for (const id of factIds) added += insert.run(id, eventId, now).changes;
  return added;
}

/** Folds pending usage marks into facts.json; safe to call between turns. */
export function applyFactUsage(store: Store, read: () => any, write: (file: any) => void) {
  const rows = store.db
    .prepare(
      "SELECT fact_id,MAX(at) at,COUNT(*) n FROM fact_usage WHERE applied=0 GROUP BY fact_id",
    )
    .all() as { fact_id: string; at: string; n: number }[];
  if (!rows.length) return 0;
  let file: any;
  try {
    file = read();
  } catch {
    return 0;
  }
  const ids = store.db.prepare(
    "SELECT fact_id,event_id,at FROM fact_usage WHERE applied=0 ORDER BY at",
  ).all() as { fact_id: string; event_id: string; at: string }[];
  let touched = 0;
  for (const fact of file.facts ?? []) {
    const mine = ids.filter((x) => x.fact_id === fact.id);
    if (!mine.length) continue;
    const merged = [...new Set([...(fact.used_event_ids ?? []), ...mine.map((x) => x.event_id)])];
    fact.used_event_ids = merged.slice(-50);
    fact.last_used_at = mine[mine.length - 1].at;
    touched++;
  }
  if (touched) {
    file.revision++;
    file.updated_at = store.now();
    write(file);
  }
  store.db.prepare("UPDATE fact_usage SET applied=1 WHERE applied=0").run();
  return touched;
}
