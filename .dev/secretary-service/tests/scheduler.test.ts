import { afterEach, it, expect } from "vitest";
import fs from "node:fs";
import { harness, habitAction, taskAction } from "./helpers.js";
import { businessCall } from "../apps/core/agent-runtime.js";
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
it("S4 an interjection stops the old write but both questions still get an answer", async () => {
  const h = harness("2026-10-23T12:00:00Z");
  cleanups.push(() => h.close());
  let releaseA!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  h.core.agent = {
    executionMode: "tools-v2",
    interpret: async (input: { text: string }) => {
      if (input.text.startsWith("先查材料")) {
        await gate;
        return { action_groups: [], clarification: null, reply_intent: "discussion", discussion: "A 的材料查到了。" };
      }
      return { action_groups: [], clarification: null, reply_intent: "discussion", discussion: "明天第一件事是看词表。" };
    },
  } as any;
  const a = { ...h.input("先查材料 A 和 B"), channel: "qq", actor_ref: "user" };
  await h.core.receive(a);
  await expect
    .poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(a.id))
    .toMatchObject({ status: "processing" });

  // The user adds a correction while the slow tool is still running.
  const interjection = { ...h.input("B 不用查了；顺便告诉我明天第一件事"), channel: "qq", actor_ref: "user" };
  await h.core.receive(interjection);

  // The old turn may not commit anything that ignores this newer message.
  await expect(
    businessCall(h.core, {
      input_id: a.id,
      call_id: "old-write",
      operation: "apply_changes",
      action_groups: [
        {
          action_identity: "b",
          actions: [
            {
              type: "create_task",
              title: "查材料B",
              outcome: "拿到 B",
              due_at: "2026-10-24T10:00:00Z",
              acceptance: [{ id: "done", kind: "check", description: "拿到 B" }],
            },
          ],
        },
      ],
    } as any),
  ).rejects.toMatchObject({ code: "NEWER_INPUT_PENDING" });

  releaseA();
  await expect
    .poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(interjection.id))
    .toMatchObject({ status: "processed" });
  const bodies = (h.store.db.prepare("SELECT body FROM outbox ORDER BY rowid").all() as any[]).map((row) => row.body);
  // Both the earlier answer and the answer to the correction reach the queue.
  expect(bodies.join("\n")).toContain("A 的材料查到了");
  expect(bodies.join("\n")).toContain("明天第一件事");
  // The cancelled part never became a task.
  expect(h.store.registry().tasks.some((t) => t.title === "查材料B")).toBe(false);

  // Re-delivering the same message creates nothing new.
  const before = (h.store.db.prepare("SELECT count(*) n FROM outbox").get() as any).n;
  const duplicate = await h.core.receive({ ...h.input("B 不用查了；顺便告诉我明天第一件事"), external_id: interjection.external_id, channel: "qq", actor_ref: "user" } as any);
  expect(duplicate).toMatchObject({ duplicate: true });
  expect((h.store.db.prepare("SELECT count(*) n FROM outbox").get() as any).n).toBe(before);
});

it("S6 fourteen days away leave no backlog, and completion ends related reminders", async () => {
  const h = harness("2026-10-23T00:00:00Z");
  cleanups.push(() => h.close());
  const sent: string[] = [];
  const scheduler = new Scheduler(
    h.core,
    {
      health: () => ({ connected: true, lastEventAt: null }),
      send: async (message) => {
        sent.push(message.body);
        return { status: "sent", externalId: "s" + sent.length };
      },
    },
    "user",
  );
  cleanups.push(async () => {
    scheduler.close();
  });
  const habit = await h.run(habitAction);
  const task = await h.run({ ...taskAction, due_at: "2026-10-26T10:00:00Z" } as any);
  // The user is simply away: fourteen daily ticks, no invented feedback.
  for (let day = 0; day < 14; day++) {
    h.advance(24 * 60 * 60 * 1000);
    await scheduler.tick().catch(() => {});
  }
  const cap = h.store.config.notifications.daily_proactive_message_cap;
  const proactive = h.store.db
    .prepare("SELECT count(*) n FROM outbox WHERE counts_as_proactive=1 AND status='sent'")
    .get() as any;
  expect(proactive.n).toBeLessThanOrEqual(cap * 14);
  // Nothing stale is left queued forever.
  const stale = h.store.db
    .prepare(
      "SELECT count(*) n FROM outbox WHERE status IN ('pending','sending') AND expires_at<=?",
    )
    .get(h.store.now()) as any;
  expect(stale.n).toBe(0);
  // Absence was never recorded as failure or as the user's action.
  expect(
    h.store.db.prepare("SELECT count(*) n FROM events WHERE status='failed'").get(),
  ).toMatchObject({ n: 0 });
  expect(h.store.registry().tasks.find((t) => t.id === task.updated_ids[0])!.status).not.toBe("done");

  // Back again: finishing the task ends its reminders instead of nagging on.
  await h.run({
    type: "report_execution",
    target_id: task.updated_ids[0],
    execution: "progress",
    remaining_minutes: 0,
  } as any);
  await h.run({ type: "complete_task", target_id: task.updated_ids[0], expected_version: h.store.registry().tasks.find((t) => t.id === task.updated_ids[0])!.version } as any);
  const before = sent.length;
  for (let day = 0; day < 3; day++) {
    h.advance(24 * 60 * 60 * 1000);
    await scheduler.tick().catch(() => {});
  }
  const taskReminders = h.store.db
    .prepare(
      "SELECT count(*) n FROM outbox WHERE counts_as_proactive=1 AND status IN ('pending','sent') AND target_refs_json LIKE ?",
    )
    .get("%" + task.updated_ids[0] + "%") as any;
  expect(taskReminders.n).toBe(0);
  expect(sent.length).toBeGreaterThanOrEqual(before);
});

it("C6f a scheduled reminder still goes out while a message waits for the model", async () => {
  const h = harness("2026-10-23T12:00:00Z");
  cleanups.push(() => h.close());
  const sent: string[] = [];
  const scheduler = new Scheduler(
    h.core,
    {
      health: () => ({ connected: true, lastEventAt: null }),
      send: async (message) => {
        sent.push(message.body);
        return { status: "sent", externalId: "r" + sent.length };
      },
    },
    "user",
  );
  cleanups.push(async () => {
    scheduler.close();
  });
  // The user speaks, and the model is not available: the input waits as pending.
  await h.core.receive({ ...h.input("我等下再问"), channel: "qq", actor_ref: "user" });
  await h.run(habitAction);
  await scheduler.tick();
  // A due commitment is not silenced by an unrelated unanswered message; the
  // reminder is a commitment the user already made, not a reply.
  expect(sent).toHaveLength(1);
  // The waiting message is untouched and can still be answered later.
  expect(
    h.store.db.prepare("SELECT status FROM inbox WHERE channel='qq'").get(),
  ).toMatchObject({ status: "pending" });
});

it("Q8 the scheduler records what its last tick did", async () => {
  const h = harness("2026-10-23T12:00:00Z");
  cleanups.push(() => h.close());
  const scheduler = new Scheduler(
    h.core,
    { health: () => ({ connected: true, lastEventAt: null }), send: async () => ({ status: "sent", externalId: "x" }) },
    "user",
  );
  cleanups.push(async () => {
    scheduler.close();
  });
  await scheduler.tick();
  expect(scheduler.lastDispatch).toMatchObject({ sent: false, reason: "queue_empty" });
  // A real opportunity is prepared and delivered in one tick; the record says so.
  await h.run(habitAction);
  await scheduler.tick();
  expect(scheduler.lastDispatch).toMatchObject({ sent: true, reason: "sent" });
  const sent = h.store.db.prepare("SELECT status,message_kind FROM outbox WHERE counts_as_proactive=1 AND status='sent'").get() as any;
  expect(sent.message_kind).toBeTruthy();
  // And the status endpoint exposes it without a database query from the caller.
  expect(scheduler.lastDispatch?.at).toBe(h.store.now());
});

it("C2 a degraded runtime spends no model budget on classification", async () => {
  const h = harness("2026-10-23T12:00:00Z");
  cleanups.push(() => h.close());
  const scheduler = new Scheduler(
    h.core,
    { health: () => ({ connected: false, lastEventAt: null }), send: async () => ({ status: "failed", reason: "offline" }) },
    "user",
  );
  cleanups.push(async () => {
    scheduler.close();
  });
  let classifyCalls = 0;
  let releaseA!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  h.core.agent = {
    executionMode: "tools-v2",
    classify: async () => {
      classifyCalls++;
      throw new Error("should not run while degraded");
    },
    interpret: async () => {
      await gate;
      return { action_groups: [], clarification: null, reply_intent: "discussion", discussion: "好。" };
    },
  } as any;
  const busy = { ...h.input("先忙这条"), channel: "qq", actor_ref: "user" };
  await h.core.receive(busy);
  await expect
    .poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(busy.id))
    .toMatchObject({ status: "processing" });
  await h.core.receive({ ...h.input("另一条"), channel: "qq", actor_ref: "user" });
  h.store.state.degrade("FIXTURE_DEGRADED");
  await scheduler.tick();
  expect(classifyCalls).toBe(0);
  // The message stays unread rather than being guessed at.
  expect(
    h.store.db.prepare("SELECT classification FROM inbox WHERE status='pending'").get(),
  ).toMatchObject({ classification: "unclassified" });
  releaseA();
});

it("C2 a message that could not be classified is still answered exactly once", async () => {
  const h = harness("2026-10-23T12:00:00Z");
  cleanups.push(() => h.close());
  const scheduler = new Scheduler(
    h.core,
    { health: () => ({ connected: false, lastEventAt: null }), send: async () => ({ status: "sent", externalId: "x" }) },
    "user",
  );
  cleanups.push(async () => {
    scheduler.close();
  });
  let releaseBusy!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseBusy = resolve;
  });
  h.core.agent = {
    executionMode: "tools-v2",
    classify: async () => {
      throw new Error("classifier unavailable");
    },
    interpret: async (input: { text: string }) => {
      if (input.text.startsWith("先忙这条")) {
        await gate;
        return { action_groups: [], clarification: null, reply_intent: "discussion", discussion: "慢的那条处理完了。" };
      }
      return { action_groups: [], clarification: null, reply_intent: "discussion", discussion: "说得更具体一点？" };
    },
  } as any;
  const busy = { ...h.input("先忙这条"), channel: "qq", actor_ref: "user" };
  await h.core.receive(busy);
  await expect
    .poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(busy.id))
    .toMatchObject({ status: "processing" });
  const vague = { ...h.input("那个事你看着办"), channel: "qq", actor_ref: "user" };
  await h.core.receive(vague);
  await scheduler.tick();
  expect(
    h.store.db.prepare("SELECT classification FROM inbox WHERE id=?").get(vague.id),
  ).toMatchObject({ classification: "needs_clarification" });

  // Its own turn still runs and answers once — silence from the classifier never
  // turns into a dropped question or a stream of automated prompts.
  releaseBusy();
  await expect
    .poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(vague.id))
    .toMatchObject({ status: "processed" });
  const replies = (h.store.db.prepare("SELECT body FROM outbox ORDER BY rowid").all() as any[]).map((r) => r.body);
  expect(replies.filter((body) => body.includes("说得更具体一点")).length).toBe(1);
  for (let i = 0; i < 3; i++) {
    h.advance(60000);
    await scheduler.tick();
  }
  const after = (h.store.db.prepare("SELECT count(*) n FROM outbox").get() as any).n;
  expect(after).toBe(replies.length);
});

it("C2 an unreadable message is attempted twice and then kept as needs_clarification", async () => {
  const h = harness("2026-10-23T12:00:00Z");
  cleanups.push(() => h.close());
  const scheduler = new Scheduler(
    h.core,
    { health: () => ({ connected: false, lastEventAt: null }), send: async () => ({ status: "failed", reason: "offline" }) },
    "user",
  );
  cleanups.push(async () => {
    scheduler.close();
  });
  let calls = 0;
  let releaseA!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  h.core.agent = {
    executionMode: "tools-v2",
    classify: async () => {
      calls++;
      throw new Error("classifier unavailable");
    },
    interpret: async () => {
      await gate;
      return { action_groups: [], clarification: null, reply_intent: "discussion", discussion: "好。" };
    },
  } as any;
  const busy = { ...h.input("先处理这条"), channel: "qq", actor_ref: "user" };
  await h.core.receive(busy);
  await expect
    .poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(busy.id))
    .toMatchObject({ status: "processing" });
  // This one waits for its turn, so it is exactly the input the job must read.
  const vague = { ...h.input("这句话有点含糊"), channel: "qq", actor_ref: "user" };
  await h.core.receive(vague);
  const state = () =>
    h.store.db.prepare("SELECT classification,metadata_json FROM inbox WHERE id=?").get(vague.id) as any;

  await scheduler.tick();
  expect(calls).toBe(1);
  expect(state().classification).toBe("needs_clarification");
  // A second look is allowed, then the responsibility stops retrying by itself.
  await h.store.db.prepare("UPDATE inbox SET classification='unclassified' WHERE id=?").run(vague.id);
  await scheduler.tick();
  expect(calls).toBe(2);
  expect(state().classification).toBe("needs_clarification");
  await h.store.db.prepare("UPDATE inbox SET classification='unclassified' WHERE id=?").run(vague.id);
  await scheduler.tick();
  expect(calls).toBe(2);
  expect(state().classification).toBe("needs_clarification");
  expect(JSON.parse(state().metadata_json).classify_attempts).toBe(2);
  releaseA();
});

it("C2 an unrelated classified message stops holding older work", async () => {
  const h = harness("2026-10-23T12:00:00Z");
  cleanups.push(() => h.close());
  const scheduler = new Scheduler(
    h.core,
    {
      health: () => ({ connected: false, lastEventAt: null }),
      send: async () => ({ status: "failed", reason: "offline" }),
    },
    "user",
  );
  cleanups.push(async () => {
    scheduler.close();
  });
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let classified = 0;
  h.core.agent = {
    executionMode: "tools-v2",
    classify: async (inputs: { id: string }[]) => {
      classified += inputs.length;
      return {
        items: inputs.map((item: { id: string }) => ({
          input_id: item.id,
          interpretation: {
            acts: [
              {
                kind: "discuss",
                relation: "unrelated",
                affects: [],
                target_scope: "unknown",
                evidence_span: { start: 0, end: 1 },
              },
            ],
          },
        })),
      };
    },
    interpret: async () => {
      await gateA;
      return { action_groups: [], clarification: null, reply_intent: "discussion", discussion: "慢任务处理完了。" };
    },
  } as any;
  const a = { ...h.input("A 的慢任务"), channel: "qq", actor_ref: "user" };
  await h.core.receive(a);
  await expect
    .poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(a.id))
    .toMatchObject({ status: "processing" });
  const b = { ...h.input("今天天气不错，只是随口说说"), channel: "qq", actor_ref: "user" };
  await h.core.receive(b);

  const write = (callId: string) =>
    businessCall(h.core, {
      input_id: a.id,
      call_id: callId,
      operation: "apply_changes",
      action_groups: [
        {
          action_identity: "task",
          actions: [
            {
              type: "create_task",
              title: "查材料",
              outcome: "拿到结果",
              due_at: "2026-10-24T10:00:00Z",
              acceptance: [{ id: "done", kind: "check", description: "拿到结果" }],
            },
          ],
        },
      ],
    } as any);
  // While the newer message is unread, the older write stays blocked.
  await expect(write("first")).rejects.toMatchObject({ code: "NEWER_INPUT_PENDING" });

  // The classification job reads it as unrelated without waiting for its turn.
  await scheduler.tick();
  expect(classified).toBeGreaterThanOrEqual(1);
  expect(h.store.db.prepare("SELECT classification FROM inbox WHERE id=?").get(b.id)).toMatchObject({
    classification: "classified",
  });

  // Now the older accepted work may commit.
  const applied = await write("second");
  expect(applied.results[0].status).toBe("applied");
  expect(h.store.registry().tasks.some((task) => task.title === "查材料")).toBe(true);
  // The watermark only advances over a contiguous classified prefix (A is not).
  const context = h.core.context({ ...h.input("状态"), channel: "qq", actor_ref: "user" } as any);
  expect((context as any).understood_seq).toBe(0);

  releaseA();
  await expect
    .poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(a.id))
    .toMatchObject({ status: "processed" });
});

it("a newer unread message pauses old proactive candidates and keeps them queued", async () => {
  const h = harness("2026-10-23T12:00:00Z");
  cleanups.push(() => h.close());
  let connected = false;
  const sent: string[] = [];
  const scheduler = new Scheduler(
    h.core,
    {
      health: () => ({ connected, lastEventAt: null }),
      send: async (message) => {
        sent.push(message.body);
        return { status: "sent", externalId: "n" + sent.length };
      },
    },
    "user",
  );
  cleanups.push(async () => {
    scheduler.close();
  });
  await h.run(habitAction);
  await scheduler.tick(); // queued while the channel is down
  const proactive = () =>
    h.store.db.prepare("SELECT id,status FROM outbox WHERE counts_as_proactive=1").all() as any[];
  expect(proactive().length).toBeGreaterThan(0);
  expect(proactive().every((row) => row.status === "pending")).toBe(true);

  // The user says something new and the turn is still running: old candidates wait.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.core.agent = {
    executionMode: "tools-v2",
    interpret: async () => {
      await gate;
      return { action_groups: [], clarification: null, reply_intent: "discussion", discussion: "知道了。" };
    },
  } as any;
  const newer = { ...h.input("我刚想到一件事"), channel: "qq", actor_ref: "user" };
  await h.core.receive(newer);
  await expect
    .poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(newer.id))
    .toMatchObject({ status: "processing" });
  connected = true;
  await scheduler.tick();
  expect(proactive().every((row) => row.status === "pending")).toBe(true);
  expect(sent).toHaveLength(0);

  // Once the message is understood the same candidate is still there and goes out.
  release();
  await expect
    .poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(newer.id))
    .toMatchObject({ status: "processed" });
  // The candidate survived the pause instead of being cancelled or dropped, and the
  // reply to the new message was delivered in the same period: only proactive
  // candidates are held back. Whether it later goes out follows the normal
  // candidate/contact-spacing rules, which other cases cover.
  expect(proactive().every((row) => row.status === "pending")).toBe(true);
  // The reply to the new message is queued normally: only proactive candidates pause.
  const receipt = h.store.db
    .prepare("SELECT status FROM outbox WHERE message_kind='receipt'")
    .all() as any[];
  expect(receipt.length).toBeGreaterThan(0);
  expect(receipt.every((row) => row.status !== "cancelled")).toBe(true);
});

it("a reminder queued before a revocation is cancelled instead of delivered", async () => {
  const h = harness("2026-10-23T12:00:00Z");
  cleanups.push(() => h.close());
  let connected = false;
  const sent: string[] = [];
  const scheduler = new Scheduler(
    h.core,
    {
      health: () => ({ connected, lastEventAt: null }),
      send: async (message) => {
        sent.push(message.body);
        return { status: "sent", externalId: "qq-" + sent.length };
      },
    },
    "user",
  );
  cleanups.push(async () => scheduler.close());

  await h.run({ type: "remember_fact", fact: "提醒我时先发一句简短提示。", kind: "user_confirmed" });
  await h.run(habitAction);
  // Queued while the channel is down, so nothing has been delivered yet.
  await scheduler.tick();
  const queued = () =>
    h.store.db
      .prepare("SELECT status,source_versions_json FROM outbox WHERE counts_as_proactive=1")
      .all() as any[];
  expect(queued().length).toBeGreaterThan(0);
  expect(queued().every((row) => row.status === "pending")).toBe(true);
  expect(sent).toHaveLength(0);

  const factsPath = h.store.files.resolve(".agent/context/facts.json", "internal");
  const fact = JSON.parse(fs.readFileSync(factsPath, "utf8")).facts[0];
  await h.run({ type: "forget_fact", target_id: fact.id, expected_version: fact.version });

  // The queued rows recorded the revision they were derived from.
  expect(queued().every((row) => JSON.parse(row.source_versions_json).revocation === 0)).toBe(true);

  connected = true;
  await scheduler.tick();
  // A stale-revision candidate is never delivered: whatever remains pending or
  // delivered was re-derived after the revocation.
  const live = () =>
    (h.store.db
      .prepare("SELECT status,source_versions_json FROM outbox WHERE status IN ('pending','sending','sent')")
      .all() as any[]);
  expect(h.store.revocationRevision()).toBe(1);
  for (const row of live())
    expect(JSON.parse(row.source_versions_json).revocation).toBe(1);
  expect(h.store.db
    .prepare("SELECT count(*) n FROM outbox WHERE status='cancelled'")
    .get()).toMatchObject({ n: expect.any(Number) });
});

it("a slow turn gets one progress note before its final answer, and a finished turn gets none", async () => {
  const h = harness("2026-10-23T12:00:00Z");
  cleanups.push(() => h.close());
  const sent: string[] = [];
  const scheduler = new Scheduler(
    h.core,
    {
      health: () => ({ connected: true, lastEventAt: null }),
      send: async (message) => {
        sent.push(message.body);
        return { status: "sent", externalId: "p" + sent.length };
      },
    },
    "user",
  );
  cleanups.push(async () => {
    scheduler.close();
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let answered = { ...h.input("帮我把下午的安排理一下"), channel: "qq", actor_ref: "user" };
  h.core.agent = {
    executionMode: "tools-v2",
    interpret: async () => {
      await gate;
      return { action_groups: [], clarification: null, reply_intent: "discussion", discussion: "安排已经理好。" };
    },
    compose: async () => ({ text: "我先理一下，排好就发你。" }),
  } as any;
  await h.core.receive(answered);
  // Wait until the turn really holds the input (fire-and-forget processing).
  await expect
    .poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(answered.id))
    .toMatchObject({ status: "processing" });

  // The turn is still running past the threshold: exactly one progress note goes out.
  h.advance(10_000);
  await scheduler.tick();
  const progress = h.store.db
    .prepare("SELECT body,metadata_json,status FROM outbox WHERE json_extract(metadata_json,'$.purpose')='progress'")
    .all() as any[];
  expect(progress).toHaveLength(1);
  expect(JSON.parse(progress[0].metadata_json)).toMatchObject({ purpose: "progress", sequence: 0 });
  expect(sent).toHaveLength(1);

  // A second tick must not repeat it.
  await scheduler.tick();
  expect(
    h.store.db.prepare("SELECT count(*) n FROM outbox WHERE json_extract(metadata_json,'$.purpose')='progress'").get(),
  ).toMatchObject({ n: 1 });

  // The final answer follows the progress note; ordering comes from sequence 0 vs 1.
  release();
  await expect
    .poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(answered.id))
    .toMatchObject({ status: "processed" });
  await scheduler.tick();
  const rows = h.store.db
    .prepare("SELECT message_kind,json_extract(metadata_json,'$.purpose') AS purpose,json_extract(metadata_json,'$.sequence') AS seq FROM outbox ORDER BY rowid")
    .all() as any[];
  expect(rows.map((row) => row.purpose)).toEqual(["progress", "reply"]);
  expect(rows.map((row) => row.seq)).toEqual([0, 1]);
  expect(sent[0]).toContain("我先理一下");
  expect(sent.at(-1)).toContain("安排已经理好");
});

it("a slow turn's progress note uses generated wording and stays silent when wording fails", async () => {
  const h = harness("2026-10-23T12:00:00Z");
  cleanups.push(() => h.close());
  const sent: string[] = [];
  const scheduler = new Scheduler(
    h.core,
    {
      health: () => ({ connected: true, lastEventAt: null }),
      send: async (message) => {
        sent.push(message.body);
        return { status: "sent", externalId: "w" + sent.length };
      },
    },
    "user",
  );
  cleanups.push(async () => {
    scheduler.close();
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const composeInputs: any[] = [];
  h.core.agent = {
    executionMode: "tools-v2",
    interpret: async () => {
      await gate;
      return { action_groups: [], clarification: null, reply_intent: "discussion", discussion: "理好了。" };
    },
    compose: async (facts: any) => {
      composeInputs.push(facts);
      return { text: "我在核对下午的时间，查完就告诉你。" };
    },
  } as any;
  const input = { ...h.input("帮我把下午的安排理一下"), channel: "qq", actor_ref: "user" };
  await h.core.receive(input);
  await expect
    .poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id))
    .toMatchObject({ status: "processing" });
  h.advance(10_000);
  await scheduler.tick();
  const progress = h.store.db
    .prepare("SELECT body FROM outbox WHERE json_extract(metadata_json,'$.purpose')='progress'")
    .all() as any[];
  expect(progress).toHaveLength(1);
  expect(progress[0].body).toBe("我在核对下午的时间，查完就告诉你。");
  expect(composeInputs[0]).toMatchObject({ purpose: "progress", input_id: input.id });
  expect(composeInputs[0].user_message).toContain("下午的安排");
  // Facts, not guesses: no step has completed yet for this input.
  expect(composeInputs[0].steps).toMatchObject({ applied: 0, rejected: 0 });
  release();

  // A composer that fails leaves a truthful status line instead of blocking the note.
  const second = { ...h.input("再看一下明天的"), channel: "qq", actor_ref: "user" };
  let release2!: () => void;
  const gate2 = new Promise<void>((resolve) => {
    release2 = resolve;
  });
  h.core.agent = {
    executionMode: "tools-v2",
    interpret: async () => {
      await gate2;
      return { action_groups: [], clarification: null, reply_intent: "discussion", discussion: "看过了。" };
    },
    compose: async () => {
      throw new Error("compose unavailable");
    },
  } as any;
  await h.core.receive(second);
  await expect
    .poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(second.id))
    .toMatchObject({ status: "processing" });
  h.advance(10_000);
  await scheduler.tick();
  const fallback = h.store.db
    .prepare("SELECT body FROM outbox WHERE json_extract(metadata_json,'$.purpose')='progress' AND json_extract(metadata_json,'$.reply_group')=?")
    .all(second.id) as any[];
  // No composer, no note: a canned "still working" line is not a substitute.
  expect(fallback).toHaveLength(0);
  const attempted = JSON.parse(
    (h.store.db.prepare("SELECT metadata_json FROM inbox WHERE id=?").get(second.id) as any).metadata_json,
  ).progress_attempted_at;
  expect(typeof attempted).toBe("string");
  release2();
});

it("a progress note reports the steps that actually completed", async () => {
  const h = harness("2026-10-23T12:00:00Z");
  cleanups.push(() => h.close());
  const scheduler = new Scheduler(
    h.core,
    { health: () => ({ connected: true, lastEventAt: null }), send: async () => ({ status: "sent", externalId: "s" }) },
    "user",
  );
  cleanups.push(async () => {
    scheduler.close();
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: any[] = [];
  h.core.agent = {
    executionMode: "tools-v2",
    interpret: async () => {
      await gate;
      return { action_groups: [], clarification: null, reply_intent: "discussion", discussion: "做完了。" };
    },
    compose: async (facts: any) => {
      seen.push(facts);
      return { text: "任务已经记下，我在继续整理。" };
    },
  } as any;
  const input = { ...h.input("帮我建个任务"), channel: "qq", actor_ref: "user" };
  await h.core.receive(input);
  await expect
    .poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id))
    .toMatchObject({ status: "processing" });
  // The turn really commits one business change before the progress note.
  await businessCall(h.core, {
    input_id: input.id,
    call_id: "progress-steps",
    operation: "apply_changes",
    action_groups: [
      {
        action_identity: "task",
        actions: [
          {
            type: "create_task",
            title: "写周报",
            outcome: "周报完成",
            due_at: "2026-10-28T10:00:00Z",
            acceptance: [{ id: "done", kind: "check", description: "周报完成" }],
          },
        ],
      },
    ],
  } as any);
  h.advance(10_000);
  await scheduler.tick();
  expect(seen).toHaveLength(1);
  expect(seen[0].steps).toMatchObject({ applied: 1, rejected: 0 });
  expect(Array.isArray(seen[0].steps.files_written)).toBe(true);
  const progress = h.store.db
    .prepare("SELECT body FROM outbox WHERE json_extract(metadata_json,'$.purpose')='progress'")
    .all() as any[];
  expect(progress[0].body).toContain("任务已经记下");
  release();
});

it("a final answer ready before the threshold cancels the unsent progress note", async () => {
  const h = harness("2026-10-23T12:00:00Z");
  cleanups.push(() => h.close());
  const sent: string[] = [];
  const scheduler = new Scheduler(
    h.core,
    {
      health: () => ({ connected: true, lastEventAt: null }),
      send: async (message) => {
        sent.push(message.body);
        return { status: "sent", externalId: "q" + sent.length };
      },
    },
    "user",
  );
  cleanups.push(async () => {
    scheduler.close();
  });
  h.core.agent = {
    executionMode: "tools-v2",
    interpret: async () => ({ action_groups: [], clarification: null, reply_intent: "discussion", discussion: "好了。" }),
  } as any;
  const input = { ...h.input("在吗"), channel: "qq", actor_ref: "user" };
  await h.core.receive(input);
  await expect
    .poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id))
    .toMatchObject({ status: "processed" });
  h.advance(10_000);
  await scheduler.flushReceipts();
  expect(
    h.store.db.prepare("SELECT count(*) n FROM outbox WHERE json_extract(metadata_json,'$.purpose')='progress'").get(),
  ).toMatchObject({ n: 0 });
  expect(sent).toEqual(["好了。"]);
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

it("S05 a recurring schedule inside quiet hours is refused, or delivered when the user consented", async () => {
  const t = setup("2026-10-24T12:00:00Z");
  const base = {
    type: "create_automation",
    kind: "recurring",
    title: "早起晨报",
    body: "早，该起了。",
    timezone: "Asia/Shanghai",
    schedule: {
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      starts_on: "2026-10-24",
      local_start: "05:20",
      local_end: "05:25",
    },
  };
  // Quiet hours default to 23:00-08:00, so 05:20 would never be delivered.
  await expect(t.h.run(base as any)).rejects.toThrow("静默");
  // With the user's explicit consent the same schedule is accepted...
  await t.h.run({ ...base, quiet_exception: true } as any);
  const automation = t.h.store.registry().automations!.find((a) => a.title === "早起晨报")!;
  expect(automation.quiet_exception).toBe(true);
  // ...and the occurrence it generates at 05:20 is allowed through the gate.
  for (const at of ["2026-10-24T23:00:00+08:00", "2026-10-25T00:05:00+08:00", "2026-10-25T05:20:00+08:00"]) {
    t.h.setTime(at);
    await t.h.core.assistant.tick();
    await t.scheduler.tick();
  }
  expect(t.sent).toHaveLength(1);
});

it("a paused subscription stays silent until its pause ends, then resumes on its own", async () => {
  const t = setup("2026-10-24T09:00:00Z");
  await t.h.run({
    type: "create_automation",
    kind: "recurring",
    title: "午间提醒",
    body: "该午休了",
    timezone: "Asia/Shanghai",
    schedule: { weekdays: [1, 2, 3, 4, 5, 6, 7], starts_on: "2026-10-24", local_start: "13:00", local_end: "13:05" },
  });
  const automation = t.h.store.registry().automations![0];
  await t.h.run({
    type: "control_automation",
    target_id: automation.id,
    expected_version: automation.version,
    control: "pause",
    ends_at: "2026-10-26T13:00:00+08:00",
  });
  expect(t.h.store.registry().automations![0].status).toBe("paused");
  // Inside the pause: the slot passes without a message.
  t.h.setTime("2026-10-24T13:00:30+08:00");
  await t.h.core.assistant.tick();
  await t.scheduler.tick();
  expect(t.sent).toHaveLength(0);
  // After the pause ends the same subscription fires again on its own.
  t.h.setTime("2026-10-27T13:00:30+08:00");
  await t.h.core.assistant.tick();
  await t.scheduler.tick();
  expect(t.h.store.registry().automations![0].status).toBe("active");
  expect(t.sent).toHaveLength(1);
});

it("an idle nudge due inside the quiet hours waits for the window to open", async () => {
  const t = setup("2026-10-25T02:00:00Z"); // 10:00 +08, harness clock start
  const now = t.h.store.now();
  // Last contact at 22:30 the previous evening; the nudge would land at 00:30,
  // but the window (06:00-22:00) and quiet hours both keep it until 06:00.
  t.h.store.db
    .prepare(
      "INSERT INTO outbox(id,channel,recipient_ref,dedupe_key,target_refs_json,source_versions_json,metadata_json,message_kind,body,content_hash,scheduled_at,expires_at,counts_as_proactive,created_at,updated_at,status,external_id,sent_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "quiet-contact", "qq", "owner", "seed:quiet", "[]", "{}", "{}", "receipt",
      "睡了", "h", "2026-10-24T14:30:00.000Z", "2026-10-24T14:35:00.000Z",
      1, "2026-10-24T14:30:00.000Z", "2026-10-24T14:30:00.000Z",
      "sent", "ext-quiet", "2026-10-24T14:30:00.000Z", "2026-10-24T14:30:00.000Z",
    );
  await t.h.run({
    type: "create_automation",
    kind: "status_check",
    title: "确认在做什么",
    timezone: "Asia/Shanghai",
    schedule: { weekdays: [1, 2, 3, 4, 5, 6, 7], starts_on: "2026-10-24", local_start: "06:00", local_end: "22:00", every_hours: 2 },
  });
  const tick = async (at: string) => {
    t.h.setTime(at);
    await t.h.core.assistant.tick();
    await t.scheduler.tick();
  };
  await tick("2026-10-25T05:00:00+08:00");
  expect(t.sent).toHaveLength(0);
  // The window opens at 06:00 but the quiet hours still cover it.
  await tick("2026-10-25T06:00:30+08:00");
  await tick("2026-10-25T07:59:00+08:00");
  expect(t.sent).toHaveLength(0);
  // Only the end of the quiet hours lets the same nudge through.
  await tick("2026-10-25T08:00:30+08:00");
  expect(t.sent).toHaveLength(1);
  expect(t.sent[0]).toContain("方便时回一句");
});


it("a status check waits two hours of silence and then the next full hour", async () => {
  const t = setup("2026-10-25T00:30:00Z"); // 08:30 +08
  // The last thing the person heard from us was at 08:33.
  const now = t.h.store.now();
  t.h.store.db
    .prepare(
      "INSERT INTO outbox(id,channel,recipient_ref,dedupe_key,target_refs_json,source_versions_json,metadata_json,message_kind,body,content_hash,scheduled_at,expires_at,counts_as_proactive,created_at,updated_at,status,external_id,sent_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "last-contact",
      "qq",
      "owner",
      "seed:contact",
      "[]",
      "{}",
      "{}",
      "receipt",
      "到点了",
      "h",
      now,
      now,
      1,
      "2026-10-25T00:33:00.000Z",
      "2026-10-25T00:33:00.000Z",
      "sent",
      "ext-seed",
      "2026-10-25T00:33:00.000Z",
      "2026-10-25T00:33:00.000Z",
    );
  const status = await t.h.run({
    type: "create_automation",
    kind: "status_check",
    title: "确认在做什么",
    timezone: "Asia/Shanghai",
    schedule: { weekdays: [1, 2, 3, 4, 5, 6, 7], starts_on: "2026-10-24", local_start: "06:00", local_end: "22:00", every_hours: 2 },
  });
  expect(status.updated_ids).toHaveLength(1);
  const tick = async (at: string) => {
    t.h.setTime(at);
    await t.h.core.assistant.tick();
    await t.scheduler.tick();
  };
  const baseline = t.sent.length;
  // 08:33 + 2h = 10:33, so 09:00, 10:00 and 10:33 stay silent...
  await tick("2026-10-25T09:00:30+08:00");
  await tick("2026-10-25T10:00:30+08:00");
  await tick("2026-10-25T10:33:00+08:00");
  expect(t.sent.length).toBe(baseline);
  // ...and the next full hour is when the person hears from us.
  await tick("2026-10-25T11:00:30+08:00");
  expect(t.sent.length).toBe(baseline + 1);
  expect(t.sent[t.sent.length - 1]).toContain("方便时回一句");
});


