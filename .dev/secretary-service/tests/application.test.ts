import fs from "node:fs";
import { afterEach, expect, it } from "vitest";
import { harness, habitAction } from "./helpers.js";
import { applicationCall } from "../apps/core/application.js";
import { workspaceCall } from "../apps/core/workspace.js";
import { atomicWrite } from "../apps/core/files.js";
import { context, route } from "../packages/calendar/index.js";
import { resource } from "../apps/core/config.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of closers.splice(0)) await fn();
});
function setup() {
  const h = harness();
  closers.push(() => h.close());
  h.store.db
    .prepare(
      "INSERT INTO inbox(id,channel,actor_ref,external_id,body,metadata_json,received_at,occurred_at,status) VALUES('active','qq','owner','active','创建日记','{}',?,?,'processing')",
    )
    .run(h.store.now(), h.store.now());
  const extra = {
    status: () => ({ backup: { enabled: false } }),
    backup: { options: { enabled: false } } as any,
  };
  const call = (args: any) =>
    applicationCall(
      h.core,
      { input_id: "active", call_id: crypto.randomUUID(), ...args },
      extra,
    );
  return { ...h, call };
}
it("planning is a real application tool and exposes current versions without modifying facts", async () => {
  const h = setup();
  const before = h.store.registry();
  const result: any = await h.call({
    operation: "planning",
    date: "2026-10-24",
  });
  expect(result.version).toBe(0);
  expect(result.date).toBe("2026-10-24");
  expect(result.preferences.availability).toEqual([]);
  expect(h.store.registry()).toEqual(before);
});
it("F14 filtered rule lookup ends at the matching rules rather than inventing empty pages", async () => {
  const h = setup();
  for (let i=0;i<21;i++) await h.run({ type:"set_personal_rule", key:"working.rule_"+i,
    value:{instruction:"合成规则"+i,task_ids:[],categories:[],purpose:"all"}, expected_rules_revision:h.store.registry().rules_revision??0 });
  const found:any=await h.call({operation:"rules",query:"working.rule_20"});
  expect(found.items).toHaveLength(1);expect(found.next_offset).toBeNull();
  const absent:any=await h.call({operation:"rules",query:"no-such-rule"});
  expect(absent.items).toEqual([]);expect(absent.next_offset).toBeNull();
});
it("application tools use real templates and ensure both natural-month and week-parent chains", async () => {
  const h = setup();
  const result: any = await h.call({
    operation: "create_period",
    date: "2026-10-01",
  });
  expect(result.template_applied).toBe(true);
  expect(result.path).toBe(route("daily", "2026-10-01"));
  for (const date of ["2026-10-01", "2026-09-28"])
    for (const kind of ["yearly", "quarterly", "monthly", "weekly"] as const)
      expect(fs.existsSync(h.store.files.resolve(route(kind, date)))).toBe(
        true,
      );
  expect(result.created).toHaveLength(7);
  const week = h.store.files.read(route("weekly", "2026-10-01"));
  expect(week).toContain("09月/月度计划#本月重点");
  expect(week).toContain("date: 2026-09-28");
  expect(h.store.files.read(result.path)).not.toContain("<%");
  atomicWrite(h.store.files.resolve(result.path), "用户原文，不覆盖");
  expect(
    ((await h.call({ operation: "create_period", date: "2026-10-01" })) as any)
      .created,
  ).toEqual([]);
  expect(h.store.files.read(result.path)).toBe("用户原文，不覆盖");
  expect(
    await h.call({ operation: "create_period", date: "2026-10-01" }),
  ).toMatchObject({ existing: true, template_applied: false });
});
it("template validation happens before writing parents and custom templates stay authoritative", async () => {
  const h = setup();
  atomicWrite(
    h.store.files.resolve("Template/日记模版.md"),
    "<% unsupported() %>",
  );
  await expect(
    h.call({ operation: "create_period", date: "2026-01-01" }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_TEMPLATE" });
  expect(
    h.store.files.list().filter((p) => p.startsWith("01. Daily/")),
  ).toEqual([]);
  atomicWrite(
    h.store.files.resolve("Template/日记模版.md"),
    fs.readFileSync(resource("templates/日记模版.md"), "utf8") + "\n自定义末尾",
  );
  const result: any = await h.call({
    operation: "create_period",
    date: "2026-01-01",
  });
  expect(h.store.files.read(result.path)).toContain("自定义末尾");
  const w = h.store.files.read(route("weekly", "2026-01-01"));
  expect(w).toContain("start: 2026-01-01");
  expect(w).toContain("end: 2026-01-04");
  expect(w).not.toContain("2025-12-29|周一");
});
it("period context is canonical and navigation includes cross-year split weeks", () => {
  expect(context("weekly", "2026-09-30")).toEqual(
    context("weekly", "2026-10-01"),
  );
  expect(context("monthly", "2026-10-23")).toEqual(
    context("monthly", "2026-10-01"),
  );
  expect(context("quarterly", "2026-12-31")).toEqual(
    context("quarterly", "2026-10-01"),
  );
  expect(context("yearly", "2026-12-31")).toEqual(
    context("yearly", "2026-01-01"),
  );
  expect(context("weekly", "2025-12-31").nextWeekLink).toContain(
    "2026年/第1季度/01月/2026-W01/周计划",
  );
  expect(context("weekly", "2026-01-01").previousWeekLink).toContain(
    "2025年/第4季度/12月/2026-W01/周计划",
  );
});
it("new daily files cannot bypass the template service and application calls require an active request", async () => {
  const h = setup();
  await expect(
    workspaceCall(h.core, {
      operation: "write",
      input_id: "active",
      call_id: "raw",
      path: route("daily", "2026-10-23"),
      content: "手写",
    }),
  ).rejects.toMatchObject({ code: "PERIOD_CREATION_REQUIRED" });
  expect(((await h.call({ operation: "status" })) as any).backup.enabled).toBe(
    false,
  );
  await expect(
    h.call({ operation: "history", path: "MOC.md" }),
  ).rejects.toMatchObject({ code: "BACKUP_DISABLED" });
  h.store.db
    .prepare(
      "UPDATE inbox SET status='processed',processed_at=? WHERE id='active'",
    )
    .run(h.store.now());
  await expect(h.call({ operation: "create_period" })).rejects.toMatchObject({
    code: "APPLICATION_SESSION_EXPIRED",
  });
});
it("complete business query paginates beyond preloaded context and grants exact object versions", async () => {
  const h = setup();
  const base = (await h.core.execute(h.input(), [habitAction], "create", true))
    .updated_ids[0];
  h.store.commit("many", "web", "test", (r) => {
    const original = r.habits.find((x) => x.id === base)!;
    for (let i = 0; i < 45; i++)
      r.habits.push({
        ...original,
        id: "habit-extra-" + i,
        title: "额外习惯" + i,
      });
    return { message: "fixture", ids: [] };
  });
  const ctx = h.core.context(h.input());
  expect(ctx.truncated.items).toBe(true);
  expect(ctx.items.length).toBeLessThan(46);
  expect(JSON.stringify(ctx).length).toBeLessThanOrEqual(12000);
  const page: any = await h.call({
    operation: "state",
    scope: "habits",
    offset: 20,
  });
  expect(page.total).toBe(46);
  expect(page.next_offset).toBeGreaterThan(20);
  const found: any = await h.call({
    operation: "state",
    ids: ["habit-extra-44"],
  });
  expect(found.items[0].version).toBe(1);
  const metadata: any = h.store.db
    .prepare("SELECT metadata_json FROM inbox WHERE id='active'")
    .get();
  expect(JSON.parse(metadata.metadata_json).observed_refs).toContainEqual({
    id: "habit-extra-44",
    version: 1,
  });
  atomicWrite(
    h.store.files.resolve(".agent/context/user.md", "internal"),
    "偏好".repeat(5000),
  );
  expect(h.core.context(h.input()).truncated.preferences).toBe(true);
  expect(
    ((await h.call({ operation: "preferences", offset: 4000 })) as any)
      .next_offset,
  ).toBe(8000);
});
it("an interrupted new-day binding is repaired by idempotent retry without replacing user text", async () => {
  const h = setup();
  await h.core.execute(h.input(), [habitAction], "habit", true);
  // File exists but the creation-to-binding step was interrupted.
  const p = route("daily", "2026-10-23");
  atomicWrite(
    h.store.files.resolve(p),
    "# 习惯\n\n# 任务\n\n# 随笔\n我的原文\n",
  );
  await h.call({ operation: "create_period", date: "2026-10-23" });
  expect(h.store.files.read(p)).toContain("- [ ] 英语");
  expect(h.store.files.read(p)).toContain("我的原文");
  const once = h.store.files.read(p);
  await h.call({ operation: "create_period", date: "2026-10-23" });
  expect(h.store.files.read(p)).toBe(once);
  expect(h.store.registry().diary_links).toHaveLength(1);
});

it("a business object loaded through secretary.state can be updated even outside the preload", async () => {
  const h = setup();
  const first = (await h.core.execute(h.input(), [habitAction], "create", true))
    .updated_ids[0];
  h.store.commit("many-readable", "web", "fixture", (r) => {
    const habit = r.habits.find((x) => x.id === first)!;
    for (let i = 0; i < 35; i++)
      r.habits.push({ ...habit, id: "outside-" + i, title: "后续习惯" + i });
    return { message: "fixture", ids: [] };
  });
  h.core.agent = {
    interpret: async (input, ctx: any) => {
      expect(ctx.items.some((x: any) => x.id === "outside-34")).toBe(false);
      const page: any = await applicationCall(
        h.core,
        {
          input_id: input.id,
          call_id: "lookup",
          operation: "state",
          ids: ["outside-34"],
        },
        { status: () => ({}), backup: { options: { enabled: false } } as any },
      );
      return {
        action_groups: [
          {
            action_identity: "outside-report",
            actions: [
              {
                type: "report_habit",
                target_id: page.items[0].id,
                expected_version: page.items[0].version,
                business_date: "2026-10-23",
                status: "did",
              },
            ],
          },
        ],
        clarification: null,
        reply_intent: "receipt",
      };
    },
  };
  const input = h.input("请从完整记录找到那项习惯，把已读一句记在今天");
  await h.core.receive(input);
  await h.core.processPending();
  await expect.poll(() => h.store.day("2026-10-23").occurrences.length).toBe(1);
  expect(h.store.day("2026-10-23").occurrences[0].habit_id).toBe("outside-34");
});
