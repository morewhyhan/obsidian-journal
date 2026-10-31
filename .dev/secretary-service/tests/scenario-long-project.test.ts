import fs from "node:fs";
import { afterEach, expect, it } from "vitest";
import { harness, habitAction } from "./helpers.js";
import { Scheduler, type Channel } from "../apps/core/scheduler.js";
import { businessCall } from "../apps/core/agent-runtime.js";
import { ruleValue } from "../packages/domain/assistant.js";
import { cleanup } from "../apps/core/maintenance.js";
import { atomicWrite } from "../apps/core/files.js";
import path from "node:path";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const h = harness("2026-10-24T09:00:00Z");
  cleanups.push(() => h.close());
  return h;
}

function task(h: ReturnType<typeof setup>, title: string) {
  const found = h.store.registry().tasks.find((entry) => entry.title === title);
  if (!found) throw new Error("missing task " + title);
  return found;
}

it("S6a a phase completion never re-creates or completes the accepted goal", async () => {
  const h = setup();
  const acceptance = [{ id: "deliver", kind: "check", description: "最终交付通过验收" }];
  await h.run({
    type: "create_task",
    title: "长期项目",
    outcome: "三个阶段都交付并通过验收",
    acceptance,
  });
  for (const title of ["阶段一", "阶段二", "阶段三"])
    await h.run({
      type: "create_task",
      title,
      outcome: title + "交付完成",
      acceptance: [{ id: "phase", kind: "check", description: title + "完成" }],
      parent_task_id: task(h, "长期项目").id,
    });
  const goal = task(h, "长期项目");
  expect(h.store.registry().tasks).toHaveLength(4);

  // A material check the assistant still owes, with a condition that only the
  // file's arrival can satisfy.
  await h.run({
    type: "save_work",
    work: {
      key: "material-check",
      summary: "核实材料是否可用",
      owner: "assistant",
      next_action: "读 03. Manual/材料.md",
      refs: [{ kind: "note", path: "03. Manual/材料.md", role: "input" }],
      done_when: {
        kind: "condition_observed",
        ref: { kind: "note", path: "03. Manual/材料.md", role: "input" },
        checker: "note_available",
      },
    },
  });
  const works = (state: any) =>
    (state.followups ?? []).filter(
      (entry: any) => String(entry.id).startsWith("work:") && entry.work?.key === "material-check",
    );
  const first = works(h.store.registry())[0];

  h.advance(7 * DAY);
  const phase1 = task(h, "阶段一");
  await h.run({ type: "complete_task", target_id: phase1.id, expected_version: phase1.version });

  const after = h.store.registry();
  expect(after.tasks.filter((entry) => entry.title === "长期项目")).toHaveLength(1);
  expect(
    task(h, "长期项目").acceptance.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      description: entry.description,
    })),
  ).toEqual(acceptance.map(({ id, kind, description }) => ({ id, kind, description })));
  expect(task(h, "长期项目").status).not.toBe("done");
  expect(task(h, "阶段一").status).toBe("done");
  // Waiting on a condition is not a reason to spawn more work or to re-open the goal.
  expect(after.tasks).toHaveLength(4);
  expect(works(after)).toHaveLength(1);
  expect(works(after)[0].id).toBe(first.id);
  expect(works(after)[0].status).toBe(first.status);
});

it("S6b fourteen silent days produce no backlog and no invented failure", async () => {
  const h = harness("2026-10-24T09:00:00Z");
  cleanups.push(() => h.close());
  const sent: { body: string; at: string }[] = [];
  const channel: Channel = {
    health: () => ({ connected: true, lastEventAt: null }),
    send: async (message) => {
      sent.push({ body: message.body, at: h.store.now() });
      return { status: "sent", externalId: "qq-" + sent.length };
    },
  };
  const scheduler = new Scheduler(h.core, channel, "user");
  await h.run(habitAction);
  await h.run({
    type: "create_task",
    title: "已放弃的事",
    outcome: "不再做",
    acceptance: [{ id: "c", kind: "check", description: "完成" }],
  });
  await h.run({
    type: "create_task",
    title: "仍有效的事",
    outcome: "继续推进",
    acceptance: [{ id: "c", kind: "check", description: "完成" }],
  });
  const dropped = h.store.registry().tasks.find((entry) => entry.title === "已放弃的事")!;
  await h.run({ type: "cancel_item", target_id: dropped.id, expected_version: dropped.version });

  // The user goes away: only the clock moves for two weeks.
  for (let day = 0; day < 14; day++) {
    for (const hour of [6, 12, 18, 21]) {
      h.advance(6 * 60 * 60 * 1000);
      await scheduler.tick();
    }
  }
  const outbox = h.store.db.prepare("SELECT status, count(*) n FROM outbox GROUP BY status").all() as any[];
  expect(outbox.filter((row) => ["pending", "failed", "unknown"].includes(row.status))).toEqual([]);
  // Silence is not failure and not completion.
  const tasks = h.store.registry().tasks;
  expect(tasks.find((entry) => entry.title === "仍有效的事")!.status).not.toBe("done");
  expect(h.store.db.prepare("SELECT count(*) n FROM inbox WHERE status='failed'").get()).toMatchObject({ n: 0 });
  // Nothing is sent twice with the same body on the same local day.
  const seen = new Set<string>();
  for (const message of sent) {
    const key = message.at.slice(0, 10) + "|" + message.body;
    expect(seen.has(key)).toBe(false);
    seen.add(key);
  }
});

it("S6c the day a user returns, the context describes only what is still valid", async () => {
  const h = harness("2026-10-24T09:00:00Z");
  cleanups.push(() => h.close());
  await h.run({
    type: "create_task",
    title: "已放弃的事",
    outcome: "不再做",
    acceptance: [{ id: "c", kind: "check", description: "完成" }],
  });
  await h.run({
    type: "create_task",
    title: "仍有效的事",
    outcome: "继续推进",
    acceptance: [{ id: "c", kind: "check", description: "完成" }],
  });
  const dropped = h.store.registry().tasks.find((entry) => entry.title === "已放弃的事")!;
  await h.run({ type: "cancel_item", target_id: dropped.id, expected_version: dropped.version });
  h.advance(14 * DAY);
  let seenContext: any = null;
  h.core.agent = {
    executionMode: "tools-v2",
    interpret: async (_input: any, context: any) => {
      seenContext = context;
      return { action_groups: [], clarification: null, reply_intent: "discussion", discussion: "现在仍然有效的只有继续推进这件事。" };
    },
  } as any;
  const input = { ...h.input("我回来了，现在还有什么有效的？"), channel: "qq", actor_ref: "user" };
  await h.core.receive(input);
  await expect
    .poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id))
    .toMatchObject({ status: "processed" });
  const items = JSON.stringify(seenContext?.items ?? []);
  expect(items).toContain("仍有效的事");
  expect(items).not.toContain("已放弃的事");
});

it("S6d a day exception expires into the newer long-term rule, never the original", async () => {
  const h = harness("2026-10-24T09:00:00Z");
  cleanups.push(() => h.close());
  const key = "contact.style";
  await h.run({
    type: "set_personal_rule",
    key,
    value: "只在早晚各一次",
    starts_at: h.store.now(),
    expected_rules_revision: (h.store.registry().rules_revision ?? 0),
  });
  const now = () => h.store.now();
  expect(ruleValue(h.store.registry(), key, "unset", now())).toBe("只在早晚各一次");

  h.advance(6 * DAY);
  await h.run({
    type: "set_personal_rule",
    key,
    value: "白天也可以提醒我",
    starts_at: now(),
    expected_rules_revision: (h.store.registry().rules_revision ?? 0),
  });
  const exceptionStart = now();
  const exceptionEnd = new Date(Date.parse(exceptionStart) + DAY).toISOString();
  await h.run({
    type: "set_personal_rule",
    key,
    value: "今天别联系我",
    starts_at: exceptionStart,
    ends_at: exceptionEnd,
    expected_rules_revision: (h.store.registry().rules_revision ?? 0),
  });

  // On the exception day only the exception is effective.
  expect(ruleValue(h.store.registry(), key, "unset", now())).toBe("今天别联系我");
  // The exception expires: the newer long-term rule takes over.
  h.advance(DAY + 60 * 60 * 1000);
  expect(ruleValue(h.store.registry(), key, "unset", now())).toBe("白天也可以提醒我");
  expect(ruleValue(h.store.registry(), key, "unset", now())).not.toBe("只在早晚各一次");
  // Expired rows stay as history, they are not enabled effective rules.
  const effective = (h.store.registry().user_rules ?? []).filter(
    (rule) => rule.key === key && rule.enabled && rule.starts_at <= now() && (!rule.ends_at || rule.ends_at > now()),
  );
  expect(effective.length).toBeGreaterThanOrEqual(1);
  // Version history is kept (no destructive overwrite) and the undo path walks
  // back to the previous long-term version rather than to the exception.
  const newer = (h.store.registry().user_rules ?? []).find((rule) => rule.value === "白天也可以提醒我")!;
  await h.run({
    type: "undo_rule",
    target_id: newer.id,
    expected_version: newer.version,
    expected_rules_revision: (h.store.registry().rules_revision ?? 0),
  });
  expect(ruleValue(h.store.registry(), key, "unset", now())).toBe("只在早晚各一次");
});

it("S6e cleanup drops old messages but keeps the evidence an active Work needs", async () => {
  const h = harness("2026-10-24T09:00:00Z");
  cleanups.push(() => h.close());
  const note = "03. Manual/材料.md";
  h.core.agent = {
    executionMode: "tools-v2",
    interpret: async () => ({ action_groups: [], clarification: null, reply_intent: "discussion", discussion: "记下了。" }),
  } as any;
  await h.run({
    type: "save_work",
    work: {
      key: "material-check",
      summary: "核实材料是否可用",
      owner: "assistant",
      next_action: "读 03. Manual/材料.md",
      refs: [{ kind: "note", path: note, role: "input" }],
      done_when: {
        kind: "condition_observed",
        ref: { kind: "note", path: note, role: "input" },
        checker: "note_available",
      },
    },
  });
  const input = { ...h.input("旧的一段对话"), channel: "qq", actor_ref: "user" };
  await h.core.receive(input);
  await expect
    .poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id))
    .toMatchObject({ status: "processed" });
  expect((h.store.db.prepare("SELECT count(*) n FROM outbox").get() as any).n).toBeGreaterThan(0);

  h.advance(400 * DAY);
  cleanup(h.store);

  // Short-term history is gone...
  expect(h.store.db.prepare("SELECT count(*) n FROM inbox WHERE id=?").get(input.id)).toMatchObject({ n: 0 });
  // ...but the accepted responsibility and the note it depends on survive.
  const works = (h.store.registry().followups ?? []).filter(
    (entry: any) => String(entry.id).startsWith("work:") && entry.work?.key === "material-check",
  );
  expect(works).toHaveLength(1);
  // The waiting condition still points at the same path: cleanup must not erase
  // the evidence an accepted responsibility depends on.
  expect(JSON.stringify(works[0]!.work!.refs)).toContain(note);
  expect(JSON.stringify(works[0]!.work!.done_when)).toContain(note);
});

it("S6f after a restart the arriving material resolves the waiting work exactly once", async () => {
  const h = harness("2026-10-24T09:00:00Z");
  cleanups.push(() => h.close());
  const note = "03. Manual/材料.md";
  await h.run({
    type: "save_work",
    work: {
      key: "material-check",
      summary: "核实材料是否可用",
      owner: "assistant",
      next_action: "读 03. Manual/材料.md",
      refs: [{ kind: "note", path: note, role: "input" }],
      done_when: {
        kind: "condition_observed",
        ref: { kind: "note", path: note, role: "input" },
        checker: "note_available",
      },
    },
  });
  const workState = () =>
    (h.store.registry().followups ?? []).filter(
      (entry: any) => String(entry.id).startsWith("work:") && entry.work?.key === "material-check",
    );
  expect(workState()).toHaveLength(1);
  expect(workState()[0].status).toBe("open");

  // Upgrade + restart while the condition is still unmet.
  h.advance(45 * DAY);
  await h.restart();
  expect(workState()).toHaveLength(1);
  expect(workState()[0].status).toBe("open");

  // The material arrives and a real commit runs the reconciliation pass.
  atomicWrite(path.join(h.root, note), "材料正文：可读且非空。");
  await h.run({
    type: "create_task",
    title: "材料到了以后开始整理",
    outcome: "整完成",
    acceptance: [{ id: "c", kind: "check", description: "整理完成" }],
  });
  await expect.poll(() => workState().map((entry: any) => entry.status)).not.toContain("open");
  const settled = workState();
  expect(settled).toHaveLength(1);
  expect(JSON.stringify(settled[0])).toContain("resolved");

  // A repeated trigger must not open a second work for the same key.
  await h.run({
    type: "create_task",
    title: "重复触发",
    outcome: "不应重复建工作",
    acceptance: [{ id: "c", kind: "check", description: "完成" }],
  });
  expect(workState()).toHaveLength(1);
});

it("S6g a moved material is not reported as verified, and the finish line closes the project", async () => {
  const h = harness("2026-10-24T09:00:00Z");
  cleanups.push(() => h.close());
  const first = "03. Manual/材料.md";
  const moved = "03. Manual/归档/材料.md";
  await h.run({
    type: "create_task",
    title: "长期项目",
    outcome: "交付通过验收",
    acceptance: [{ id: "deliver", kind: "check", description: "最终交付通过验收" }],
  });
  await h.run({
    type: "save_work",
    work: {
      key: "material-check",
      summary: "核实材料是否可用",
      owner: "assistant",
      next_action: "读 " + first,
      refs: [
        { kind: "note", path: first, role: "input" },
        { kind: "task", id: h.store.registry().tasks.find((entry) => entry.title === "长期项目")!.id, role: "output" },
      ],
      done_when: {
        kind: "condition_observed",
        ref: { kind: "note", path: first, role: "input" },
        checker: "note_available",
      },
    },
  });
  const works = () =>
    (h.store.registry().followups ?? []).filter(
      (entry: any) => String(entry.id).startsWith("work:") && entry.work?.key === "material-check",
    );
  // The material appears and is filed elsewhere before any commit observes it:
  // the accepted condition names the original path, which never exists.
  atomicWrite(path.join(h.root, moved), "材料正文：可读。");
  fs.rmSync(path.join(h.root, first), { force: true });
  await h.run({
    type: "create_task",
    title: "路径变化后的触发",
    outcome: "触发一次协调",
    acceptance: [{ id: "c", kind: "check", description: "完成" }],
  });
  expect(works().map((entry: any) => entry.status)).toContain("open");
  // Retrieval still finds the content at its new place.
  expect(h.store.files.search([moved], "材料正文").map((hit) => hit.path)).toEqual([moved]);

  // Day 90: the goal is delivered and closed.
  const goal = h.store.registry().tasks.find((entry) => entry.title === "长期项目")!;
  h.advance(45 * DAY);
  await h.run({ type: "complete_task", target_id: goal.id, expected_version: goal.version });
  const finished = h.store.registry();
  expect(finished.tasks.find((entry) => entry.title === "长期项目")!.status).toBe("done");
  const pendingOut = h.store.db.prepare("SELECT count(*) n FROM outbox WHERE status='pending'").get() as any;
  expect(pendingOut.n).toBe(0);

  // Time keeps moving: a finished project must not revive itself.
  for (let day = 0; day < 5; day++) h.advance(DAY);
  const later = h.store.registry();
  expect(later.tasks.find((entry) => entry.title === "长期项目")!.status).toBe("done");
  expect(
    (later.followups ?? []).filter((entry: any) => String(entry.id).startsWith("work:") && entry.status === "open"),
  ).toHaveLength(0);
});
