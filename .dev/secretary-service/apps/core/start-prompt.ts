import type { Store } from "./store.js";

export type FocusPolicy = {
  enabled: boolean;
  nag_seconds: number;
  work_minutes: number;
  break_minutes: number;
  give_up_minutes: number;
};

const POLICY: FocusPolicy = {
  enabled: true,
  // Two minutes of silence is long enough to notice and short enough to matter.
  nag_seconds: 120,
  // The ordinary Pomodoro default: 25 minutes of work, then 5 minutes of break.
  work_minutes: 25,
  break_minutes: 5,
  give_up_minutes: 120,
};

export function focusPolicy(store: Store): FocusPolicy {
  const raw = (store.config as any)?.focus ?? {};
  return {
    enabled: raw.enabled ?? POLICY.enabled,
    nag_seconds: Math.max(30, Number(raw.nag_seconds ?? POLICY.nag_seconds)),
    work_minutes: Math.max(1, Number(raw.work_minutes ?? POLICY.work_minutes)),
    break_minutes: Math.max(1, Number(raw.break_minutes ?? POLICY.break_minutes)),
    give_up_minutes: Math.max(5, Number(raw.give_up_minutes ?? POLICY.give_up_minutes)),
  };
}

export type FocusRow = {
  id: string;
  target_ref: string;
  label: string;
  state: "asking" | "focused" | "stopped";
  attempts: number;
  next_nag_at: string;
  ends_at: string | null;
  reason: string | null;
};

export function waitingAsks(store: Store): FocusRow[] {
  return store.db
    .prepare("SELECT * FROM start_prompts WHERE state='asking' ORDER BY next_nag_at")
    .all() as FocusRow[];
}

export function dueAsks(store: Store, now: string): FocusRow[] {
  return store.db
    .prepare("SELECT * FROM start_prompts WHERE state='asking' AND next_nag_at<=?")
    .all(now) as FocusRow[];
}

/** A due item starts asking; the scheduler repeats this every nag_seconds. */
export function askStart(
  store: Store,
  targetRef: string,
  label: string,
  now: string,
  actorRef = "",
) {
  const policy = focusPolicy(store);
  const existing = store.db
    .prepare("SELECT * FROM start_prompts WHERE target_ref=? AND state IN ('asking','focused')")
    .get(targetRef) as FocusRow | undefined;
  if (existing) return existing;
  const next = new Date(Date.parse(now) + policy.nag_seconds * 1000).toISOString();
  store.db
    .prepare(
      "INSERT INTO start_prompts(id,target_ref,actor_ref,label,state,attempts,next_nag_at,created_at,updated_at) VALUES(?,?,?,?,'asking',0,?,?,?)",
    )
    .run("focus_" + Date.now().toString(36), targetRef, actorRef, label, next, now, now);
  return store.db
    .prepare("SELECT * FROM start_prompts WHERE target_ref=? AND state='asking'")
    .get(targetRef) as FocusRow;
}

/** One nag: the same question again, never a new topic. */
export function repeatAsk(store: Store, row: FocusRow, now: string) {
  const policy = focusPolicy(store);
  const next = new Date(Date.parse(now) + policy.nag_seconds * 1000).toISOString();
  store.db
    .prepare(
      "UPDATE start_prompts SET attempts=attempts+1,next_nag_at=?,updated_at=? WHERE id=?",
    )
    .run(next, now, row.id);
  return next;
}

export function startFocusSession(store: Store, targetRef: string, now: string) {
  const policy = focusPolicy(store);
  const ends = new Date(Date.parse(now) + policy.work_minutes * 60000).toISOString();
  const row = store.db
    .prepare("SELECT * FROM start_prompts WHERE target_ref=? AND state IN ('asking','focused')")
    .get(targetRef) as FocusRow | undefined;
  store.db
    .prepare(
      "UPDATE start_prompts SET state='stopped',updated_at=?,reason='started' WHERE target_ref=? AND state='asking'",
    )
    .run(now, targetRef);
  store.db
    .prepare(
      "INSERT INTO start_prompts(id,target_ref,label,state,attempts,next_nag_at,ends_at,created_at,updated_at) VALUES(?,?,?,'focused',0,?,?,?,?)",
    )
    .run("focus_" + Date.now().toString(36), targetRef, row?.label ?? targetRef, ends, ends, now, now);
  return { work_minutes: policy.work_minutes, ends_at: ends };
}

/** Only an explicit reason from the person can stop the asking. */
export function deferStart(
  store: Store,
  targetRef: string,
  reason: string,
  now: string,
  minutes = 30,
) {
  const next = new Date(Date.parse(now) + minutes * 60000).toISOString();
  const changed = store.db
    .prepare(
      "UPDATE start_prompts SET state='stopped',reason=?,updated_at=? WHERE target_ref=? AND state IN ('asking','focused')",
    )
    .run(reason.slice(0, 200), now, targetRef).changes;
  if (!changed) return { changed: false };
  store.db
    .prepare(
      "INSERT INTO start_prompts(id,target_ref,label,state,attempts,next_nag_at,reason,created_at,updated_at) VALUES(?,?,?,'asking',0,?,?,?,?)",
    )
    .run("focus_" + Date.now().toString(36) + "d", targetRef, targetRef, next, reason.slice(0, 200), now, now);
  return { changed: true, resume_at: next };
}

export function dueFocusResult(store: Store, now: string) {
  return store.db
    .prepare("SELECT * FROM start_prompts WHERE state='focused' AND ends_at IS NOT NULL AND ends_at<=?")
    .all(now) as FocusRow[];
}

export function finishFocus(store: Store, row: FocusRow, now: string) {
  store.db
    .prepare("UPDATE start_prompts SET state='stopped',ended_at=?,updated_at=?,reason='finished' WHERE id=?")
    .run(now, now, row.id);
}

/** After give_up minutes the asking stops, even without an answer. */
export function expiredAsk(store: Store, row: FocusRow, now: string) {
  const policy = focusPolicy(store);
  return Date.parse(now) - Date.parse((row as any).created_at) > policy.give_up_minutes * 60000;
}

export function giveUpAsk(store: Store, row: FocusRow, now: string) {
  store.db
    .prepare("UPDATE start_prompts SET state='stopped',reason='gave_up',updated_at=? WHERE id=?")
    .run(now, row.id);
}

/** The person answered anything: stop asking. */
export function answerAsk(store: Store, actorRef: string, now: string) {
  store.db
    .prepare("UPDATE start_prompts SET state='answered',updated_at=? WHERE state='asking' AND actor_ref=?")
    .run(now, actorRef);
}
