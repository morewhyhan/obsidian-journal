import { expect, it } from "vitest";
import { explainAutomation, insideQuiet } from "../packages/domain/automation-diagnostics.js";

const quiet = { start: "23:00", end: "08:00" };
const base: any = {
  id: "auto-x",
  title: "早起晨报",
  kind: "recurring",
  status: "active",
  timezone: "Asia/Shanghai",
  due_at: null,
  quiet_exception: false,
  skip_dates: [],
  schedule: {
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    starts_on: "2026-10-24",
    ends_on: null,
    local_start: "05:20",
    local_end: "05:25",
  },
};

it("a quiet-window subscription explains itself instead of looking broken", () => {
  const report = explainAutomation(base, quiet, "2026-10-31T05:20:00+08:00", "Asia/Shanghai");
  // This is exactly the 10-31 morning report: accepted, inside quiet hours, undelivered.
  expect(report.reasons).toContain("quiet_hours=23:00-08:00");
  const allowed = explainAutomation(
    { ...base, quiet_exception: true },
    quiet,
    "2026-10-31T05:20:00+08:00",
    "Asia/Shanghai",
  );
  expect(allowed.reasons).toEqual([]);
});

it("pause, weekday and range gaps are named, and quiet windows wrap midnight", () => {
  expect(insideQuiet("23:30", quiet)).toBe(true);
  expect(insideQuiet("07:59", quiet)).toBe(true);
  expect(insideQuiet("08:00", quiet)).toBe(false);
  expect(insideQuiet("12:00", quiet)).toBe(false);
  const paused = explainAutomation(
    { ...base, status: "paused", quiet_exception: true, paused_until: "2026-11-02T00:00:00Z" },
    quiet,
    "2026-10-31T12:00:00+08:00",
    "Asia/Shanghai",
  );
  expect(paused.reasons.join(" ")).toContain("status=paused");
  expect(paused.reasons.join(" ")).toContain("paused_until=");
  const wrongDay = explainAutomation(
    { ...base, quiet_exception: true, schedule: { ...base.schedule, weekdays: [1] } },
    quiet,
    "2026-10-31T12:00:00+08:00",
    "Asia/Shanghai",
  );
  // 2026-10-31 is a Saturday.
  expect(wrongDay.reasons).toContain("weekday=6");
  const expired = explainAutomation(
    { ...base, quiet_exception: true, schedule: { ...base.schedule, ends_on: "2026-10-30" } },
    quiet,
    "2026-10-31T12:00:00+08:00",
    "Asia/Shanghai",
  );
  expect(expired.reasons).toContain("ends_on=2026-10-30");
});
