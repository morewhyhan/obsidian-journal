import { afterEach, expect, it } from "vitest";
import { harness, taskAction } from "./helpers.js";
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
async function setup() {
  const h = harness("2026-10-25T01:00:00Z");
  closers.push(() => h.close());
  await h.run({
    type: "set_planning",
    preferences: {
      availability: [
        { weekdays: [1, 2, 3, 4, 5, 6, 7], start: "10:00", end: "17:00" },
      ],
    },
  });
  const target = (
    await h.run({
      ...taskAction,
      due_at: null,
      planning: { next_action: "整理全部资料", remaining_minutes: 30 },
    })
  ).updated_ids[0];
  for (let i = 0; i < 3; i++) {
    h.advance(60000);
    await h.run({
      type: "report_execution",
      target_id: target,
      execution: "not_started",
    });
  }
  await h.core.coordinator.tick();
  expect(
    h.store
      .registry()
      .followups?.some(
        (f) => f.issue.task_id === target && f.issue.kind === "activation",
      ),
  ).toBe(true);
  return { h, target };
}
it("C01/C02/D08 actual autonomous support prepares one step, preserves the promise, and does not run again on identical evidence", async () => {
  const { h, target } = await setup();
  const before = structuredClone(
    h.store.registry().tasks.find((t) => t.id === target)!,
  );
  let calls = 0;
  h.core.agent = {
    interpret: async (_input, context: any) => {
      calls++;
      expect(context.followup.issue.task_id).toBe(target);
      return {
        action_groups: [
          {
            action_identity: "prepare",
            actions: [
              {
                type: "configure_task",
                target_id: target,
                expected_version: context.task.version,
                planning: { next_action: "打开资料目录，只看第一个文件" },
              },
            ],
          },
        ],
        clarification: null,
        reply_intent: "discussion",
        discussion:
          "三次都还没开始。下一步先打开资料目录，只看第一个文件，原来的交付要求保留。",
      };
    },
  };
  h.core.assistant.startPlanning();
  await h.core.assistant.drain();
  const after = h.store.registry().tasks.find((t) => t.id === target)!;
  expect(after.planning?.next_action).toBe("打开资料目录，只看第一个文件");
  expect(after.acceptance).toEqual(before.acceptance);
  expect(after.outcome).toBe(before.outcome);
  expect(after.status).not.toBe("done");
  expect(
    h.store.registry().followups?.some((f) => f.analysis?.status === "done"),
  ).toBe(true);
  h.core.assistant.startPlanning();
  await h.core.assistant.drain();
  expect(calls).toBe(1);
});

it("D03/G02 an autonomous recommendation changing the requirement remains a real pending proposal", async () => {
  const { h, target } = await setup();
  const before = structuredClone(
    h.store.registry().tasks.find((t) => t.id === target)!,
  );
  h.core.agent = {
    interpret: async (_input, context: any) => ({
      action_groups: [
        {
          action_identity: "choice",
          actions: [
            {
              type: "configure_task",
              target_id: target,
              expected_version: context.task.version,
              planning: {
                remaining_minutes: 10,
                next_action: "先整理一项资料",
              },
            },
          ],
        },
      ],
      clarification: "建议先给这件事十分钟试做，原成果保留，可以吗？",
      reply_intent: "clarification",
      discussion: "原办法连续三次没启动，建议先缩小这次安排。",
    }),
  };
  h.core.assistant.startPlanning();
  await h.core.assistant.drain();
  expect(
    h.store.registry().tasks.find((t) => t.id === target)?.planning
      ?.remaining_minutes,
  ).toBe(before.planning?.remaining_minutes);
  expect(
    h.store
      .registry()
      .proposals.some(
        (p) =>
          p.status === "pending" &&
          p.actions.some((a) => a.target_id === target),
      ),
  ).toBe(true);
});

it("H07/I06 a concurrent completion supersedes autonomous analysis instead of reviving a finished task", async () => {
  const { h, target } = await setup();
  let release!: () => void;
  let entered = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.core.agent = {
    interpret: async (_input, context: any) => {
      entered = true;
      await gate;
      return {
        action_groups: [
          {
            action_identity: "stale",
            actions: [
              {
                type: "configure_task",
                target_id: target,
                expected_version: context.task.version,
                planning: { next_action: "过时动作" },
              },
            ],
          },
        ],
        clarification: null,
        reply_intent: "discussion",
        discussion: "先做过时动作。",
      };
    },
  };
  h.core.assistant.startPlanning();
  await expect.poll(() => entered).toBe(true);
  await h.run({ type: "complete_task", target_id: target });
  release();
  await h.core.assistant.drain();
  const task = h.store.registry().tasks.find((t) => t.id === target)!;
  expect(task.status).toBe("done");
  expect(task.planning?.next_action).not.toBe("过时动作");
  expect(h.store.registry().proposals).toHaveLength(0);
});
