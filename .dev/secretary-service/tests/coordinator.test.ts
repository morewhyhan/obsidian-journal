import { afterEach, expect, it } from "vitest";
import { harness, habitAction } from "./helpers.js";
import { Scheduler, type Channel } from "../apps/core/scheduler.js";
import { route } from "../packages/calendar/index.js";
import { atomicWrite } from "../apps/core/files.js";
import { applicationCall } from "../apps/core/application.js";
const cleanups: (() => Promise<void>)[] = [];
it.each(["update_task", "configure_task"])("%s applies an explicit blocker removal instead of silently keeping the old wait", async (type) => {
  const h = harness("2026-10-26T01:50:00Z"); cleanups.push(() => h.close());
  const created = await h.run({type:"create_task",title:"报告",outcome:"提交报告",acceptance:[{kind:"check",description:"提交报告"}],planning:{next_action:"写提纲",remaining_minutes:30}});
  const target_id=created.updated_ids[0];
  await h.run({type:"report_execution",target_id,execution:"blocked",blocker:{kind:"waiting",detail:"等待数据",review_at:"2026-10-26T03:30:00Z"}});
  await h.run({type,target_id,expected_version:h.store.registry().tasks[0].version,planning:{blocker:null}});
  expect(h.store.registry().tasks[0].planning?.blocker).toBeNull();
  expect(h.store.registry().tasks[0].status).toBe("ready");
  await h.restart();
  expect(h.store.registry().tasks[0].planning?.blocker).toBeNull();
  expect(h.store.registry().tasks[0].status).toBe("ready");
});
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
function setup(time = "2026-10-23T13:00:00Z") {
  const h = harness(time);
  cleanups.push(() => h.close());
  const sent: string[] = [];
  const channel: Channel = {
    health: () => ({ connected: true, lastEventAt: null }),
    send: async (m) => {
      sent.push(m.body);
      return { status: "sent", externalId: "test-" + sent.length };
    },
  };
  const scheduler = () => new Scheduler(h.core, channel, "user");
  return { h, sent, scheduler };
}
async function availability(
  h: ReturnType<typeof harness>,
  overrides: object = {},
) {
  await h.run({
    type: "set_planning",
    preferences: {
      availability: [
        { weekdays: [1, 2, 3, 4, 5, 6, 7], start: "10:00", end: "12:00" },
        { weekdays: [1, 2, 3, 4, 5, 6, 7], start: "14:00", end: "17:00" },
      ],
      buffer_minutes: 15,
      ...overrides,
    },
  });
}
async function task(
  h: ReturnType<typeof harness>,
  title = "报告",
  minutes = 60,
  extra: object = {},
) {
  const result = await h.run({
    type: "create_task",
    title,
    outcome: "交付" + title,
    acceptance: [{ kind: "check", description: "交付" + title }],
    due_at: "2026-10-26T10:00:00Z",
    planning: { next_action: "写" + title, remaining_minutes: minutes },
    ...extra,
  });
  return result.updated_ids[0];
}
async function schedule(
  h: ReturnType<typeof harness>,
  target: string,
  start: string,
  end: string,
  kind = "window",
  extra: object = {},
) {
  await h.run({
    type: "schedule",
    target_id: target,
    window_start: start,
    window_end: end,
    duration_minutes: (Date.parse(end) - Date.parse(start)) / 60000,
    next_action: "继续" + target,
    kind,
    ...extra,
  });
}
it("night planning uses confirmed windows, leaves buffer, renders real templates and remains idempotent after restart", async () => {
  const { h, sent, scheduler } = setup();
  await availability(h);
  await task(h);
  await h.core.coordinator.tick();
  const r = h.store.registry(),
    next = h.store.day("2026-10-24").planning!;
  expect(next.status).toBe("ready");
  expect(r.plans).toHaveLength(1);
  expect(r.plans[0].window_start).toBe("2026-10-24T02:00:00.000Z");
  const path = route("daily", "2026-10-24"),
    content = h.store.files.read(path);
  expect(content).toContain("# 禅");
  expect(content).toContain("- [ ] 10:00—11:00 写报告");
  expect(content).not.toContain("<%");
  expect(h.store.registry().habits).toHaveLength(0);
  await scheduler().tick();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("10:00 写报告");
  atomicWrite(h.store.files.resolve(path), content + "\n私人随笔不改写\n");
  await h.restart();
  await h.core.coordinator.tick();
  await scheduler().tick();
  expect(h.store.registry().plans).toHaveLength(1);
  expect(sent).toHaveLength(1);
  expect(h.store.files.read(path)).toContain("私人随笔不改写");
});
it("unknown availability produces one concrete question and never assumes the whole day is free", async () => {
  const { h, sent, scheduler } = setup();
  await task(h);
  await h.core.coordinator.tick();
  await scheduler().tick();
  expect(h.store.registry().plans).toHaveLength(0);
  expect(
    h.store
      .day("2026-10-24")
      .planning!.issues.some((i) => i.kind === "availability"),
  ).toBe(true);
  expect(sent[0]).toContain("空闲时间");
  h.advance(3600000);
  await h.core.coordinator.tick();
  await scheduler().tick();
  expect(sent).toHaveLength(1);
});
it("a missed window is unknown, and silence neither changes completion nor repeats the same task tomorrow", async () => {
  const { h } = setup("2026-10-23T02:00:00Z");
  await availability(h);
  const id = await task(h);
  await schedule(h, id, "2026-10-23T02:00:00Z", "2026-10-23T03:00:00Z");
  h.setTime("2026-10-23T13:00:00Z");
  await h.core.coordinator.tick();
  expect(h.store.registry().plans).toHaveLength(1);
  expect(h.store.registry().tasks[0].status).toBe("ready");
  expect(
    h.store
      .day("2026-10-24")
      .planning!.issues.some((x) => x.kind === "unconfirmed"),
  ).toBe(true);
});
it("an explicit overrun repairs only the dependent chain and preserves a fixed meeting", async () => {
  const { h } = setup("2026-10-24T01:00:00Z");
  await availability(h);
  const a = await task(h, "报告"),
    b = await task(h, "图表", 30),
    meeting = await task(h, "会议", 60);
  await h.run({
    type: "configure_task",
    target_id: b,
    planning: { depends_on: [a] },
  });
  await schedule(h, a, "2026-10-24T02:00:00Z", "2026-10-24T03:00:00Z");
  await schedule(h, b, "2026-10-24T03:00:00Z", "2026-10-24T03:30:00Z");
  await schedule(
    h,
    meeting,
    "2026-10-24T06:00:00Z",
    "2026-10-24T07:00:00Z",
    "fixed",
  );
  h.setTime("2026-10-24T02:50:00Z");
  const result = await h.run({
    type: "report_execution",
    target_id: a,
    execution: "progress",
    remaining_minutes: 30,
    report: "案例还差一部分",
  });
  const r = h.store.registry();
  expect(r.plans.find((x) => x.target_ref.id === a)!.window_end).toBe(
    "2026-10-24T03:20:00.000Z",
  );
  expect(r.plans.find((x) => x.target_ref.id === b)!.window_start).toBe(
    "2026-10-24T03:20:00.000Z",
  );
  expect(r.plans.find((x) => x.target_ref.id === meeting)!.window_start).toBe(
    "2026-10-24T06:00:00.000Z",
  );
  expect(result.message).toContain("11:20");
  expect(r.tasks.find((x) => x.id === a)!.due_at).toBe(
    "2026-10-26T10:00:00.000Z",
  );
});
it("a fixed conflict asks for a choice, preserves the original promise and suppresses misleading reminders", async () => {
  const { h, sent, scheduler } = setup("2026-10-24T01:00:00Z");
  await availability(h);
  const a = await task(h),
    b = await task(h, "预约", 30);
  await schedule(h, a, "2026-10-24T02:00:00Z", "2026-10-24T03:00:00Z");
  await schedule(h, b, "2026-10-24T03:00:00Z", "2026-10-24T03:30:00Z", "fixed");
  h.setTime("2026-10-24T02:50:00Z");
  const result = await h.run({
    type: "report_execution",
    target_id: a,
    execution: "progress",
    remaining_minutes: 30,
  });
  expect(result.message).toContain("无法直接延长");
  expect(h.store.registry().plans[0].needs_replan).toBe(true);
  expect(h.store.registry().plans[1].window_start).toBe(
    "2026-10-24T03:00:00.000Z",
  );
  await scheduler().tick();
  expect(sent).toHaveLength(0);
});
it("dependency completion gates execution even when both tasks have predicted time slots", async () => {
  const { h, sent, scheduler } = setup("2026-10-23T13:00:00Z");
  await availability(h);
  const a = await task(h),
    b = await task(h, "图表", 30);
  await h.run({
    type: "configure_task",
    target_id: b,
    planning: { depends_on: [a] },
  });
  await h.core.coordinator.tick();
  const second = h.store.registry().plans.find((p) => p.target_ref.id === b)!;
  expect(second).toBeDefined();
  h.setTime(second.window_start);
  await scheduler().tick();
  expect(sent).toHaveLength(0);
  await h.run({ type: "complete_task", target_id: a });
  await scheduler().tick();
  expect(sent).toHaveLength(1);
});
it("waiting is a blocker with one scheduled condition check, not another work reminder", async () => {
  const { h, sent, scheduler } = setup("2026-10-24T02:00:00Z");
  await availability(h);
  const a = await task(h);
  await schedule(h, a, "2026-10-24T02:00:00Z", "2026-10-24T03:00:00Z");
  await h.run({
    type: "report_execution",
    target_id: a,
    execution: "blocked",
    blocker: {
      kind: "waiting",
      detail: "等确认后的数据",
      review_at: "2026-10-24T03:30:00Z",
    },
  });
  await scheduler().tick();
  expect(sent).toHaveLength(0);
  h.setTime("2026-10-24T03:30:00Z");
  await h.core.coordinator.tick();
  expect(h.core.coordinator.lastError).toBeNull();
  expect(h.core.coordinator.notices()).toHaveLength(1);
  await scheduler().tick();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("检查时间");
  h.advance(95 * 60000);
  await h.core.coordinator.tick();
  await scheduler().tick();
  expect(sent).toHaveLength(1);
  expect(h.store.registry().tasks[0].status).toBe("blocked");
});
it("explicit non-completion may rebook in known free time but never increases a habit debt", async () => {
  const { h } = setup("2026-10-24T02:00:00Z");
  await availability(h);
  const a = await task(h, "报告", 30);
  await schedule(h, a, "2026-10-24T02:00:00Z", "2026-10-24T02:30:00Z");
  h.setTime("2026-10-24T02:30:00Z");
  await h.run({
    type: "report_execution",
    target_id: a,
    execution: "not_done",
  });
  expect(
    h.store.registry().plans.filter((p) => p.status === "planned"),
  ).toHaveLength(1);
  expect(
    h.store.registry().plans.find((p) => p.status === "planned")!.window_start,
  ).toBe("2026-10-24T02:30:00.000Z");
  const habit = await h.run(habitAction);
  await h.run({
    type: "report_habit",
    target_id: habit.updated_ids[0],
    business_date: "2026-10-24",
    status: "skipped",
  });
  expect(
    h.store.registry().plans.filter((p) => p.target_ref.kind === "habit"),
  ).toHaveLength(0);
});
it("explicit insertion can use buffer and move a flexible collision without moving unrelated work", async () => {
  const { h } = setup("2026-10-24T01:00:00Z");
  await availability(h);
  const a = await task(h),
    urgent = await task(h, "急事", 30);
  await schedule(h, a, "2026-10-24T02:00:00Z", "2026-10-24T03:00:00Z");
  await schedule(
    h,
    urgent,
    "2026-10-24T02:30:00Z",
    "2026-10-24T03:00:00Z",
    "fixed",
    { allow_reflow: true },
  );
  const r = h.store.registry();
  expect(r.plans.find((p) => p.target_ref.id === urgent)!.window_start).toBe(
    "2026-10-24T02:30:00.000Z",
  );
  expect(r.plans.find((p) => p.target_ref.id === a)!.window_start).toBe(
    "2026-10-24T03:00:00.000Z",
  );
});
it("disabling automatic rescheduling preserves windows and asks instead of extending or rebooking", async () => {
  const { h } = setup("2026-10-24T01:00:00Z");
  h.store.config.tasks.auto_reschedule_flexible_work_blocks = false;
  await availability(h);
  const a = await task(h),
    b = await task(h, "另一个任务", 30);
  await schedule(h, a, "2026-10-24T02:00:00Z", "2026-10-24T03:00:00Z");
  await schedule(h, b, "2026-10-24T03:00:00Z", "2026-10-24T03:30:00Z");
  h.setTime("2026-10-24T02:50:00Z");
  const result = await h.run({
    type: "report_execution",
    target_id: a,
    execution: "progress",
    remaining_minutes: 30,
  });
  expect(result.message).toContain("另定工作窗口");
  expect(h.store.registry().plans[0].window_end).toBe(
    "2026-10-24T03:00:00.000Z",
  );
  expect(h.store.registry().plans[0].needs_replan).toBe(true);
  expect(h.store.registry().plans[1].window_start).toBe(
    "2026-10-24T03:00:00.000Z",
  );
  await h.run({
    type: "report_execution",
    target_id: a,
    execution: "not_done",
  });
  expect(
    h.store
      .registry()
      .plans.filter((p) => p.target_ref.id === a && p.status === "planned"),
  ).toHaveLength(0);
  h.setTime("2026-10-24T13:00:00Z");
  await h.core.coordinator.tick();
  expect(
    h.store.registry().plans.filter((p) => p.target_ref.id === a),
  ).toHaveLength(1);
});
it("turning off proactive planning invalidates drafted notices but keeps explicit plan-day available", async () => {
  const { h, sent, scheduler } = setup();
  await availability(h);
  await task(h);
  await h.core.coordinator.tick();
  expect(h.core.coordinator.notices()).toHaveLength(1);
  await h.run({ type: "set_planning", preferences: { enabled: false } });
  expect(h.core.coordinator.notices()).toHaveLength(0);
  await scheduler().tick();
  expect(sent).toHaveLength(0);
  const result = await h.run({ type: "plan_day", business_date: "2026-10-25" });
  expect(result.message).toContain("安排");
  expect(h.store.day("2026-10-25").planning).toBeDefined();
  expect(h.core.coordinator.notices()).toHaveLength(0);
});
it("local repairs cannot exceed the confirmed daily work capacity", async () => {
  const { h } = setup("2026-10-24T01:00:00Z");
  await availability(h, { max_task_minutes: 60 });
  const a = await task(h);
  await schedule(h, a, "2026-10-24T02:00:00Z", "2026-10-24T03:00:00Z");
  h.setTime("2026-10-24T02:50:00Z");
  await h.run({
    type: "report_execution",
    target_id: a,
    execution: "progress",
    remaining_minutes: 30,
  });
  expect(h.store.registry().plans[0].window_end).toBe(
    "2026-10-24T03:00:00.000Z",
  );
  expect(h.store.registry().plans[0].needs_replan).toBe(true);
});
it("reminders use the user's current deferral threshold instead of the default", async () => {
  const { h, sent, scheduler } = setup("2026-10-24T01:00:00Z");
  await availability(h, { postponement_threshold: 2 });
  const a = await task(h);
  await schedule(h, a, "2026-10-24T02:00:00Z", "2026-10-24T03:00:00Z");
  const p = h.store.registry().plans[0];
  await h.run({
    type: "reschedule",
    target_id: p.id,
    window_start: "2026-10-24T03:00:00Z",
    window_end: "2026-10-24T04:00:00Z",
  });
  await h.run({
    type: "reschedule",
    target_id: p.id,
    window_start: "2026-10-24T06:00:00Z",
    window_end: "2026-10-24T07:00:00Z",
  });
  h.setTime("2026-10-24T06:00:00Z");
  await scheduler().tick();
  expect(sent).toHaveLength(0);
});
it("dependency cycles, invalid limits and made-up times are rejected atomically", async () => {
  const { h } = setup();
  const a = await task(h),
    b = await task(h, "B");
  await h.run({
    type: "configure_task",
    target_id: b,
    planning: { depends_on: [a] },
  });
  await expect(
    h.run({
      type: "configure_task",
      target_id: a,
      planning: { depends_on: [b] },
    }),
  ).rejects.toMatchObject({ code: "PLANNING_INVALID" });
  await expect(
    h.run({ type: "set_planning", preferences: { max_tasks: 0 } }),
  ).rejects.toMatchObject({ code: "PLANNING_INVALID" });
  await expect(
    h.run({
      type: "set_planning",
      preferences: {
        availability: [{ weekdays: [1], start: "25:00", end: "26:00" }],
      },
    }),
  ).rejects.toMatchObject({ code: "PLANNING_INVALID" });
});
it("per-plan limits, quiet time and global pause also apply to planning notices", async () => {
  const { h, sent, scheduler } = setup("2026-10-23T12:00:00Z");
  h.store.config.notifications.per_plan_reminder_cap = 1;
  await h.run(habitAction);
  await scheduler().tick();
  expect(sent).toHaveLength(1);
  h.advance(95 * 60000);
  await scheduler().tick();
  expect(sent).toHaveLength(1);
  await availability(h);
  await task(h);
  await h.run({ type: "pause_contact" });
  await h.core.coordinator.tick();
  await scheduler().tick();
  expect(sent).toHaveLength(1);
  // Contact pause stops outward notices, not authorized preparation of tomorrow.
  expect(h.store.day("2026-10-24").planning).toMatchObject({status:"ready"});
  expect(h.store.day("2026-10-24").planning!.plan_ids).toHaveLength(1);
});
it("zero capacity keeps promises visible instead of squeezing rest or changing acceptance", async () => {
  const { h } = setup();
  await availability(h, {
    protected: [
      { weekdays: [1, 2, 3, 4, 5, 6, 7], start: "10:00", end: "17:00" },
    ],
  });
  await task(h, "大任务", 500, { due_at: "2026-10-24T04:00:00Z" });
  await h.core.coordinator.tick();
  expect(h.store.registry().plans).toHaveLength(0);
  expect(
    h.store
      .day("2026-10-24")
      .planning!.issues.some(
        (x) => x.kind === "capacity" || x.kind === "deadline",
      ),
  ).toBe(true);
  expect(h.store.registry().tasks[0].acceptance[0].description).toBe(
    "交付大任务",
  );
});
it("repeated explicit deferrals stop automatic rebooking and request a different plan", async () => {
  const { h } = setup("2026-10-24T02:00:00Z");
  await availability(h);
  const a = await task(h, "报告", 10);
  await schedule(h, a, "2026-10-24T02:00:00Z", "2026-10-24T02:10:00Z");
  for (let i = 0; i < 3; i++) {
    h.advance(600000);
    await h.run({
      type: "report_execution",
      target_id: a,
      execution: "not_done",
    });
  }
  expect(
    h.store.registry().plans.filter((p) => p.status === "planned"),
  ).toHaveLength(0);
  expect(
    h.store
      .day("2026-10-24")
      .planning!.issues.some((x) => x.kind === "repeated"),
  ).toBe(true);
});
it("natural year and quarter routing are shared with the night planner", async () => {
  const { h } = setup("2026-12-31T13:00:00Z");
  await availability(h);
  await task(h, "新年任务", 30, { due_at: "2027-01-02T04:00:00Z" });
  await h.core.coordinator.tick();
  const path = route("daily", "2027-01-01");
  expect(path).toContain("2027年/第1季度/01月/");
  expect(h.store.files.read(path)).toContain("2027-01-01");
  expect(h.store.files.read(path)).not.toContain("<%");
});
it("material preparation only links existing authorised notes and never reads diary narrative into state", async () => {
  const { h } = setup();
  await availability(h);
  atomicWrite(h.store.files.resolve("03. Manual/报告写法.md"), "可用步骤\n");
  await task(h, "报告", 30, {
    note_refs: [{ path: "03. Manual/报告写法.md", relation: "method" }],
  });
  await h.core.coordinator.tick();
  const view = h.core.coordinator.view("2026-10-24");
  expect(view.plans[0].preparation[0].path).toBe("03. Manual/报告写法.md");
  expect(JSON.stringify(h.store.day("2026-10-24"))).not.toContain("可用步骤");
});
it("a dependent fixed meeting sufficiently far away stays intact during a small overrun", async () => {
  const { h } = setup("2026-10-24T01:00:00Z");
  await availability(h);
  const a = await task(h),
    meeting = await task(h, "讨论报告", 30);
  await h.run({
    type: "configure_task",
    target_id: meeting,
    planning: { depends_on: [a] },
  });
  await schedule(h, a, "2026-10-24T02:00:00Z", "2026-10-24T03:00:00Z");
  await schedule(
    h,
    meeting,
    "2026-10-24T06:00:00Z",
    "2026-10-24T06:30:00Z",
    "fixed",
  );
  const before = structuredClone(h.store.registry().plans[1]);
  h.setTime("2026-10-24T02:50:00Z");
  await h.run({
    type: "report_execution",
    target_id: a,
    execution: "progress",
    remaining_minutes: 30,
  });
  expect(h.store.registry().plans[0].needs_replan).toBe(false);
  expect(h.store.registry().plans[1]).toEqual(before);
});
it("an explicit rest-day override moves authorised work and cancels the old queued reminder", async () => {
  const { h, sent } = setup("2026-10-24T02:00:00Z");
  await availability(h);
  const a = await task(h);
  await schedule(h, a, "2026-10-24T02:00:00Z", "2026-10-24T03:00:00Z");
  const offline = new Scheduler(
    h.core,
    {
      health: () => ({ connected: false, lastEventAt: null }),
      send: async () => {
        throw new Error();
      },
    },
    "user",
  );
  await offline.tick();
  expect(h.store.db.prepare("SELECT status FROM outbox").get()).toMatchObject({
    status: "pending",
  });
  await h.run({
    type: "set_planning",
    preferences: { day_overrides: [{ date: "2026-10-24", windows: [] }] },
  });
  expect(h.store.registry().plans[0].window_start).toBe(
    "2026-10-25T02:00:00.000Z",
  );
  expect(h.store.db.prepare("SELECT status FROM outbox").get()).toMatchObject({
    status: "cancelled",
  });
  expect(sent).toHaveLength(0);
});
it("stale planning edits from Web or QQ fail instead of overwriting new availability", async () => {
  const { h } = setup();
  await availability(h);
  const version = h.core.coordinator.view("2026-10-24").version;
  await h.run({
    type: "set_planning",
    expected_planning_version: version,
    preferences: { max_tasks: 2 },
  });
  await expect(
    h.run({
      type: "set_planning",
      expected_planning_version: version,
      preferences: { max_tasks: 6 },
    }),
  ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(h.store.registry().planning_preferences!.max_tasks).toBe(2);
});
it("an expiring temporary availability repairs the old work window without another user message", async () => {
  const { h, scheduler, sent } = setup("2026-10-24T01:50:00Z");
  await availability(h, {
    availability: [
      { weekdays: [1, 2, 3, 4, 5, 6, 7], start: "14:00", end: "17:00" },
    ],
  });
  await h.run({
    type: "set_personal_rule",
    key: "planning.availability",
    value: [{ weekdays: [1, 2, 3, 4, 5, 6, 7], start: "10:00", end: "12:00" }],
    expected_rules_revision: h.store.registry().rules_revision,
    ends_at: "2026-10-24T02:00:00Z",
  });
  const target = await task(h, "报告", 30);
  await schedule(h, target, "2026-10-24T02:00:00Z", "2026-10-24T02:30:00Z");
  await h.core.coordinator.tick();
  h.setTime("2026-10-24T02:00:00Z");
  await h.core.coordinator.tick();
  expect(
    h.store.registry().plans.find((p) => p.target_ref.id === target)
      ?.window_start,
  ).toBe("2026-10-24T06:00:00.000Z");
  await scheduler().tick();
  expect(sent).toHaveLength(0);
});
it("estimation suggestions use at least three explicitly reported efforts and never infer wall-clock effort", async () => {
  const { h } = setup();
  for (const minutes of [30, 60, 90]) {
    const id = await task(h, "报告" + minutes, 10, {
      planning: {
        category: "报告",
        next_action: "列提纲",
        remaining_minutes: 10,
      },
    });
    await h.run({
      type: "report_execution",
      target_id: id,
      execution: "progress",
      effort_minutes: minutes,
    });
    await h.run({ type: "complete_task", target_id: id });
  }
  await task(h, "下一份报告", 10, {
    planning: {
      category: "报告",
      next_action: "写开头",
      remaining_minutes: null,
    },
  });
  const issues = h.core.coordinator.view("2026-10-23").issues;
  expect(issues.find((x) => x.kind === "estimate")!.message).toContain(
    "60分钟",
  );
  expect(
    h.store.registry().tasks.at(-1)!.planning!.remaining_minutes,
  ).toBeNull();
});
it("a crash after writing planning facts is recovered without duplicating plans or missing the template", async () => {
  const { h } = setup();
  await availability(h);
  await task(h);
  let failed = false;
  h.store.fault = (stage) => {
    if (!failed && stage === "files_applied") {
      failed = true;
      throw new Error("simulated crash");
    }
  };
  await h.core.coordinator.tick();
  expect(h.core.coordinator.lastError).toBe("PLANNING_FAILED");
  h.store.fault = undefined;
  await h.restart();
  await h.core.coordinator.tick();
  expect(h.store.registry().plans).toHaveLength(1);
  expect(h.store.files.read(route("daily", "2026-10-24"))).toContain(
    "- [ ] 10:00—11:00 写报告",
  );
});
it("invalid templates keep a visible failure and recover after correction without rebuilding the task", async () => {
  const { h } = setup();
  await availability(h);
  await task(h);
  atomicWrite(
    h.store.files.resolve("Template/日记模版.md"),
    "<% unsupported() %>",
  );
  await h.core.coordinator.tick();
  expect(h.core.coordinator.lastError).toBe("PLANNING_FAILED");
  atomicWrite(
    h.store.files.resolve("Template/日记模版.md"),
    "# 习惯\n# 任务\n# 随笔\n保留这里\n",
  );
  await h.core.coordinator.tick();
  expect(h.core.coordinator.lastError).toBeNull();
  expect(h.store.registry().plans).toHaveLength(1);
  expect(h.store.files.read(route("daily", "2026-10-24"))).toContain(
    "保留这里",
  );
});
it("a concrete recovery proposal can be declined or accepted without the model, and silence never accepts it", async () => {
  const { h } = setup("2026-10-24T02:00:00Z");
  await availability(h);
  const a = await task(h, "报告", 10);
  await schedule(h, a, "2026-10-24T02:00:00Z", "2026-10-24T02:10:00Z");
  for (let i = 0; i < 3; i++) {
    h.advance(600000);
    await h.run({
      type: "report_execution",
      target_id: a,
      execution: "not_done",
    });
  }
  h.setTime("2026-10-24T13:00:00Z");
  await h.core.coordinator.tick();
  const p = h.store.registry().proposals.find((x) => x.issue_key)!;
  expect(p).toBeDefined();
  expect(h.store.registry().tasks[0].planning!.enabled).toBe(true);
  await h.core.receive(h.input("不了"));
  expect(h.store.registry().proposals.find((x) => x.id === p.id)!.status).toBe(
    "cancelled",
  );
  expect(h.store.registry().tasks[0].planning!.enabled).toBe(true);
  // A new, explicit user request creates a new proposal through the normal model path.
  h.store.commit("test-proposal", "test", "test", (r) => {
    r.proposals.push({
      ...p,
      id: "proposal-new",
      version: 1,
      status: "pending",
    });
    return { ids: [], message: "test" };
  });
  await h.core.receive(h.input("好"));
  expect(h.store.registry().tasks[0].planning!.enabled).toBe(true);
  // This fixture was never displayed in the current conversation. A generic
  // acknowledgement must not accept it; explicit batch acceptance may.
  await h.core.receive(h.input("全部提交"));
  expect(h.store.registry().tasks[0].planning!.enabled).toBe(false);
  expect(h.store.registry().tasks[0].status).not.toBe("cancelled");
});
it("K02 a disrupted day preserves promises through late start, urgent insertion, overrun, silence, explicit repair and evening continuation", async () => {
  const {h,sent,scheduler}=setup("2026-10-23T13:00:00Z");
  await availability(h);
  const report=await task(h,"报告",60), chart=await task(h,"图表",30,{planning:{next_action:"根据报告做图",remaining_minutes:30,depends_on:[report]}}), meeting=await task(h,"固定会议",30);
  await schedule(h,report,"2026-10-24T02:00:00Z","2026-10-24T03:00:00Z","window",{next_action:"写报告"});
  await schedule(h,chart,"2026-10-24T03:00:00Z","2026-10-24T03:30:00Z");
  await schedule(h,meeting,"2026-10-24T06:00:00Z","2026-10-24T06:30:00Z","fixed");
  await h.core.coordinator.tick();
  const promise=structuredClone(h.store.registry().tasks.find(t=>t.id===report)!);
  h.setTime("2026-10-24T02:30:00Z");
  await h.run({type:"report_execution",target_id:report,execution:"started",remaining_minutes:60});
  const urgent=await task(h,"临时急事",30);
  const oldPlans=structuredClone(h.store.registry().plans);
  await expect(schedule(h,urgent,"2026-10-24T02:45:00Z","2026-10-24T03:15:00Z","fixed",{allow_reflow:true})).rejects.toMatchObject({code:"PLANNING_CONFLICT"});
  expect(h.store.registry().plans).toEqual(oldPlans);
  // The CEO explicitly accepts one extra task today; the assistant cannot silently raise capacity.
  await availability(h,{max_tasks:4,max_task_minutes:240});
  await schedule(h,urgent,"2026-10-24T02:45:00Z","2026-10-24T03:15:00Z","fixed",{allow_reflow:true});
  h.setTime("2026-10-24T03:40:00Z");
  await h.run({type:"report_execution",target_id:report,execution:"progress",remaining_minutes:90,report:"已写提纲，剩余正文"});
  const beforeSilence=structuredClone(h.store.registry().tasks.find(t=>t.id===report)!);
  h.setTime("2026-10-24T05:30:00Z");
  await h.core.coordinator.tick(); await scheduler().tick();
  expect(h.store.registry().tasks.find(t=>t.id===report)!.status).toBe(beforeSilence.status);
  expect(h.store.registry().plans.find(p=>p.target_ref.id===meeting)!.window_start).toBe("2026-10-24T06:00:00.000Z");
  for(const [id,start,end] of [[chart,"08:30","09:00"],[report,"07:00","08:30"]]) {
    const plan=h.store.registry().plans.find(p=>p.target_ref.id===id && ["planned","active"].includes(p.status))!;
    await h.run({type:"reschedule",target_id:plan.id,expected_version:plan.version,window_start:`2026-10-24T${start}:00Z`,window_end:`2026-10-24T${end}:00Z`});
  }
  await h.run({type:"complete_task",target_id:urgent});
  await h.run({type:"complete_task",target_id:meeting});
  await h.restart();
  const beforeCount=sent.length;
  h.setTime("2026-10-24T06:40:00Z"); await scheduler().tick();
  expect(sent).toHaveLength(beforeCount); // No replay of superseded morning windows.
  h.setTime("2026-10-24T07:00:00Z"); await scheduler().tick();
  expect(sent.at(-1)).toContain("写报告");
  await h.run({type:"complete_task",target_id:report});
  h.setTime("2026-10-24T08:30:00Z"); await scheduler().tick();
  await h.run({type:"complete_task",target_id:chart});
  h.setTime("2026-10-24T13:00:00Z"); await h.core.coordinator.tick(); await scheduler().tick();
  const r=h.store.registry(), current=r.tasks.find(t=>t.id===report)!;
  expect(current.outcome).toBe(promise.outcome); expect(current.acceptance).toEqual(promise.acceptance); expect(current.due_at).toBe(promise.due_at);
  expect(r.tasks).toHaveLength(4); expect(r.tasks.every(t=>t.status==="done")).toBe(true);
  expect(r.plans.every(p=>p.status==="finished")).toBe(true);
  expect(h.store.files.read(route("daily","2026-10-24"))).toMatch(/- \[x\].*报告/);
});

it("QQ intake, real planning tool, night scheduling, proactive reminder and quoted completion form one Core loop", async () => {
  const { h, sent, scheduler } = setup();
  h.core.agent = {
    interpret: async (input) => {
      if (input.channel === "coordinator")
        return {
          action_groups: [],
          clarification: null,
          reply_intent: "discussion",
          discussion: "延续已确认的报告安排。",
        };
      const view: any = await applicationCall(
        h.core,
        {
          input_id: input.id,
          call_id: "read-planning",
          operation: "planning",
          date: "2026-10-24",
        },
        { status: () => ({}), backup: {} as any },
      );
      return {
        action_groups: [
          {
            action_identity: "arrange-report",
            actions: [
              {
                type: "set_planning",
                expected_planning_version: view.version,
                preferences: {
                  day_overrides: [
                    {
                      date: "2026-10-24",
                      windows: [{ start: "10:00", end: "12:00" }],
                    },
                  ],
                },
              },
              {
                type: "create_task",
                title: "QQ报告",
                outcome: "交付提纲",
                acceptance: [{ kind: "check", description: "提纲完成" }],
                planning: {
                  next_action: "先列三个小标题",
                  remaining_minutes: 30,
                },
              },
            ],
          },
        ],
        clarification: null,
        reply_intent: "receipt",
        discussion: "",
      };
    },
  };
  const input = {
    ...h.input("帮我安排明天的报告，明天10到12点有空，提纲用半小时"),
    channel: "qq",
    actor_ref: "user",
  };
  await h.core.receive(input);
  await expect.poll(() => h.store.registry().tasks.length).toBe(1);
  await h.core.coordinator.tick();
  h.core.assistant.startPlanning();
  await h.core.assistant.drain();
  const s = scheduler();
  await s.tick(); // passive receipt has priority
  await s.tick();
  expect(sent.some((x) => x.includes("10:00 先列三个小标题"))).toBe(true);
  h.setTime("2026-10-24T02:00:00Z");
  await s.tick();
  const reminder: any = h.store.db
    .prepare(
      "SELECT external_id FROM outbox WHERE counts_as_proactive=1 AND json_array_length(target_refs_json)=1 AND status='sent' ORDER BY rowid DESC LIMIT 1",
    )
    .get();
  expect(reminder?.external_id).toBeTruthy();
  h.core.agent = undefined;
  await h.core.receive({
    ...h.input("完成了"),
    channel: "qq",
    actor_ref: "user",
    reply_to: reminder.external_id,
  });
  expect(h.store.registry().tasks[0].status).toBe("done");
  expect(h.store.registry().plans.every((p) => p.status === "finished")).toBe(
    true,
  );
  expect(h.store.files.read(route("daily", "2026-10-24"))).toContain(
    "- [x] 10:00—10:30 QQ报告 · 先列三个小标题",
  );
});
