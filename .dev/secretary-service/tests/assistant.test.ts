import { afterEach, expect, it } from "vitest";
import { harness, habitAction, taskAction } from "./helpers.js";
import { Scheduler, type Channel } from "../apps/core/scheduler.js";
import { ruleValue, localInstant } from "../packages/domain/assistant.js";
import { atomicWrite, hash } from "../apps/core/files.js";
import { createPeriod } from "../apps/core/journal.js";
import { route } from "../packages/calendar/index.js";
import { workspaceCall } from "../apps/core/workspace.js";
import { applicationCall } from "../apps/core/application.js";
import { cleanup } from "../apps/core/maintenance.js";
const cleanupList: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanupList.splice(0)) await fn();
});
function setup(time = "2026-10-26T01:54:50Z") {
  const h = harness(time);
  cleanupList.push(() => h.close());
  const sent: string[] = [];
  let response: "sent" | "unknown" | "failed" = "sent";
  const channel: Channel = {
    health: () => ({ connected: true, lastEventAt: null }),
    send: async (m) => {
      sent.push(m.body);
      return response === "sent"
        ? { status: "sent", externalId: "msg" + sent.length }
        : { status: response, reason: "test" };
    },
  };
  const scheduler = () => new Scheduler(h.core, channel, "owner");
  return {
    h,
    sent,
    scheduler,
    setResponse: (v: typeof response) => (response = v),
  };
}
const hourly = {
  type: "create_automation",
  kind: "hourly_checkin",
  title: "小时回顾",
  schedule: {
    weekdays: [1, 2, 3, 4, 5],
    starts_on: "2026-10-26",
    local_start: "09:00",
    local_end: "18:00",
    minute: 55,
  },
};
const rule = async (
  h: ReturnType<typeof harness>,
  key: string,
  value: unknown,
  extra = {},
) =>
  h.run({
    type: "set_personal_rule",
    key,
    value,
    expected_rules_revision: h.store.registry().rules_revision ?? 0,
    ...extra,
  });

it("T13 temporary settings expire, undo restores the prior value, and independent planning writes share versions", async () => {
  const { h } = setup();
  await rule(h, "planning.evening_time", "20:00");
  const result = await rule(h, "planning.evening_time", "19:00", {
    ends_at: "2026-10-27T00:00:00Z",
  });
  expect(h.core.assistant.view().planning.evening_time).toBe("19:00");
  const r = h.store.registry();
  await expect(
    h.run({
      type: "set_planning",
      preferences: { evening_time: "18:00" },
      expected_planning_version: 0,
    }),
  ).rejects.toMatchObject({ status: 409 });
  h.setTime("2026-10-27T01:00:00Z");
  expect(h.core.assistant.view().planning.evening_time).toBe("20:00");
  const target = r.user_rules!.find((x) => x.id === result.updated_ids[0])!;
  await h.run({
    type: "undo_rule",
    target_id: target.id,
    expected_version: target.version,
    expected_rules_revision: r.rules_revision,
  });
  expect(h.core.assistant.view().planning.evening_time).toBe("20:00");
  await h.restart();
  expect(h.core.assistant.view().planning.evening_time).toBe("20:00");
});
it("two different personal settings in one input do not collide in idempotency", async () => {
  const { h } = setup(),
    input = h.input();
  await h.run(
    {
      type: "set_personal_rule",
      key: "contact.style",
      value: "平静简短",
      expected_rules_revision: 0,
    },
    input,
  );
  await h.run(
    {
      type: "set_personal_rule",
      key: "planning.evening_time",
      value: "20:00",
      expected_rules_revision: 1,
    },
    input,
  );
  expect(h.core.assistant.view().values["contact.style"]).toBe("平静简短");
  expect(h.core.assistant.view().planning.evening_time).toBe("20:00");
});
it("a single accepted atomic command can update two rules against the same base revision", async () => {
  const { h } = setup();
  await h.run([
    {
      type: "set_personal_rule",
      key: "contact.style",
      value: "简短",
      expected_rules_revision: 0,
    },
    {
      type: "set_personal_rule",
      key: "planning.evening_time",
      value: "20:00",
      expected_rules_revision: 0,
    },
  ]);
  expect(h.core.assistant.view().rules_revision).toBe(2);
  expect(h.core.assistant.view().planning.evening_time).toBe("20:00");
  expect(h.core.assistant.view().values["contact.style"]).toBe("简短");
});
it("T15 stale and unsafe rules cannot change the authority or poison recovery", async () => {
  const { h } = setup();
  await rule(h, "contact.style", "简短");
  await expect(
    h.run({
      type: "set_personal_rule",
      key: "contact.style",
      value: "详细",
      expected_rules_revision: 0,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(rule(h, "planning.__proto__", {})).rejects.toMatchObject({
    code: "ASSISTANT_INVALID",
  });
  await expect(
    rule(
      h,
      "planning.availability",
      JSON.parse(
        '[{"__proto__":{},"weekdays":[1],"start":"09:00","end":"10:00"}]',
      ),
    ),
  ).rejects.toMatchObject({ code: "ASSISTANT_INVALID" });
  await rule(h, "contact.style", "友善");
  expect(h.core.assistant.view().values["contact.style"]).toBe("友善");
});
it("legacy planning migrates into rules without losing untouched values or temporary overrides", async () => {
  const { h } = setup();
  h.store.commit("old", "test", "old", (r) => {
    r.planning_preferences = {
      ...h.store.config.planning,
      evening_time: "20:30",
      max_tasks: 3,
    };
    return { ids: [], message: "legacy" };
  });
  await rule(h, "contact.style", "简短");
  await rule(h, "planning.evening_time", "19:00", {
    ends_at: "2026-10-27T00:00:00Z",
  });
  await h.run({
    type: "set_planning",
    preferences: { max_tasks: 4 },
    expected_planning_version: h.store.registry().planning_version,
  });
  h.setTime("2026-10-27T01:00:00Z");
  expect(h.core.assistant.view().planning).toMatchObject({
    evening_time: "20:30",
    max_tasks: 4,
  });
});
it("T16 nine hourly subscriptions survive a zero suggestion budget, restart and duplicate ticks", async () => {
  const t = setup();
  t.h.store.config.notifications.daily_proactive_message_cap = 0;
  await t.h.run(hourly);
  for (let hour = 9; hour < 18; hour++) {
    t.h.setTime("2026-10-26T" + String(hour - 8).padStart(2, "0") + ":55:00Z");
    await t.h.core.assistant.tick();
    await t.scheduler().tick();
    await t.scheduler().tick();
    if (hour === 12) await t.h.restart();
  }
  expect(t.sent).toHaveLength(9);
  expect(
    t.h.store
      .day("2026-10-26")
      .automation_occurrences!.filter(
        (x) =>
          x.due_at.startsWith("2026-10-26") &&
          x.due_at < "2026-10-26T10:00:00Z",
      ),
  ).toHaveLength(9);
});
it("T18 editing a sent hourly slot never resends it, but future slots use the new text", async () => {
  const t = setup();
  await t.h.run(hourly);
  t.h.advance(10000);
  await t.h.core.assistant.tick();
  await t.scheduler().tick();
  const a = t.h.store.registry().automations![0];
  await t.h.run({
    type: "update_automation",
    target_id: a.id,
    expected_version: a.version,
    body: "下一小时的新提示",
  });
  await t.h.core.assistant.tick();
  await t.scheduler().tick();
  expect(t.sent).toHaveLength(1);
  t.h.advance(3600000);
  await t.h.core.assistant.tick();
  await t.scheduler().tick();
  expect(t.sent).toHaveLength(2);
  expect(t.sent[1]).toContain("新提示");
});
it("T17 missing repeat range is rejected, global pause wins, and skip_today does not retire the automation", async () => {
  const t = setup();
  await expect(
    t.h.run({
      type: "create_automation",
      kind: "hourly_checkin",
      title: "模糊范围",
    }),
  ).rejects.toMatchObject({ code: "ASSISTANT_INVALID" });
  await t.h.run(hourly);
  const a = t.h.store.registry().automations![0];
  await t.h.run({
    type: "control_automation",
    target_id: a.id,
    expected_version: a.version,
    control: "skip_today",
  });
  t.h.advance(10000);
  await t.h.core.assistant.tick();
  await t.scheduler().tick();
  expect(t.sent).toHaveLength(0);
  t.h.setTime("2026-10-27T01:55:00Z");
  await t.h.core.assistant.tick();
  await t.h.run({ type: "pause_contact", ends_at: "2026-10-27T02:55:00Z" });
  await t.scheduler().tick();
  expect(t.sent).toHaveLength(0);
  expect(t.h.store.registry().automations![0].status).toBe("active");
});
it("T25 relative reminders use receipt time and reject requests whose instant passed during interpretation", async () => {
  const t = setup(),
    input = t.h.input();
  await t.h.core.receive(input);
  t.h.advance(10000);
  await t.h.run(
    {
      type: "create_automation",
      kind: "one_shot",
      title: "Hello",
      body: "Hello",
      delay_seconds: 30,
    },
    input,
  );
  t.h.advance(19000);
  await t.h.core.assistant.tick();
  await t.scheduler().tick();
  expect(t.sent).toHaveLength(0);
  t.h.advance(1000);
  await t.h.core.assistant.tick();
  await t.scheduler().tick();
  expect(t.sent).toEqual(["Hello"]);
  const late = t.h.input();
  await t.h.core.receive(late);
  t.h.advance(31000);
  await expect(
    t.h.run(
      {
        type: "create_automation",
        kind: "one_shot",
        title: "late",
        delay_seconds: 30,
      },
      late,
    ),
  ).rejects.toMatchObject({ code: "ASSISTANT_INVALID" });
});
it("T23 an explicitly requested near reminder can bypass quiet, never a global pause", async () => {
  const t = setup("2026-10-25T16:00:00Z");
  await t.h.run({
    type: "create_automation",
    kind: "one_shot",
    title: "Hello",
    delay_seconds: 30,
  });
  t.h.advance(30000);
  await t.h.core.assistant.tick();
  await t.scheduler().tick();
  expect(t.sent).toEqual(["Hello"]);
  await t.h.run({
    type: "create_automation",
    kind: "one_shot",
    title: "paused",
    delay_seconds: 30,
  });
  await t.h.run({ type: "pause_contact", ends_at: "2026-10-25T17:00:00Z" });
  t.h.advance(30000);
  await t.h.core.assistant.tick();
  await t.scheduler().tick();
  expect(t.sent).toHaveLength(1);
});
it("T24 excessive recurring rules and out-of-range timer parameters fail before becoming promises", async () => {
  const { h } = setup();
  for (let i = 0; i < 2; i++)
    await h.run({
      ...hourly,
      title: "回顾" + i,
      schedule: {
        ...hourly.schedule,
        local_start: "00:00",
        local_end: "23:59",
      },
    });
  await expect(
    h.run({
      ...hourly,
      title: "第三条",
      schedule: {
        ...hourly.schedule,
        local_start: "00:00",
        local_end: "23:59",
      },
    }),
  ).rejects.toMatchObject({ code: "ASSISTANT_INVALID" });
  await expect(
    h.run({ type: "start_focus", rounds: 13 }),
  ).rejects.toMatchObject({ code: "ASSISTANT_INVALID" });
});
it("T19 25/5/4 ends after 115 minutes, without completing the linked task", async () => {
  const t = setup(),
    created = await t.h.run(taskAction),
    id = created.updated_ids[0];
  await t.h.run({ type: "start_focus", task_ref: id });
  await t.h.core.assistant.tick();
  let elapsed = 0;
  for (let phase = 0; phase < 7; phase++) {
    const duration = phase % 2 === 0 ? 25 : 5;
    elapsed += duration;
    t.h.advance(duration * 60000);
    await t.h.core.assistant.tick();
    await t.scheduler().tick();
  }
  expect(elapsed).toBe(115);
  expect(t.h.core.assistant.view().focus?.status).toBe("finished");
  expect(t.h.store.registry().tasks[0].status).toBe("ready");
  expect(t.sent).toHaveLength(7);
});
it("T20 pause freezes remaining time, restart preserves it, and stop leaves the task alone", async () => {
  const t = setup();
  await t.h.run({ type: "start_focus", work_minutes: 5, rounds: 2 });
  t.h.advance(120000);
  let f = t.h.core.assistant.view().focus!;
  await t.h.run({
    type: "pause_focus",
    target_id: f.id,
    expected_version: f.version,
  });
  t.h.advance(3600000);
  await t.h.restart();
  f = t.h.core.assistant.view().focus!;
  expect(f.remaining_ms).toBe(180000);
  await t.h.run({
    type: "resume_focus",
    target_id: f.id,
    expected_version: f.version,
  });
  await t.h.core.assistant.tick();
  t.h.advance(180000);
  await t.h.core.assistant.tick();
  await t.scheduler().tick();
  expect(t.sent).toHaveLength(1);
  f = t.h.core.assistant.view().focus!;
  await t.h.run({
    type: "stop_focus",
    target_id: f.id,
    expected_version: f.version,
  });
  expect(t.h.core.assistant.view().focus?.status).toBe("cancelled");
});
it("T21 overdue restart asks for resume once instead of fast-forwarding all phases", async () => {
  const t = setup();
  await t.h.run({ type: "start_focus", work_minutes: 1, rounds: 4 });
  t.h.advance(3600000);
  await t.h.restart();
  await t.h.core.assistant.tick();
  await t.scheduler().tick();
  expect(t.h.core.assistant.view().focus?.status).toBe("needs_resume");
  expect(t.h.core.assistant.view().focus?.round_index).toBe(1);
  await t.scheduler().tick();
  expect(t.sent).toHaveLength(1);
});
it("T22 focus protects hourly reports, same-time transitions merge and retain both instance references", async () => {
  const t = setup("2026-10-26T01:54:00Z");
  await t.h.run(hourly);
  await t.h.run({ type: "start_focus", work_minutes: 1, rounds: 2 });
  await t.h.core.assistant.tick();
  t.h.advance(60000);
  await t.h.core.assistant.tick();
  await t.scheduler().tick();
  expect(t.sent).toHaveLength(1);
  expect(t.sent[0]).toContain("休息");
  expect(t.sent[0]).toContain("这一小时");
  const row = t.h.store.db
    .prepare("SELECT target_refs_json FROM outbox WHERE status='sent'")
    .get() as any;
  expect(JSON.parse(row.target_refs_json)).toHaveLength(2);
});
it("hourly reports expire rather than accumulating a catch-up debt behind a long focus block", async () => {
  const t = setup("2026-10-26T01:50:00Z");
  await t.h.run(hourly);
  await t.h.run({ type: "start_focus", work_minutes: 20, rounds: 1 });
  await t.h.core.assistant.tick();
  t.h.advance(5 * 60000);
  await t.h.core.assistant.tick();
  await t.scheduler().tick();
  expect(t.sent).toHaveLength(0);
  t.h.advance(15 * 60000);
  await t.h.core.assistant.tick();
  await t.scheduler().tick();
  expect(t.sent).toHaveLength(1);
  expect(t.sent[0]).not.toContain("这一小时");
});
it("T04 date indexing reads only goal headings, follows bounded plan references and retains source hashes", async () => {
  const { h } = setup();
  createPeriod(h.store, "daily", "2027-01-01");
  const p = h.store.files.actualPath(route("yearly", "2027-01-01"));
  atomicWrite(
    h.store.files.resolve(p),
    h.store.files
      .read(p)
      .replace(
        "# 今年重点",
        "# 今年重点\n英语连续性\n![[" + p.replace(/\.md$/, "") + "#今年重点]]",
      ),
  );
  const daily = h.store.files.actualPath(route("daily", "2027-01-01"));
  atomicWrite(
    h.store.files.resolve(daily),
    h.store.files.read(daily).replace("# 禅", "# 禅\n这段私密内容不能预载"),
  );
  const context = h.core.assistant.context("2027-01-01");
  expect(context.sections.some((x) => x.text.includes("英语连续性"))).toBe(
    true,
  );
  expect(JSON.stringify(context)).not.toContain("这段私密");
  expect(
    context.sections.every((x) => /^sha256:[a-f0-9]{64}$/.test(x.hash)),
  ).toBe(true);
  expect(context.sections.length).toBeLessThan(10);
});
it("T06/T07 one proactive model job merges cycle reviews, writes no unaccepted commitments, and survives restart", async () => {
  const { h } = setup("2026-12-31T13:00:00Z");
  let calls = 0,
    ctx: any;
  h.core.agent = {
    interpret: async (_input, c) => {
      calls++;
      ctx = c;
      return {
        action_groups: [
          {
            action_identity: "new",
            actions: [
              {
                type: "create_task",
                title: "建议",
                outcome: "新成果",
                acceptance: [{ kind: "check", description: "成果" }],
              },
            ],
          },
        ],
        clarification: "明年继续英语吗？",
        reply_intent: "proposal",
        summary: "建议保持英语",
        discussion: "建议保持英语",
      };
    },
  };
  await h.core.coordinator.tick();
  h.core.assistant.startPlanning();
  await h.core.assistant.drain();
  expect(calls).toBe(1);
  expect(ctx.review_periods).toEqual(["yearly", "quarterly", "monthly"]);
  expect(h.store.registry().tasks).toHaveLength(0);
  expect(h.store.registry().proposals).toHaveLength(1);
  expect(h.store.day("2027-01-01").assistance?.status).toBe("done");
  h.core.assistant.startPlanning();
  await h.core.assistant.drain();
  expect(calls).toBe(1);
  await h.restart();
  h.core.agent = {
    interpret: async () => {
      throw new Error("should not run");
    },
  };
  h.core.assistant.startPlanning();
  await h.core.assistant.drain();
  expect(h.store.day("2027-01-01").assistance?.status).toBe("done");
});
it("T13/T14 changing evening time cancels the old daily trigger rather than generating a second planning session", async () => {
  const { h } = setup("2026-10-26T12:00:00Z");
  let calls = 0;
  h.core.agent = {
    interpret: async () => {
      calls++;
      return {
        action_groups: [],
        clarification: null,
        reply_intent: "discussion",
        discussion: "建议延续今天已接受的英语",
      };
    },
  };
  await rule(h, "planning.evening_time", "20:00");
  h.core.assistant.startPlanning();
  await h.core.assistant.drain();
  h.advance(3600000);
  h.core.assistant.startPlanning();
  await h.core.assistant.drain();
  expect(calls).toBe(1);
});
it("T31 proactive sessions cannot write via workspace or invoke privileged application operations", async () => {
  const { h } = setup();
  h.store.db
    .prepare(
      "INSERT INTO inbox(id,channel,actor_ref,external_id,body,metadata_json,status,received_at,occurred_at) VALUES('job','coordinator','core','job','plan','{}','processing',?,?)",
    )
    .run(h.store.now(), h.store.now());
  await expect(
    workspaceCall(h.core, {
      input_id: "job",
      call_id: "1",
      operation: "write",
      path: "03. Manual/no.md",
      content: "no",
    }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    applicationCall(
      h.core,
      { input_id: "job", call_id: "2", operation: "create_period" },
      { status: () => ({}), backup: {} as any },
    ),
  ).rejects.toMatchObject({ status: 403 });
});
it("T32 unknown delivery is not resent even after the body/receipt cleanup and a clock rewind", async () => {
  const t = setup();
  await t.h.run(hourly);
  t.h.advance(10000);
  await t.h.core.assistant.tick();
  t.setResponse("unknown");
  await t.scheduler().tick();
  await t.h.core.assistant.tick();
  t.h.setTime("2027-02-01T01:00:00Z");
  cleanup(t.h.store);
  await t.h.restart();
  t.h.setTime("2026-10-26T01:55:00Z");
  await t.h.core.assistant.tick();
  await t.scheduler().tick();
  expect(t.sent).toHaveLength(1);
});
it("T29 reports stay separate by default; authorized diary projection is idempotent and corrections keep history", async () => {
  const t = setup();
  await t.h.run({ ...hourly, to_diary: true });
  t.h.advance(10000);
  await t.h.core.assistant.tick();
  const a = t.h.store.registry().automations![0],
    o = t.h.core.assistant
      .occurrences()
      .find((x) => x.due_at <= t.h.store.now())!;
  const report = {
    type: "report_automation",
    target_id: a.id,
    expected_version: a.version,
    business_date: o.business_date,
    occurrence_id: o.id,
    report: "写完提纲",
  };
  await t.h.run(report);
  await t.h.core.assistant.tick();
  await t.h.core.assistant.tick();
  const p = hPath(t.h, o.business_date);
  expect(t.h.store.files.read(p).match(/写完提纲/g)).toHaveLength(1);
  await t.h.run({ ...report, report: "提纲只写了一半" });
  await t.h.core.assistant.tick();
  expect(t.h.store.files.read(p)).toContain("更正：提纲只写了一半");
  expect(
    t.h.store
      .day(o.business_date)
      .automation_occurrences!.find((x) => x.id === o.id)!.report_history,
  ).toHaveLength(1);
});
function hPath(h: ReturnType<typeof harness>, date: string) {
  return h.store.files.actualPath(route("daily", date));
}
it("T29 enabling diary recording does not retroactively expose earlier reports", async () => {
  const { h } = setup();
  await h.run(hourly);
  h.advance(10000);
  await h.core.assistant.tick();
  const a = h.store.registry().automations![0],
    o = h.core.assistant.occurrences().find((x) => x.due_at <= h.store.now())!;
  await h.run({
    type: "report_automation",
    target_id: a.id,
    expected_version: a.version,
    business_date: o.business_date,
    occurrence_id: o.id,
    report: "未授权叙述",
  });
  h.advance(1000);
  await rule(h, "recording.to_diary", true);
  await h.core.assistant.tick();
  expect(
    h.store.files.list().some((x) => x === hPath(h, o.business_date)),
  ).toBe(false);
});
it("an explicit do-not-write report overrides an enabled diary subscription and long-term recording rule", async () => {
  const { h } = setup();
  await rule(h, "recording.to_diary", true);
  await h.run({ ...hourly, to_diary: true });
  h.advance(10000);
  await h.core.assistant.tick();
  const a = h.store.registry().automations![0],
    o = h.store.day("2026-10-26").automation_occurrences![0];
  await h.run({
    type: "report_automation",
    target_id: a.id,
    expected_version: a.version,
    business_date: "2026-10-26",
    occurrence_id: o.id,
    report: "只留秘书事实",
    to_diary: false,
  });
  await h.core.assistant.tick();
  expect(
    h.store.day("2026-10-26").automation_occurrences![0].diary,
  ).toBeUndefined();
  expect(h.store.files.list().some((p) => p.endsWith("2026-10-26.md"))).toBe(
    false,
  );
});
it("T03/T28 accepted parent decisions use conditional section projection, preserving existing and unrelated prose", async () => {
  const { h } = setup(),
    p = createPeriod(h.store, "monthly", "2026-10-26").path,
    raw = h.store.files.read(p),
    input = h.input();
  const action = {
    type: "set_period_focus",
    kind: "monthly",
    business_date: "2026-10-26",
    content: "- 延续英语",
    base_hash: hash(raw),
  };
  await h.run(action, input);
  expect(h.store.files.read(p)).toContain("- 延续英语");
  expect(h.store.files.read(p)).toContain("# 月末回看");
  await h.run(action, input);
  expect(h.store.files.read(p).match(/延续英语/g)).toHaveLength(1);
  await expect(
    h.run({ ...action, content: "覆盖", base_hash: hash(raw) }),
  ).rejects.toMatchObject({ status: 409 });
  expect(h.store.files.read(p)).not.toContain("覆盖");
});
it("T02 explicit smaller quantity remains partial while an unquantified self-report does not demand another form", async () => {
  const { h } = setup(),
    created = await h.run({
      ...habitAction,
      min_behavior: "复习10个词",
      minimum_quantity: { value: 10, unit: "词" },
    }),
    target = created.updated_ids[0];
  await h.run({
    type: "report_habit",
    target_id: target,
    business_date: "2026-10-26",
    status: "did",
    quantity: { value: 4, unit: "词" },
  });
  expect(h.store.day("2026-10-26").occurrences[0].status).toBe("partial");
  await h.run({
    type: "report_habit",
    target_id: target,
    business_date: "2026-10-26",
    status: "did",
  });
  expect(h.store.day("2026-10-26").occurrences[0].status).toBe("did");
});
it("T27 nonexistent DST slots skip, repeated local times choose the first offset", () => {
  expect(localInstant("2026-03-08", "02:30", "America/New_York")).toBeNull();
  expect(localInstant("2026-11-01", "01:30", "America/New_York")).toBe(
    "2026-11-01T05:30:00.000Z",
  );
});
it("T28 a crash after the accepted period operation recovers its section exactly once", async () => {
  const { h } = setup(),
    p = createPeriod(h.store, "weekly", "2026-10-26").path,
    raw = h.store.files.read(p);
  h.store.fault = (stage) => {
    if (stage === "files_applied") throw new Error("crash");
  };
  await expect(
    h.run({
      type: "set_period_focus",
      kind: "weekly",
      business_date: "2026-10-26",
      content: "- 保留英语",
      base_hash: hash(raw),
    }),
  ).rejects.toThrow("crash");
  h.store.fault = undefined;
  await h.restart();
  expect(h.store.files.read(p).match(/保留英语/g)).toHaveLength(1);
  h.core.recoverPending();
  expect(h.store.files.read(p).match(/保留英语/g)).toHaveLength(1);
});
it("T13/T15 changing input during model planning invalidates the draft instead of overwriting it", async () => {
  const { h } = setup("2026-10-26T13:00:00Z");
  let release: (value: any) => void = () => {};
  let started = false;
  h.core.agent = {
    interpret: async () => {
      started = true;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  h.core.assistant.startPlanning();
  await expect.poll(() => started).toBe(true);
  await rule(h, "planning.evening_time", "20:00");
  release({
    action_groups: [{ action_identity: "stale", actions: [taskAction] }],
    clarification: null,
    reply_intent: "proposal",
    discussion: "过期建议",
  });
  await h.core.assistant.drain();
  expect(h.store.registry().tasks).toHaveLength(0);
  expect(h.store.registry().proposals).toHaveLength(0);
  expect(h.store.day("2026-10-27").assistance?.status).toBe("superseded");
});
it("T32 model failures retry at most once while preserving existing schedules", async () => {
  const { h } = setup("2026-10-26T13:00:00Z");
  let calls = 0;
  h.core.agent = {
    interpret: async () => {
      calls++;
      throw new Error("offline");
    },
  };
  for (let i = 0; i < 4; i++) {
    h.core.assistant.startPlanning();
    await h.core.assistant.drain();
    if (i === 1) {
      expect(calls).toBe(1);
      h.advance(60001);
    }
  }
  expect(calls).toBe(2);
  expect(h.store.day("2026-10-27").assistance?.status).toBe("failed");
  expect(h.store.day("2026-10-27").assistance?.cause_code).toBe("Error");
});
it("disabling automatic daily creation also applies to the proactive model context", async () => {
  const { h } = setup("2026-10-26T13:00:00Z");
  await rule(h, "planning.auto_create_daily", false);
  h.core.agent = {
    interpret: async () => ({
      action_groups: [],
      clarification: null,
      reply_intent: "discussion",
      discussion: "保留未建日记",
    }),
  };
  h.core.assistant.startPlanning();
  await h.core.assistant.drain();
  expect(
    h.store.files.list().filter((p) => p.includes("2026-10-27")),
  ).toHaveLength(0);
  expect(h.store.day("2026-10-27").assistance?.status).toBe("done");
});
it("an explicit plan request can retry a finished planning session without replaying the prior job", async () => {
  const { h } = setup("2026-10-26T13:00:00Z");
  let calls = 0;
  h.core.agent = {
    interpret: async () => {
      calls++;
      return {
        action_groups: [],
        clarification: null,
        reply_intent: "discussion",
        discussion: "保留已确认安排",
      };
    },
  };
  h.core.assistant.startPlanning();
  await h.core.assistant.drain();
  expect(calls).toBe(1);
  await h.run({ type: "plan_day", business_date: "2026-10-27" });
  h.core.assistant.startPlanning();
  await h.core.assistant.drain();
  expect(calls).toBe(2);
  expect(h.store.day("2026-10-27").assistance?.status).toBe("done");
  expect(
    h.store.db
      .prepare("SELECT count(*) n FROM inbox WHERE channel='coordinator'")
      .get(),
  ).toMatchObject({ n: 2 });
});
it("T27 a real wall clock jump cannot fast-forward the focus timer", async () => {
  const { h } = setup();
  (h.store as any).realtime = true;
  await h.run({ type: "start_focus", work_minutes: 25 });
  await h.core.assistant.tick();
  h.advance(25 * 60000);
  await h.core.assistant.tick();
  expect(h.core.assistant.view().focus?.status).toBe("needs_resume");
  expect(h.core.assistant.view().focus?.round_index).toBe(1);
});
it("QQ settings, timed delivery and quoted feedback close through the ordinary agent loop", async () => {
  const t = setup();
  t.h.core.agent = {
    interpret: async (input, context: any) => ({
      action_groups: [
        {
          action_identity: "command",
          actions:
            input.text === "刚才读了英语"
              ? [
                  {
                    type: "report_automation",
                    target_id: context.reply_occurrences[0].id,
                    expected_version: context.assistant.automations.find(
                      (a: any) => a.id === context.reply_occurrences[0].id,
                    ).version,
                    business_date: context.reply_occurrences[0].business_date,
                    occurrence_id: context.reply_occurrences[0].occurrence_id,
                    report: "读了英语",
                  },
                ]
              : input.text.includes("20点")
                ? [
                    {
                      type: "set_personal_rule",
                      key: "planning.evening_time",
                      value: "20:00",
                      expected_rules_revision: context.assistant.rules_revision,
                    },
                  ]
                : [
                    {
                      type: "create_automation",
                      kind: "one_shot",
                      title: "Hello",
                      body: "Hello",
                      delay_seconds: 30,
                    },
                  ],
        },
      ],
      clarification: null,
      reply_intent: "receipt",
    }),
  };
  await t.h.core.receive({ ...t.h.input("以后20点规划"), channel: "qq" });
  await expect
    .poll(() => t.h.core.assistant.view().planning.evening_time)
    .toBe("20:00");
  await t.h.core.receive({
    ...t.h.input("30秒之后提醒我发Hello"),
    channel: "qq",
  });
  await expect
    .poll(() => t.h.store.registry().automations?.length ?? 0)
    .toBe(1);
  t.h.advance(30000);
  await t.h.core.assistant.tick();
  await t.scheduler().tick(); // a passive receipt has priority
  await t.scheduler().tick();
  await t.scheduler().tick();
  expect(t.sent.some((x) => x === "Hello")).toBe(true);
  await t.h.core.assistant.tick();
  await t.h.core.assistant.tick();
  expect(t.h.store.registry().automations![0].status).toBe("retired");
  const delivered = t.h.store.db
    .prepare(
      "SELECT external_id FROM outbox WHERE body='Hello' AND status='sent'",
    )
    .get() as any;
  await t.h.core.receive({
    ...t.h.input("刚才读了英语"),
    channel: "qq",
    reply_to: delivered.external_id,
  });
  await expect
    .poll(
      () =>
        t.h.store
          .day("2026-10-26")
          .automation_occurrences?.find((o) => o.report)?.report?.text,
    )
    .toBe("读了英语");
  expect(t.h.store.registry().tasks).toHaveLength(0);
});
it("a polite timed-message command executes while a capability question leaves no proposal", async () => {
  const { h } = setup();
  h.core.agent = {
    interpret: async () => ({
      action_groups: [
        {
          action_identity: "message",
          actions: [
            {
              type: "create_automation",
              kind: "one_shot",
              title: "Hello",
              body: "Hello",
              delay_seconds: 30,
            },
          ],
        },
      ],
      clarification: null,
      reply_intent: "receipt",
    }),
  };
  await h.core.receive({
    ...h.input("请在30秒之后通过QQ发一条消息，内容是Hello。"),
    channel: "qq",
  });
  await expect.poll(() => h.store.registry().automations?.length ?? 0).toBe(1);
  const query = {
    ...h.input("只是测试能力：请在30秒之后通过QQ发一条消息，你能不能做到？"),
    channel: "qq",
  };
  await h.core.receive(query);
  await expect.poll(() => (h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(query.id) as any)?.status).toBe("processed");
  expect(h.store.registry().proposals).toHaveLength(0);
  expect(h.store.registry().automations).toHaveLength(1);
});

it.each([
  ["请在30秒之后发一条Hello，只设置一次消息提醒，不建任务或习惯。", true],
  ["请在30秒后给我发Hello，这次不要写日记。", true],
  ["请设置30秒后的一次提醒，不改已有任务。", true],
  ["假如我说请设置30秒后提醒，只是测试能力，不要执行。", false],
  ["帮我设计一个提醒方案，现在只讨论，先不要设置。", false],
  ["我不是让你真的做，读一下说明怎么设置提醒。", false],
])("real-model regression: command scope %s", async (text, executes) => {
  const { h } = setup();
  h.core.agent = {
    interpret: async () => ({
      action_groups: [{ action_identity: "one-shot", actions: [{
        type: "create_automation", kind: "one_shot", title: "Hello", body: "Hello", delay_seconds: 30,
      }] }], clarification: null, reply_intent: "receipt",
    }),
  };
  const input = { ...h.input(text), channel: "qq" };
  await h.core.receive(input);
  await expect.poll(() => (h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id) as any)?.status).toBe("processed");
  expect(h.store.registry().automations ?? []).toHaveLength(executes ? 1 : 0);
  expect(h.store.registry().proposals).toHaveLength(!executes && text.includes("设计一个提醒方案") ? 1 : 0);
});

it("continuing a paused focus session is an explicit command, not another proposal", async () => {
  const { h } = setup();
  await h.run({type:"start_focus",rounds:1});
  let f=h.core.assistant.view().focus!;
  await h.run({type:"pause_focus",target_id:f.id,expected_version:f.version});
  h.core.agent={interpret:async()=>{
    f=h.core.assistant.view().focus!;
    return {action_groups:[{action_identity:"resume",actions:[{type:"resume_focus",target_id:f.id,expected_version:f.version}]}],clarification:null,reply_intent:"receipt"};
  }};
  await h.core.receive(h.input("继续刚才的番茄钟。"));
  await expect.poll(()=>h.core.assistant.view().focus?.status).toBe("active");
  expect(h.store.registry().proposals).toHaveLength(0);
});

it("an explicit reminder cannot authorize an extra task the user specifically excluded", async () => {
  const { h } = setup();
  h.core.agent = { interpret: async () => ({
    action_groups: [{ action_identity: "bad-extra", actions: [
      { type: "create_automation", kind: "one_shot", title: "Hello", body: "Hello", delay_seconds: 30 },
      taskAction,
    ] }], clarification: null, reply_intent: "receipt", discussion: "已全部完成",
  }) };
  const input = h.input("请在30秒后发一条Hello，不建任务或习惯。");
  await h.core.receive(input);
  await expect.poll(() => (h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id) as any)?.status).toBe("processed");
  const meta = JSON.parse((h.store.db.prepare("SELECT metadata_json FROM inbox WHERE id=?").get(input.id) as any).metadata_json);
  expect(meta.groups[0]).toMatchObject({status: "rejected", reason: "USER_RESTRICTION"});
  expect(h.store.registry().tasks).toHaveLength(0);
  expect(h.store.registry().automations ?? []).toHaveLength(0);
  expect(meta.reply).toContain("未执行");
  expect(meta.reply).not.toContain("已全部完成");
});

it("a necessary clarification is sent once even when the model repeats it in discussion", async () => {
  const { h } = setup();
  h.core.agent = { interpret: async () => ({
    action_groups: [], reply_intent: "clarification", discussion: "可以设置，哪几天、什么时间段？",
    clarification: "你希望哪几天、每天哪个时段启用？",
  }) };
  const input = h.input("请以后每小时最后五分钟问我在做什么");
  await h.core.receive(input);
  await expect.poll(() => (h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id) as any)?.status).toBe("processed");
  const value = h.store.db.prepare("SELECT metadata_json FROM inbox WHERE id=?").get(input.id) as any;
  expect(JSON.parse(value.metadata_json).reply).toBe("你希望哪几天、每天哪个时段启用？");
  expect(h.store.registry().automations ?? []).toHaveLength(0);
});

it("T32 interrupted final planning attempt recovers to failed without hiding the deterministic notice", async () => {
  const { h } = setup("2026-10-26T13:00:00Z");
  h.store.commit("interrupted", "test", "test", (_r, load) => {
    load("2026-10-27").assistance = {
      status: "running",
      attempts: 2,
      revision: 1,
    };
    return { ids: [], message: "fixture" };
  });
  await h.restart();
  expect(h.store.day("2026-10-27").assistance).toMatchObject({
    status: "failed",
    error: "PLANNING_INTERRUPTED",
    attempts: 2,
  });
  let calls = 0;
  h.core.agent = {
    interpret: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };
  h.core.assistant.startPlanning();
  await h.core.assistant.drain();
  expect(calls).toBe(0);
});

it("T29 old-date opted-in reports survive downtime and project once while narrative remains intact", async () => {
  const { h } = setup();
  await h.run({ ...hourly, to_diary: true });
  h.advance(10000);
  await h.core.assistant.tick();
  const o = h.store.day("2026-10-26").automation_occurrences![0],
    a = h.store.registry().automations![0];
  await h.run({
    type: "report_automation",
    target_id: a.id,
    expected_version: a.version,
    occurrence_id: o.id,
    business_date: "2026-10-26",
    report: "整理了资料",
  });
  const p = createPeriod(h.store, "daily", "2026-10-26").path;
  atomicWrite(
    h.store.files.resolve(p),
    h.store.files.read(p) + "\n自己的随笔，保持原文。\n",
  );
  h.setTime("2026-11-01T01:00:00Z");
  await h.restart();
  await h.core.assistant.tick();
  await h.core.assistant.tick();
  expect(h.store.files.read(p).match(/整理了资料/g)).toHaveLength(1);
  expect(h.store.files.read(p)).toContain("自己的随笔，保持原文。");
});

it("T24 paused rules cannot bypass the combined subscription guard when resumed", async () => {
  const { h } = setup();
  const full = {
    ...hourly,
    schedule: { ...hourly.schedule, local_start: "00:00", local_end: "23:59" },
  };
  await h.run(full);
  let a = h.store.registry().automations![0];
  await h.run({
    type: "control_automation",
    target_id: a.id,
    expected_version: a.version,
    control: "pause",
  });
  await h.run({ ...full, title: "第二条" });
  await h.run({ ...full, title: "第三条" });
  a = h.store.registry().automations![0];
  await expect(
    h.run({
      type: "control_automation",
      target_id: a.id,
      expected_version: a.version,
      control: "resume",
    }),
  ).rejects.toMatchObject({ code: "ASSISTANT_INVALID" });
  await expect(h.run({ type: "start_focus", rounds: 7 })).rejects.toMatchObject(
    { code: "ASSISTANT_INVALID" },
  );
});

it("T36 stopping contact persists through restart and suppresses explicit subscriptions", async () => {
  const t = setup();
  await t.h.run(hourly);
  await rule(t.h, "contact.enabled", false);
  t.h.advance(10000);
  await t.h.restart();
  await t.h.core.assistant.tick();
  await t.scheduler().tick();
  expect(t.sent).toHaveLength(0);
  expect(t.h.core.assistant.view().values["contact.enabled"]).toBe(false);
  await rule(t.h, "contact.enabled", true);
  await t.scheduler().tick();
  expect(t.sent).toHaveLength(1);
});
it("automatic context remains bounded even when the private rules and board grow", async () => {
  const { h } = setup();
  for (let i = 0; i < 12; i++) {
    await rule(h, "contact.style", "简短".repeat(100));
    await h.run({
      ...hourly,
      title: "回顾" + i,
      body: "提示".repeat(400),
      kind: "recurring",
      schedule: { weekdays: [1,2,3,4,5], starts_on: "2026-10-26", local_start: "09:00", local_end: "18:00" },
    });
  }
  const context = h.core.context(h.input("现在有哪些安排？"));
  expect(JSON.stringify(context).length).toBeLessThanOrEqual(12000);
  expect(context.truncated.assistant).toBe(true);
  expect(h.core.assistant.view().automations).toHaveLength(12);
});
it("resuming a focus rechecks protected time instead of resuming through a new boundary", async () => {
  const { h } = setup();
  await h.run({ type: "start_focus", work_minutes: 25, rounds: 1 });
  const f = h.core.assistant.view().focus!;
  await h.run({
    type: "pause_focus",
    target_id: f.id,
    expected_version: f.version,
  });
  await rule(h, "planning.protected", [
    { weekdays: [1], start: "10:00", end: "11:00" },
  ]);
  const paused = h.core.assistant.view().focus!;
  await expect(
    h.run({
      type: "resume_focus",
      target_id: paused.id,
      expected_version: paused.version,
    }),
  ).rejects.toThrow("保护时段");
  expect(h.core.assistant.view().focus?.status).toBe("paused");
});
