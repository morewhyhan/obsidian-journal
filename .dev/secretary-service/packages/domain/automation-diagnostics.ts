import { DateTime } from "luxon";
import type { Automation } from "../contracts/types.js";

export type QuietWindow = { start: string; end: string };

function minutesOf(time: string) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/** True when a local wall-clock minute sits inside the quiet window. */
export function insideQuiet(localTime: string, quiet: QuietWindow) {
  const now = minutesOf(localTime),
    start = minutesOf(quiet.start),
    end = minutesOf(quiet.end);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

/**
 * Why a scheduled automation is not being delivered. This exists because a
 * subscription silently swallowed by quiet hours looked exactly like a broken
 * scheduler; the answer must be readable without a database.
 */
export function explainAutomation(
  automation: Automation,
  quiet: QuietWindow,
  now: string,
  zone: string,
) {
  const reasons: string[] = [];
  if (automation.status !== "active") reasons.push("status=" + automation.status);
  if (automation.paused_until && automation.paused_until > now)
    reasons.push("paused_until=" + automation.paused_until);
  const schedule = automation.schedule;
  if (!schedule) return { delivered_at: automation.due_at, reasons };
  const local = DateTime.fromISO(now, { zone: "utc" }).setZone(zone);
  const time = schedule.local_start;
  if (insideQuiet(time, quiet) && !automation.quiet_exception)
    reasons.push("quiet_hours=" + quiet.start + "-" + quiet.end);
  const weekday = local.weekday;
  if (!schedule.weekdays.includes(weekday)) reasons.push("weekday=" + weekday);
  const date = local.toISODate()!;
  if (schedule.starts_on && date < schedule.starts_on) reasons.push("starts_on=" + schedule.starts_on);
  if (schedule.ends_on && date > schedule.ends_on) reasons.push("ends_on=" + schedule.ends_on);
  if (automation.skip_dates?.includes(date)) reasons.push("skip_dates=" + date);
  return { delivered_at: schedule.local_start, reasons };
}
