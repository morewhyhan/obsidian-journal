import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { harness, habitAction, taskAction } from "./helpers.js";
import { route, context } from "../packages/calendar/index.js";
import { renderTemplate } from "../apps/core/journal.js";
import { cleanup } from "../apps/core/maintenance.js";
import { bufferMinutesFor, reflow } from "../packages/domain/planning.js";
const cleanups: (() => Promise<void>)[] = [];
const setup = () => {
  const h = harness();
  cleanups.push(() => h.close());
  return h;
};
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
describe("S3f one day's reserve can be lowered without restating availability", () => {
  it("S3f a day override with only buffer_minutes is accepted and used", async () => {
    const h = setup();
    await h.run({
      type: "set_planning",
      preferences: {
        availability: [{ weekdays: [1, 2, 3, 4, 5, 6, 7], start: "10:00", end: "12:00" }],
        buffer_minutes: 15,
        day_overrides: [{ date: "2026-10-24", buffer_minutes: 0 }],
      },
    } as any);
    const registry = h.store.registry() as any;
    const stored = registry.planning_preferences.day_overrides[0];
    expect(stored).toMatchObject({ date: "2026-10-24", buffer_minutes: 0 });
    const settings = registry.planning_preferences as any;
    expect(bufferMinutesFor(settings, "2026-10-24")).toBe(0);
    // Other days keep the default reserve.
    expect(bufferMinutesFor(settings, "2026-10-23")).toBe(15);
  });
});

describe("S3b automatic reflow protects the day's reserve", () => {
  it("S3b a background repair refuses a slot inside the reserve while an explicit one may use it", async () => {
    const h = setup();
    await h.run({
      type: "set_planning",
      preferences: {
        availability: [{ weekdays: [1, 2, 3, 4, 5, 6, 7], start: "10:00", end: "12:00" }],
        buffer_minutes: 15,
      },
    } as any);
    const first = await h.run(taskAction);
    const second = await h.run({ ...taskAction, title: "第二件" } as any);
    // 10:00–11:00 and 11:00–11:30 leave only 11:30–11:45 usable before the reserve.
    await h.run({
      type: "schedule", target_id: first.updated_ids[0],
      window_start: "2026-10-23T02:00:00Z", window_end: "2026-10-23T03:00:00Z", duration_minutes: 60, next_action: "先写结论",
    } as any);
    await h.run({
      type: "schedule", target_id: second.updated_ids[0],
      window_start: "2026-10-23T03:00:00Z", window_end: "2026-10-23T03:30:00Z", duration_minutes: 30, next_action: "画图",
    } as any);
    h.setTime("2026-10-23T02:50:00Z");
    const registry = h.store.registry();
    const root = registry.plans.find((p) => p.target_ref.id === first.updated_ids[0])!;
    const settings = (registry as any).planning_preferences ?? h.store.config.planning;
    // The explicit repair may squeeze the 30 minutes into 11:20–11:50.
    const explicit = reflow(registry, root.id, "2026-10-23T02:00:00Z", "2026-10-23T03:20:00Z",
      h.store.now(), settings, h.store.config.timezone, "explicit", false);
    const squeezed = registry.plans.find((p) => p.target_ref.id === second.updated_ids[0])!;
    expect(Date.parse(squeezed.window_start)).toBeLessThan(Date.parse("2026-10-23T03:45:00Z"));
    expect(explicit.length).toBeGreaterThan(0);

    // A background repair moves the work instead of placing it inside the reserve.
    const copy = h.store.registry();
    const root2 = copy.plans.find((p) => p.target_ref.id === first.updated_ids[0])!;
    reflow(copy, root2.id, "2026-10-23T02:00:00Z", "2026-10-23T03:20:00Z",
      h.store.now(), settings, h.store.config.timezone, "background", true);
    const moved = copy.plans.find((p) => p.target_ref.id === second.updated_ids[0])!;
    const insideReserve =
      moved.window_start === "2026-10-23T03:20:00.000Z" ||
      (Date.parse(moved.window_start) < Date.parse("2026-10-23T04:00:00Z") &&
        Date.parse(moved.window_end) > Date.parse("2026-10-23T03:45:00Z"));
    expect(insideReserve).toBe(false);
  });
});
describe("P01–P09 habits and tasks", () => {
  it("P01 starts without subscribed examples or user-management folders", () => {
    const h = setup();
    expect(h.store.registry().habits).toEqual([]);
    expect(h.store.registry().tasks).toEqual([]);
    expect(h.store.files.list()).toEqual([]);
  });
  it("P03 records minimum behavior independently of optional target", async () => {
    const h = setup(),
      r = await h.run(habitAction);
    await h.run({
      type: "report_habit",
      target_id: r.updated_ids[0],
      business_date: "2026-10-23",
      status: "did",
      quantity: { value: 1, unit: "句" },
      optional_target_met: false,
    });
    const o = h.store.day("2026-10-23").occurrences[0];
    expect(o.status).toBe("did");
    expect(o.optional_target_met).toBe(false);
    expect(h.store.registry().tasks).toHaveLength(0);
  });
  it("P04 silence is unreported, explicit skipped and did_not remain distinct", async () => {
    const h = setup(),
      r = await h.run(habitAction);
    expect(h.core.items("2026-10-23").habits[0].occurrence).toBeNull();
    for (const status of ["skipped", "did_not", "unreported"]) {
      await h.run({
        type: "report_habit",
        target_id: r.updated_ids[0],
        business_date: "2026-10-23",
        status,
      });
      expect(h.store.day("2026-10-23").occurrences[0].status).toBe(status);
    }
    expect(h.store.day("2026-10-24").occurrences).toEqual([]);
  });
  it("P05 partial task progress does not complete task", async () => {
    const h = setup(),
      r = await h.run(taskAction);
    await h.run({
      type: "update_task_progress",
      target_id: r.updated_ids[0],
      criterion_id: "count",
      value: 2,
      unit: "题",
      mode: "total",
    });
    expect(h.store.registry().tasks[0].status).toBe("in_progress");
    expect(
      h.store.registry().tasks[0].progress.criteria.count.reported_value,
    ).toBe(2);
  });
  it("P06 accepts self-report but cannot invent tool verification", async () => {
    const h = setup(),
      r = await h.run(taskAction);
    await h.run({ type: "complete_task", target_id: r.updated_ids[0] });
    expect(h.store.registry().tasks[0].status).toBe("done");
    const tool = await h.run({
      ...taskAction,
      title: "工具任务",
      verification: "tool",
    });
    await expect(
      h.run({ type: "complete_task", target_id: tool.updated_ids[0] }),
    ).rejects.toMatchObject({ code: "VERIFICATION_PENDING" });
  });
  it("P07 pause preserves task due date", async () => {
    const h = setup();
    await h.run(taskAction);
    await h.run({ type: "pause_contact" });
    expect(h.store.registry().tasks[0].due_at).toBe(
      new Date(String(taskAction.due_at)).toISOString(),
    );
    expect(h.store.registry().controls[0].ends_at).toBe(
      "2026-10-23T16:00:00.000Z",
    );
  });
  it("P09 preserves old definition snapshot when correcting yesterday", async () => {
    const h = setup(),
      r = await h.run(habitAction),
      target = r.updated_ids[0];
    await h.run({
      type: "report_habit",
      target_id: target,
      business_date: "2026-10-22",
      status: "did",
    });
    await h.run({
      type: "update_habit",
      target_id: target,
      min_behavior: "读两个单词",
    });
    await h.run({
      type: "report_habit",
      target_id: target,
      business_date: "2026-10-22",
      status: "did_not",
    });
    expect(h.store.day("2026-10-22").occurrences[0].min_behavior_snapshot).toBe(
      "读一句英语",
    );
    expect(h.store.day("2026-10-22").corrections).toHaveLength(1);
    expect(h.store.day("2026-10-23").occurrences).toHaveLength(0);
  });
  it("old object version cannot overwrite current state", async () => {
    const h = setup(),
      r = await h.run(taskAction);
    await h.run({
      type: "update_task",
      target_id: r.updated_ids[0],
      expected_version: 1,
      title: "新名称",
    });
    await expect(
      h.run({
        type: "update_task",
        target_id: r.updated_ids[0],
        expected_version: 1,
        title: "旧名称",
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });
  it("moving work leaves hard deadline unchanged and rejects overlap", async () => {
    const h = setup(),
      r = await h.run(taskAction),
      target = r.updated_ids[0];
    const plan = await h.run({
      type: "schedule",
      target_id: target,
      window_start: "2026-10-23T12:00:00Z",
      window_end: "2026-10-23T13:00:00Z",
      duration_minutes: 30,
      next_action: "做两题",
      kind: "window",
    });
    await h.run({
      type: "reschedule",
      target_id: plan.updated_ids[0],
      window_start: "2026-10-23T13:00:00Z",
      window_end: "2026-10-23T14:00:00Z",
    });
    expect(h.store.registry().tasks[0].due_at).toBe(
      new Date(String(taskAction.due_at)).toISOString(),
    );
    await expect(
      h.run({
        type: "schedule",
        target_id: target,
        window_start: "2026-10-23T13:15:00Z",
        window_end: "2026-10-23T13:45:00Z",
        duration_minutes: 15,
        next_action: "重叠动作",
      }),
    ).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT" });
  });
});
describe("C01–C04 calendar and safe templates", () => {
  it("C01 splits cross-year week under natural-year directories", () => {
    expect(route("daily", "2027-01-01")).toBe(
      "01. Daily/2027年/第1季度/01月/2026-W53/2027-01-01.md",
    );
    expect(route("weekly", "2027-01-01")).toBe(
      "01. Daily/2027年/第1季度/01月/2026-W53/周计划.md",
    );
    expect(context("weekly", "2027-01-01").start).toBe("2027-01-01");
    expect(context("weekly", "2026-12-31").end).toBe("2026-12-31");
  });
  it("C02 shares cross-month week while daily stays in current month", () => {
    expect(route("weekly", "2026-10-01")).toBe(route("weekly", "2026-09-30"));
    expect(route("daily", "2026-10-01")).toContain("第4季度/10月");
    expect(context("daily", "2026-10-23").parent).toContain("#本周重点");
    expect(context("monthly", "2026-10-23").parent).toContain("#本季重点");
  });
  it("C04 refuses unknown executable template instructions", () => {
    expect(() =>
      renderTemplate("<% process.exit() %>", "daily", "2026-10-23"),
    ).toThrow("模板含不支持");
  });
  it("creates only on explicit user action and preserves existing notes", async () => {
    const h = setup(),
      r = await h.core.newPeriod("daily", "2026-10-23");
    const original = h.store.files.read(r.path);
    expect(original).not.toContain("<%");
    expect(original).toContain("# 善意与美好");
    expect(original).not.toContain("每天需要");
    fs.writeFileSync(h.store.files.resolve(r.path), "用户原始日记");
    await h.core.newPeriod("daily", "2026-10-23");
    expect(h.store.files.read(r.path)).toBe("用户原始日记");
  });
});
describe("S01/D04/D05/D06 durability", () => {
  it("D05 creating today later projects an already-recorded habit without losing facts", async () => {
    const h = setup(),
      created = await h.run(habitAction),
      target = created.updated_ids[0];
    await h.run({
      type: "report_habit",
      target_id: target,
      business_date: "2026-10-23",
      status: "did",
    });
    const note = await h.core.newPeriod("daily", "2026-10-23");
    expect(h.store.files.read(note.path)).toContain("- [x] 英语");
    expect(
      h.store
        .registry()
        .diary_links.some((link) => link.target_ref.id === target),
    ).toBe(true);
  });
  it("stable confirmed preferences persist in their own file without copying previous context into SQL", async () => {
    const h = setup();
    await h.run({
      type: "remember_fact",
      fact: "日常提醒保持简短。",
      kind: "user_confirmed",
    });
    const p = path.join(h.root, ".agent/context/facts.json");
    const first = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(first.schema_version).toBe(1);
    expect(first.facts.map((f: any) => f.content)).toContain("日常提醒保持简短。");
    expect(first.facts[0].source.kind).toBe("input");
    expect(first.facts[0].source.id).toBeTruthy();
    expect(first.facts[0].status).toBe("active");
    await h.run({
      type: "remember_fact",
      fact: "我更喜欢晚上学习。",
      kind: "user_confirmed",
    });
    const events = h.store.db
      .prepare(
        "SELECT payload_json FROM events WHERE kind='business' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as any;
    expect(events.payload_json).toContain("晚上学习");
    expect(events.payload_json).not.toContain("日常提醒保持简短。");
    expect(fs.existsSync(path.join(h.root, ".agent/context/user.md"))).toBe(false);
    await expect(
      h.run({ type: "remember_fact", fact: "用户在逃避", kind: "hypothesis" }),
    ).rejects.toMatchObject({ code: "FACT_NOT_CONFIRMED" });
  });
  it("two Core processes cannot own the same vault", async () => {
    const h = setup();
    const { Store } = await import("../apps/core/store.js");
    const { loadConfig } = await import("../apps/core/config.js");
    expect(() => new Store(h.root, loadConfig(h.root))).toThrow("已有 Core");
  });
  it("corruption quarantines SQLite and starts the same conservative suppression as missing DB", async () => {
    const h = setup();
    await h.run(habitAction);
    await h.store.close();
    fs.writeFileSync(
      path.join(h.root, ".agent/data/state.sqlite"),
      "deliberately corrupt fixture",
    );
    await h.restart();
    expect(h.store.recoveryUntil).toBe("2026-10-23T16:00:00.000Z");
    expect(h.store.registry().habits).toHaveLength(1);
    expect(
      fs
        .readdirSync(path.join(h.root, ".agent/data"))
        .some((p) => p.startsWith("state.sqlite.quarantine-")),
    ).toBe(true);
  });
  it("C03 prefers the explicit legacy file without rewriting or duplicating it", async () => {
    const h = setup(),
      canonical = route("daily", "2025-01-05"),
      legacy = "2025年/旧日记.md";
    await h.store.close();
    fs.mkdirSync(path.join(h.root, "2025年"), { recursive: true });
    fs.writeFileSync(path.join(h.root, legacy), "原文完全保留");
    fs.mkdirSync(path.join(h.root, ".obsidian/plugins/light-okr"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(h.root, ".obsidian/plugins/light-okr/legacy-notes.json"),
      JSON.stringify({
        routes: { [canonical]: legacy },
        files: [{ path: legacy }],
      }),
    );
    await h.restart();
    const result = await h.core.newPeriod("daily", "2025-01-05");
    expect(result.path).toBe(legacy);
    expect(h.store.files.read(legacy)).toBe("原文完全保留");
    expect(fs.existsSync(path.join(h.root, canonical))).toBe(false);
  });
  it("S01 deduplicates the same input even when the Agent changes random identity", async () => {
    const h = setup(),
      r = await h.run(taskAction),
      input = h.input("又做了一题"),
      action = {
        type: "update_task_progress",
        target_id: r.updated_ids[0],
        criterion_id: "count",
        value: 1,
        unit: "题",
        mode: "increment",
      };
    await h.core.execute(input, [action], "random-a");
    await h.core.execute(input, [action], "random-b");
    expect(
      h.store.registry().tasks[0].progress.criteria.count.reported_value,
    ).toBe(1);
  });
  it("D05 persists QQ-like feedback without creating a diary", async () => {
    const h = setup(),
      r = await h.run(habitAction);
    await h.run({
      type: "report_habit",
      target_id: r.updated_ids[0],
      business_date: "2026-10-23",
      status: "did",
    });
    expect(h.store.files.list()).toHaveLength(0);
    await h.restart();
    expect(h.store.day("2026-10-23").occurrences[0].status).toBe("did");
  });
  it.each(["prepared", "file:.agent/state/registry.json", "files_applied"])(
    "D04 recovers once after crash at %s",
    async (stage) => {
      const h = setup();
      h.store.fault = (point) => {
        if (point === stage) throw new Error("simulated crash");
      };
      const input = h.input();
      await expect(h.run(taskAction, input)).rejects.toThrow("simulated crash");
      h.store.fault = undefined;
      await h.restart();
      await h.run(taskAction, input);
      expect(h.store.registry().tasks).toHaveLength(1);
      expect(
        h.store.db
          .prepare(
            "SELECT count(*) AS n FROM events WHERE kind='business' AND status='prepared'",
          )
          .get(),
      ).toMatchObject({ n: 0 });
    },
  );
  it("D06/B03 cleanup preserves long-lived facts and pending operations", async () => {
    const h = setup(),
      r = await h.run(habitAction);
    await h.run({
      type: "report_habit",
      target_id: r.updated_ids[0],
      business_date: "2026-10-23",
      status: "did",
    });
    h.advance(100 * 86400000);
    cleanup(h.store);
    expect(h.store.day("2026-10-23").occurrences[0].status).toBe("did");
    expect(h.store.registry().habits).toHaveLength(1);
    expect(
      h.store.db
        .prepare(
          "SELECT count(*) AS n FROM events WHERE status='applied' AND created_at<'2026-10-24'",
        )
        .get(),
    ).toMatchObject({ n: 0 });
  });
  it("B04 suppresses proactive sending after loss of runtime database", async () => {
    const h = setup();
    await h.run(habitAction);
    await h.store.close();
    fs.unlinkSync(path.join(h.root, ".agent/data/state.sqlite"));
    await h.restart();
    expect(h.store.recoveryUntil).toBe("2026-10-23T16:00:00.000Z");
    expect(h.store.registry().habits).toHaveLength(1);
  });
});
