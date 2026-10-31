import { DateTime } from "luxon";
import { AppError, type Registry } from "../contracts/types.js";
/** The caller supplies confirmed availability; absent data is never treated as free time. */
export function earliestSlot(
  registry: Registry,
  windows: unknown,
  duration: number,
  now: string,
  excludePlan?: string,
  bufferMinutes = 0,
) {
  if (
    !Array.isArray(windows) ||
    !windows.length ||
    windows.length > 24 ||
    !Number.isFinite(duration) ||
    duration <= 0
  )
    throw new AppError("AVAILABILITY_REQUIRED", "需要已确认的空闲窗口和时长");
  const ranges = windows
    .map((w) => {
      if (
        !w ||
        typeof w.start !== "string" ||
        typeof w.end !== "string" ||
        !/(Z|[+-]\d\d:\d\d)$/i.test(w.start) ||
        !/(Z|[+-]\d\d:\d\d)$/i.test(w.end)
      )
        throw new AppError("INVALID_WINDOW", "空闲窗口需要包含时区");
      const start = DateTime.fromISO(w.start),
        end = DateTime.fromISO(w.end);
      if (!start.isValid || !end.isValid || end <= start)
        throw new AppError("INVALID_WINDOW", "空闲窗口无效");
      return { start: start.toMillis(), end: end.toMillis() };
    })
    .sort((a, b) => a.start - b.start);
  const occupied = registry.plans
    .filter(
      (p) => p.id !== excludePlan && ["planned", "active"].includes(p.status),
    )
    .map((p) => ({
      start: Date.parse(p.window_start),
      end: Date.parse(p.window_end),
    }))
    .sort((a, b) => a.start - b.start);
  // The trailing reserve belongs to the confirmed window and is not schedulable.
  const buffer = Math.max(0, bufferMinutes) * 60000;
  for (const range of ranges) {
    const limit = range.end - buffer;
    let cursor = Math.max(range.start, Date.parse(now));
    if (cursor + duration * 60000 > limit) continue;
    for (const block of occupied) {
      if (block.end <= cursor) continue;
      if (block.start >= limit) break;
      if (cursor + duration * 60000 <= Math.min(limit, block.start)) break;
      cursor = Math.max(cursor, block.end);
    }
    if (cursor + duration * 60000 <= limit)
      return {
        start: DateTime.fromMillis(cursor).toUTC().toISO()!,
        end: DateTime.fromMillis(cursor + duration * 60000)
          .toUTC()
          .toISO()!,
      };
  }
  throw new AppError(
    "NO_CAPACITY",
    "已知空闲时间放不下，保持未安排，不改变期限",
    409,
  );
}
