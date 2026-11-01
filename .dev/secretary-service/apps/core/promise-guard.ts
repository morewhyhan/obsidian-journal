import { DateTime } from "luxon";

/**
 * A reply that promises "九点半我提醒你" must leave a real reminder behind.
 * The model is good at promising and bad at remembering to schedule; this turns
 * the promise into a durable row the scheduler will honour.
 */
export type PromisedTime = { at: string; body: string };

const CN: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function cnToNumber(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === "十") return 10;
  const ten = raw.indexOf("十");
  if (ten >= 0) {
    const left = ten === 0 ? 1 : CN[raw[0]];
    const right = raw.length > ten + 1 ? CN[raw[ten + 1]] : 0;
    return left === undefined || right === undefined ? null : left * 10 + right;
  }
  return CN[raw] ?? null;
}

/** Only phrases that promise a future reminder count; ordinary times do not. */
export function promisedTimes(text: string, now: string, zone: string): PromisedTime[] {
  if (!/(提醒|叫你|喊你|问你|到点|再问)/.test(text)) return [];
  const base = DateTime.fromISO(now, { zone });
  if (!base.isValid) return [];
  const out: PromisedTime[] = [];
  const push = (day: DateTime, hour: number, minute: number) => {
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return;
    if (hour > 23 || minute > 59) return;
    let at = day.set({ hour, minute, second: 0, millisecond: 0 });
    if (at.toMillis() <= base.toMillis() - 60000) at = at.plus({ days: 1 });
    out.push({ at: at.toUTC().toISO()!, body: text });
  };
  for (const m of text.matchAll(/(\d{1,2})[:：](\d{2})/g))
    push(base, Number(m[1]), Number(m[2]));
  for (const m of text.matchAll(/([零一二两三四五六七八九十\d]{1,3})\s*点\s*(半|([零一二两三四五六七八九十\d]{1,3})\s*分?)?/g)) {
    const hour = cnToNumber(m[1]);
    if (hour === null) continue;
    push(base, hour, m[2] === "半" ? 30 : m[3] ? (cnToNumber(m[3]) ?? 0) : 0);
  }
  for (const m of text.matchAll(/(\d{1,2})\s*个?小时(\d{1,2})?\s*分?钟?后/g))
    out.push({
      at: base.plus({ minutes: Number(m[1]) * 60 + Number(m[2] ?? 0) }).toUTC().toISO()!,
      body: text,
    });
  for (const m of text.matchAll(/(\d{1,2})\s*分钟后/g))
    out.push({ at: base.plus({ minutes: Number(m[1]) }).toUTC().toISO()!, body: text });
  const seen = new Set<string>();
  return out.filter((p) => {
    const key = p.at.slice(0, 16);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Turn a promise into one durable reminder unless one already exists that close. */
export function ensurePromisedReminders(
  store: any,
  text: string,
  now: string,
  zone: string,
) {
  const created: PromisedTime[] = [];
  for (const promise of promisedTimes(text, now, zone)) {
    const at = Date.parse(promise.at);
    const nearby = store.db
      .prepare(
        "SELECT id FROM promises WHERE state='pending' AND ABS((julianday(at)-julianday(?))*86400)<600",
      )
      .get(promise.at);
    if (nearby) continue;
    store.db
      .prepare(
        "INSERT INTO promises(id,at,body,state,created_at,updated_at) VALUES(?,?,?,'pending',?,?)",
      )
      .run("promise_" + Date.now().toString(36) + created.length, promise.at, promise.body.slice(0, 200), now, now);
    void at;
    created.push(promise);
  }
  return created;
}

export function duePromises(store: any, now: string) {
  return store.db
    .prepare("SELECT id,at,body FROM promises WHERE state='pending' AND at<=? ORDER BY at")
    .all(now) as { id: string; at: string; body: string }[];
}

export function settlePromise(store: any, id: string, now: string) {
  store.db
    .prepare("UPDATE promises SET state='sent',updated_at=? WHERE id=?")
    .run(now, id);
}
