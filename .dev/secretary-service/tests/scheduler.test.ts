import { afterEach, it, expect } from "vitest";
import { harness, habitAction, taskAction } from "./helpers.js";
import { Scheduler, type Channel } from "../apps/core/scheduler.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
function setup(time?: string) {
  const h = harness(time);
  cleanups.push(() => h.close());
  const sent: string[] = [];
  let response: "sent" | "unknown" | "failed" = "sent";
  const channel: Channel = {
    health: () => ({ connected: true, lastEventAt: null }),
    send: async (message) => {
      sent.push(message.body);
      return response === "sent"
        ? { status: "sent", externalId: "qq-" + sent.length }
        : response === "failed"
          ? { status: "failed", reason: "not delivered" }
          : { status: "unknown", reason: "timeout" };
    },
  };
  return {
    h,
    sent,
    scheduler: new Scheduler(h.core, channel, "user"),
    setResponse: (r: typeof response) => {
      response = r;
    },
  };
}
it("S02 two overlapping ticks dispatch only once", async () => {
  const t = setup();
  await t.h.run(habitAction);
  await Promise.all([t.scheduler.tick(), t.scheduler.tick()]);
  expect(t.sent).toHaveLength(1);
});
it("reply chunks flush promptly without creating extra proactive reminders", async () => {
  const t = setup();
  await t.h.run(habitAction);
  t.h.core.queueReply(
    { ...t.h.input(), channel: "qq", actor_ref: "user" },
    "字".repeat(4000),
  );
  await t.scheduler.flushReceipts();
  expect(t.sent).toHaveLength(3);
  expect(
    t.h.store.db
      .prepare("SELECT count(*) n FROM outbox WHERE counts_as_proactive=1")
      .get(),
  ).toMatchObject({ n: 0 });
  t.scheduler.close();
  await t.scheduler.tick();
  expect(t.sent).toHaveLength(3);
});
it("overlong QQ answers continue on a fresh user message without losing text or invoking the model", async () => {
  const t = setup(),
    input = { ...t.h.input("读文件"), channel: "qq", actor_ref: "user" },
    text = "甲".repeat(11000);
  await t.h.core.receive(input);
  t.h.core.finishInput(input, text);
  let rows = t.h.store.db
    .prepare("SELECT body FROM outbox ORDER BY rowid")
    .all() as any[];
  expect(rows).toHaveLength(4);
  expect(rows.at(-1).body).toContain("回复“继续”");
  const next = { ...t.h.input("继续"), channel: "qq", actor_ref: "user" };
  await t.h.core.receive(next);
  rows = t.h.store.db
    .prepare("SELECT body FROM outbox ORDER BY rowid")
    .all() as any[];
  expect(rows).toHaveLength(7);
  const plain = rows
    .map((r) =>
      r.body
        .replace(/^（\d+\/\d+）\n/, "")
        .replace("\n\n内容较长，回复“继续”查看余下内容。", ""),
    )
    .join("");
  expect(plain).toBe(text);
  const state: any = t.h.store.db
    .prepare("SELECT status FROM inbox WHERE id=?")
    .get(next.id);
  expect(state.status).toBe("processed");
  const duplicate = await t.h.core.receive(next);
  expect(duplicate.duplicate).toBe(true);
  expect(
    t.h.store.db.prepare("SELECT count(*) n FROM outbox").get(),
  ).toMatchObject({ n: 7 });
});
it("QQ long replies keep every character, deduplicate chunks and preserve order through failed/unknown delivery", async () => {
  const t = setup(),
    input = { ...t.h.input(), channel: "qq", actor_ref: "user" };
  const text = "甲".repeat(1799) + "😀" + "乙".repeat(2400);
  t.h.core.queueReply(input, text);
  t.h.core.queueReply(input, text);
  const rows = t.h.store.db
    .prepare("SELECT body FROM outbox ORDER BY rowid")
    .all() as any[];
  expect(rows).toHaveLength(3);
  expect(rows.map((r) => r.body.replace(/^（\d+\/\d+）\n/, "")).join("")).toBe(
    text,
  );
  expect(rows.every((r) => r.body.length <= 2000)).toBe(true);
  t.setResponse("failed");
  await t.scheduler.tick();
  expect(t.sent).toHaveLength(1);
  await t.scheduler.tick();
  expect(t.sent).toHaveLength(1);
  t.h.advance(31000);
  t.setResponse("sent");
  await t.scheduler.tick();
  await t.scheduler.tick();
  await t.scheduler.tick();
  expect(t.sent.slice(1)).toEqual(rows.map((r) => r.body));
  const second = { ...input, id: crypto.randomUUID() };
  t.h.core.queueReply(second, text);
  t.setResponse("unknown");
  await t.scheduler.tick();
  const count = t.sent.length;
  t.h.advance(60000);
  await t.scheduler.tick();
  expect(t.sent).toHaveLength(count);
});
it("S03 unknown delivery consumes budget and is not blindly retried", async () => {
  const t = setup();
  await t.h.run(habitAction);
  t.setResponse("unknown");
  await t.scheduler.tick();
  t.h.advance(60000);
  await t.scheduler.tick();
  expect(t.sent).toHaveLength(1);
  expect(t.h.store.db.prepare("SELECT status FROM outbox").get()).toMatchObject(
    { status: "unknown" },
  );
});
it("S04 definitely failed sends retry at most twice", async () => {
  const t = setup();
  await t.h.run(habitAction);
  t.setResponse("failed");
  await t.scheduler.tick();
  for (let i = 0; i < 5; i++) {
    t.h.advance(180000);
    await t.scheduler.tick();
  }
  expect(t.sent).toHaveLength(3);
});
it("S05 quiet hours prevent proactive sending even for a due task", async () => {
  const t = setup("2026-10-23T15:30:00Z");
  const task = await t.h.run(taskAction);
  await t.h.run({
    type: "schedule",
    target_id: task.updated_ids[0],
    window_start: "2026-10-23T15:00:00Z",
    window_end: "2026-10-23T15:59:00Z",
    duration_minutes: 10,
    next_action: "写结论",
  });
  await t.scheduler.tick();
  expect(t.sent).toHaveLength(0);
});
it("S05 follow-up waits 90 minutes and requires recent engagement", async () => {
  const t = setup();
  await t.h.run(habitAction);
  await t.scheduler.tick();
  t.h.advance(89 * 60000);
  await t.scheduler.tick();
  expect(t.sent).toHaveLength(1);
  t.h.advance(2 * 60000);
  await t.scheduler.tick();
  expect(t.sent).toHaveLength(1);
});
it("S08 completed habit cancels pending follow-up", async () => {
  const t = setup(),
    habit = await t.h.run(habitAction);
  await t.scheduler.tick();
  await t.h.run({
    type: "report_habit",
    target_id: habit.updated_ids[0],
    business_date: "2026-10-23",
    status: "did",
  });
  t.h.advance(91 * 60000);
  await t.scheduler.tick();
  expect(t.sent).toHaveLength(1);
});
it("S05 explicit subscriptions have their own budget; optional follow-ups retain the four-message cap and sixty-minute gap", async () => {
  const t = setup("2026-10-23T00:00:00Z");
  await t.h.core.receive(t.h.input("我在，照常提醒"));
  for (let i = 0; i < 6; i++)
    await t.h.run({
      ...habitAction,
      title: "习惯" + i,
      anchor: { kind: "time_window", local_start: "08:00", local_end: "22:59" },
    });
  await t.scheduler.tick();
  expect(t.sent).toHaveLength(1);
  t.h.advance(59 * 60000);
  await t.scheduler.tick();
  expect(t.sent).toHaveLength(2);
  t.h.advance(60 * 60000);
  await t.scheduler.tick();
  expect(t.sent).toHaveLength(3);
  t.h.advance(59 * 60000);
  await t.scheduler.tick();
  expect(t.sent).toHaveLength(3);
  t.h.advance(60000);
  await t.scheduler.tick();
  for (let i = 0; i < 4; i++) {
    t.h.advance(60 * 60000);
    await t.scheduler.tick();
  }
  expect(t.sent).toHaveLength(6);
  expect(
    t.h.store.db
      .prepare(
        "SELECT count(*) n FROM outbox WHERE message_kind='follow_up' AND status='sent'",
      )
      .get(),
  ).toMatchObject({ n: 4 });
});
it("S02 rescheduling an unsent plan refreshes the window without resetting the reminder key", async () => {
  const t = setup();
  const task = await t.h.run(taskAction);
  const plan = await t.h.run({
    type: "schedule",
    target_id: task.updated_ids[0],
    window_start: "2026-10-23T12:00:00Z",
    window_end: "2026-10-23T14:50:00Z",
    duration_minutes: 10,
    next_action: "写结论",
  });
  let connected = false;
  const channel: Channel = {
    health: () => ({ connected, lastEventAt: null }),
    send: async (message) => {
      t.sent.push(message.body);
      return { status: "sent", externalId: "send" };
    },
  };
  const scheduler = new Scheduler(t.h.core, channel, "user");
  await scheduler.tick();
  await t.h.run({
    type: "reschedule",
    target_id: plan.updated_ids[0],
    window_start: "2026-10-23T13:00:00Z",
    window_end: "2026-10-23T14:00:00Z",
  });
  connected = true;
  await scheduler.tick();
  expect(t.sent).toHaveLength(0);
  t.h.advance(60 * 60000);
  await scheduler.tick();
  expect(t.sent).toHaveLength(1);
  await scheduler.tick();
  expect(t.sent).toHaveLength(1);
  expect(
    t.h.store.db
      .prepare("SELECT count(*) AS n FROM outbox WHERE message_kind='initial'")
      .get(),
  ).toMatchObject({ n: 1 });
});
it("S08 a queued completion wins before channel entry; an already in-flight send is recorded truthfully", async () => {
  const t = setup();
  const habit = await t.h.run(habitAction);
  const completion = t.h.run({
    type: "report_habit",
    target_id: habit.updated_ids[0],
    business_date: "2026-10-23",
    status: "did",
  });
  await Promise.all([completion, t.scheduler.tick()]);
  expect(t.sent).toHaveLength(0);
  const task = await t.h.run(taskAction);
  await t.h.run({
    type: "schedule",
    target_id: task.updated_ids[0],
    window_start: "2026-10-23T12:00:00Z",
    window_end: "2026-10-23T14:00:00Z",
    duration_minutes: 10,
    next_action: "写结论",
  });
  let resolve!: (r: { status: "sent"; externalId: string }) => void;
  let entered = false;
  const scheduler = new Scheduler(
    t.h.core,
    {
      health: () => ({ connected: true, lastEventAt: null }),
      send: () => {
        entered = true;
        return new Promise((r) => {
          resolve = r;
        });
      },
    },
    "user",
  );
  const tick = scheduler.tick();
  await expect.poll(() => entered).toBe(true);
  await t.h.run({ type: "pause_contact" });
  resolve({ status: "sent", externalId: "already-in-flight" });
  await tick;
  expect(
    t.h.store.db
      .prepare(
        "SELECT status,external_id FROM outbox WHERE external_id='already-in-flight'",
      )
      .get(),
  ).toMatchObject({ status: "sent" });
});
it("S06 restart with ten expired candidates sends only a current valid opportunity", async () => {
  const t = setup("2026-10-22T12:00:00Z");
  for (let i = 0; i < 10; i++)
    await t.h.run({
      ...habitAction,
      title: "旧习惯" + i,
      recurrence: {
        weekdays: [4],
        starts_on: "2026-01-01",
        ends_on: "2026-10-22",
      },
    });
  const offline: Channel = {
    health: () => ({ connected: false, lastEventAt: null }),
    send: async () => ({ status: "failed", reason: "offline" }),
  };
  await new Scheduler(t.h.core, offline, "user").tick();
  t.h.setTime("2026-10-23T12:00:00Z");
  await t.h.restart();
  await t.h.run({ ...habitAction, title: "今天的习惯" });
  const scheduler = new Scheduler(
    t.h.core,
    {
      health: () => ({ connected: true, lastEventAt: null }),
      send: async (m) => {
        t.sent.push(m.body);
        return { status: "sent", externalId: "new" };
      },
    },
    "user",
  );
  await scheduler.tick();
  await scheduler.tick();
  expect(t.sent).toHaveLength(1);
  expect(
    t.h.store.db
      .prepare(
        "SELECT count(*) AS n FROM outbox,json_each(outbox.target_refs_json) WHERE outbox.status='expired'",
      )
      .get(),
  ).toMatchObject({ n: 10 });
});
it("exhausted failed delivery cannot block another eligible item", async () => {
  const t = setup();
  await t.h.run(habitAction);
  t.setResponse("failed");
  await t.scheduler.tick();
  t.h.advance(30000);
  await t.scheduler.tick();
  t.h.advance(120000);
  await t.scheduler.tick();
  expect(t.sent).toHaveLength(3);
  await t.h.run({ ...habitAction, title: "另一个习惯" });
  t.setResponse("sent");
  await t.scheduler.tick();
  expect(t.sent).toHaveLength(4);
  expect(
    t.h.store.db
      .prepare("SELECT count(*) AS n FROM outbox WHERE status='sent'")
      .get(),
  ).toMatchObject({ n: 1 });
});
it("event anchors need a genuine registered user event; the clock alone cannot trigger them", async () => {
  const t = setup(),
    habit = await t.h.run({
      ...habitAction,
      anchor: { kind: "event", event_key: "晚饭结束" },
    });
  await t.scheduler.tick();
  expect(t.sent).toHaveLength(0);
  await expect(
    t.h.run({
      type: "report_event",
      target_id: habit.updated_ids[0],
      event_key: "猜测晚饭",
    }),
  ).rejects.toMatchObject({ code: "EVENT_NOT_REGISTERED" });
  await t.h.run(
    {
      type: "report_event",
      target_id: habit.updated_ids[0],
      event_key: "晚饭结束",
    },
    t.h.input("晚饭吃完了"),
  );
  await t.scheduler.tick();
  expect(t.sent).toHaveLength(1);
  await t.scheduler.tick();
  expect(t.sent).toHaveLength(1);
});
it("greedy placement uses only supplied free windows and preserves the hard deadline when no slot fits", async () => {
  const t = setup(),
    first = await t.h.run({ ...taskAction, title: "固定安排" }),
    second = await t.h.run({ ...taskAction, title: "可安排任务" });
  await t.h.run({
    type: "schedule",
    target_id: first.updated_ids[0],
    kind: "fixed",
    window_start: "2026-10-23T12:00:00Z",
    window_end: "2026-10-23T13:00:00Z",
    duration_minutes: 60,
    next_action: "既有预约",
  });
  await t.h.run({
    type: "schedule",
    target_id: second.updated_ids[0],
    available_windows: [
      { start: "2026-10-23T12:00:00Z", end: "2026-10-23T14:00:00Z" },
    ],
    duration_minutes: 30,
    next_action: "写一段",
  });
  expect(t.h.store.registry().plans[1].window_start).toBe(
    "2026-10-23T13:00:00.000Z",
  );
  await expect(
    t.h.run({
      type: "schedule",
      target_id: second.updated_ids[0],
      available_windows: [
        { start: "2026-10-23T12:10:00Z", end: "2026-10-23T12:50:00Z" },
      ],
      duration_minutes: 20,
      next_action: "放不下",
    }),
  ).rejects.toMatchObject({ code: "NO_CAPACITY" });
  expect(t.h.store.registry().tasks[1].due_at).toBe("2026-10-24T10:00:00.000Z");
});
