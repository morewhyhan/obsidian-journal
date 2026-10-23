import { afterEach, it, expect } from "vitest";
import { harness, habitAction } from "./helpers.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
it("P02 an exploratory wish becomes a proposal and is accepted atomically only once", async () => {
  const h = harness();
  cleanups.push(() => h.close());
  h.core.agent = {
    interpret: async () => ({
      action_groups: [{ action_identity: "new-habit", actions: [habitAction] }],
      clarification: null,
      reply_intent: "proposal",
      summary: "每天读一句英语，晚上8点提示。",
    }),
  };
  const input = h.input("我是不是应该每天读英语？");
  await h.core.receive(input);
  await h.core.processPending();
  await expect.poll(() => h.store.registry().proposals.length).toBe(1);
  expect(h.store.registry().habits).toHaveLength(0);
  const p = h.store.registry().proposals[0];
  const results = await Promise.allSettled([
    h.core.acceptProposal(p.id, p.version, h.input("好")),
    h.core.acceptProposal(p.id, p.version, h.input("好")),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(h.store.registry().habits).toHaveLength(1);
  expect(h.store.registry().proposals[0].status).toBe("accepted");
});
it("A03 a pending model request cannot delay an explicit pause", async () => {
  const h = harness();
  cleanups.push(() => h.close());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.core.agent = {
    interpret: async () => {
      await gate;
      return {
        action_groups: [],
        clarification: null,
        reply_intent: "discussion",
        discussion: "收到。",
      };
    },
  };
  await h.core.receive(h.input("研究一下安排"));
  const pause = await h.core.receive(h.input("今天不提醒了"));
  expect(h.store.registry().controls).toHaveLength(1);
  expect(
    h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(pause.id),
  ).toMatchObject({ status: "processed" });
  release();
  await expect
    .poll(() =>
      h.store.db
        .prepare("SELECT count(*) AS n FROM inbox WHERE status='processing'")
        .get(),
    )
    .toMatchObject({ n: 0 });
});
it("A02 note instructions cannot authorize a completion while the user requests analysis", async () => {
  const h = harness();
  cleanups.push(() => h.close());
  const habit = await h.run(habitAction);
  h.core.agent = {
    interpret: async () => ({
      action_groups: [
        {
          action_identity: "injected",
          actions: [
            {
              type: "report_habit",
              target_id: habit.updated_ids[0],
              expected_version: 1,
              business_date: "2026-10-23",
              status: "did",
            },
          ],
        },
      ],
      clarification: null,
      reply_intent: "receipt",
      summary: "候选动作",
    }),
  };
  await h.core.receive(h.input("分析这篇笔记"));
  await expect.poll(() => h.store.registry().proposals.length).toBe(1);
  expect(h.store.day("2026-10-23").occurrences).toHaveLength(0);
});
it("a model action without the context version is rejected and reported per group", async () => {
  const h = harness();
  cleanups.push(() => h.close());
  const habit = await h.run(habitAction);
  h.core.agent = {
    interpret: async () => ({
      action_groups: [
        {
          action_identity: "missing-version",
          actions: [
            {
              type: "report_habit",
              target_id: habit.updated_ids[0],
              business_date: "2026-10-23",
              status: "did",
            },
          ],
        },
      ],
      clarification: null,
      reply_intent: "receipt",
    }),
  };
  const input = h.input("读了一句");
  await h.core.receive(input);
  await expect
    .poll(() =>
      h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id),
    )
    .toMatchObject({ status: "processed" });
  expect(
    JSON.parse(
      (
        h.store.db
          .prepare("SELECT metadata_json FROM inbox WHERE id=?")
          .get(input.id) as any
      ).metadata_json,
    ).groups,
  ).toEqual([{ status: "conflict", reason: "VERSION_CONFLICT" }]);
  expect(h.store.day("2026-10-23").occurrences).toHaveLength(0);
});

it("an explicit directory request receives a bounded read-only inventory", async () => {
  const h = harness();
  cleanups.push(() => h.close());

  const inventory = h.core.context(h.input("请列出我现在目录下面有什么文件")) as any;
  expect(inventory.workspace_inventory).toMatchObject({
    scope: "configured_vault",
    read_only: true,
    paths: [],
    truncated: false,
  });

  const ordinary = h.core.context(h.input("提醒我今晚读一句英语")) as any;
  expect(ordinary.workspace_inventory).toBeUndefined();
});
