import { DateTime } from "luxon";
import { AppError } from "../contracts/types.js";
export type Period = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
export function day(value: string) {
  const d = DateTime.fromISO(value, { zone: "UTC" });
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !d.isValid ||
    d.toISODate() !== value
  )
    throw new AppError("INVALID_DATE", "日期应为 YYYY-MM-DD", 400);
  return d;
}
export function localDate(now = new Date(), zone = "Asia/Shanghai") {
  return DateTime.fromJSDate(now, { zone }).toISODate()!;
}
export function weekKey(value: string) {
  const d = day(value);
  return `${d.weekYear}-W${String(d.weekNumber).padStart(2, "0")}`;
}
const folder = (d: DateTime) =>
  `01. Daily/${d.year}年/第${Math.ceil(d.month / 3)}季度/${String(d.month).padStart(2, "0")}月`;
export function route(kind: Period, value: string) {
  const d = day(value),
    key = weekKey(value);
  const anchor = DateTime.max(d.startOf("week"), d.startOf("year"));
  switch (kind) {
    case "daily":
      return `${folder(d)}/${key}/${value}.md`;
    case "weekly":
      return `${folder(anchor)}/${key}/周计划.md`;
    case "monthly":
      return `${folder(d)}/月度计划.md`;
    case "quarterly":
      return `01. Daily/${d.year}年/第${Math.ceil(d.month / 3)}季度/季度计划.md`;
    case "yearly":
      return `01. Daily/${d.year}年/年度计划.md`;
    default:
      throw new AppError("INVALID_PERIOD", "未知周期", 400);
  }
}
export const wiki = (p: string, label: string, heading?: string) =>
  `[[${p.replace(/\.md$/, "")}${heading ? "#" + heading : ""}|${label}]]`;
export function context(kind: Period, value: string) {
  const d = day(value),
    q = Math.ceil(d.month / 3);
  let first = d,
    last = d;
  if (kind === "weekly") {
    first = DateTime.max(d.startOf("week"), d.startOf("year"));
    last = DateTime.min(d.endOf("week"), d.endOf("year"));
  }
  if (kind === "monthly") {
    first = d.startOf("month");
    last = d.endOf("month");
  }
  if (kind === "quarterly") {
    first = d.set({ month: (q - 1) * 3 + 1, day: 1 });
    last = first.plus({ months: 3 }).minus({ days: 1 });
  }
  if (kind === "yearly") {
    first = d.startOf("year");
    last = d.endOf("year");
  }
  const parents: Partial<Record<Period, [Period, string]>> = {
    daily: ["weekly", "本周重点"],
    weekly: ["monthly", "本月重点"],
    monthly: ["quarterly", "本季重点"],
    quarterly: ["yearly", "今年重点"],
  };
  const parent = parents[kind];
  const weeks = new Set<string>();
  for (let cur = first; cur <= last; cur = cur.plus({ days: 1 }))
    weeks.add(route("weekly", cur.toISODate()!));
  const ref = (k: Period, label: string) => wiki(route(k, value), label);
  return {
    kind,
    date: value,
    start: first.toISODate()!,
    end: last.toISODate()!,
    year: d.year,
    quarter: q,
    month: d.month,
    week: weekKey(value),
    parent: parent
      ? "!" + wiki(route(parent[0], value), parent[1], parent[1])
      : wiki("总体目标.md", "总体目标"),
    yearLink: ref("yearly", `${d.year}年`),
    quarterLink: ref("quarterly", `第${q}季度`),
    monthLink: ref("monthly", `${d.month}月`),
    weekLink: ref("weekly", weekKey(value)),
    previousWeekLink: wiki(
      route("weekly", d.minus({ weeks: 1 }).toISODate()!),
      "上一周",
    ),
    nextWeekLink: wiki(
      route("weekly", d.plus({ weeks: 1 }).toISODate()!),
      "下一周",
    ),
    days: Array.from({ length: last.diff(first, "days").days + 1 }, (_, i) => {
      const dt = first.plus({ days: i }).toISODate()!;
      return wiki(route("daily", dt), dt);
    }).join(" · "),
    weeks: [...weeks]
      .map((p) => wiki(p, p.match(/\d{4}-W\d{2}/)![0]))
      .join(" · "),
    months: Array.from({ length: kind === "yearly" ? 12 : 3 }, (_, i) => {
      const dt = d
        .set({ month: kind === "yearly" ? i + 1 : (q - 1) * 3 + i + 1, day: 1 })
        .toISODate()!;
      return wiki(route("monthly", dt), `${day(dt).month}月`);
    }).join(" · "),
    quarters: [1, 2, 3, 4]
      .map((n) =>
        wiki(
          route(
            "quarterly",
            d.set({ month: (n - 1) * 3 + 1, day: 1 }).toISODate()!,
          ),
          `第${n}季度`,
        ),
      )
      .join(" · "),
  };
}
