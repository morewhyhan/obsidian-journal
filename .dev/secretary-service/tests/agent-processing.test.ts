import { afterEach, it, expect } from "vitest";
import { harness, habitAction, taskAction } from "./helpers.js";
import { atomicWrite } from "../apps/core/files.js";
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
it("bare approval never guesses between multiple pending proposals, while an explicit batch accepts both", async () => {
  const h = harness();
  cleanups.push(() => h.close());
  h.core.agent = {
    interpret: async (input) => ({
      action_groups: [
        {
          action_identity: input.text,
          actions: [
            {
              ...habitAction,
              title: input.text,
            },
          ],
        },
      ],
      clarification: null,
      reply_intent: "proposal",
      summary: "给你一份待确认安排",
    }),
  };
  for (const text of [
    "我是不是应该每天读安排A？",
    "我是不是应该每天读安排B？",
  ]) {
    const input = h.input(text);
    await h.core.receive(input);
    await expect
      .poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id))
      .toMatchObject({ status: "processed" });
  }
  expect(h.store.registry().proposals).toHaveLength(2);
  await h.core.receive(h.input("好"));
  expect(h.store.registry().proposals.every((p) => p.status === "pending")).toBe(true);
  expect(h.store.registry().habits).toHaveLength(0);
  await h.core.receive(h.input("这些都提交"));
  expect(h.store.registry().proposals.every((p) => p.status === "accepted")).toBe(true);
  expect(h.store.registry().habits).toHaveLength(2);
});
it("explicit Chinese create and set commands execute instead of creating a pending proposal", async () => {
  for (const text of [
    "帮我新建一个任务，2分钟后提醒我",
    "设置30秒之后给我发一个Hello",
  ]) {
    const h = harness();
    cleanups.push(() => h.close());
    h.core.agent = {
      interpret: async () => ({
        action_groups: [
          {
            action_identity: "explicit-reminder",
            actions: [
              {
                type: "create_task",
                title: "发Hello",
                outcome: "按安排发出Hello",
                status: "ready",
                acceptance: [
                  { id: "sent", kind: "check", description: "按安排发出Hello" },
                ],
                initial_plan: {
                  kind: "fixed",
                  window_start: "2026-10-23T13:00:00+00:00",
                  window_end: "2026-10-23T13:02:00+00:00",
                  duration_minutes: 2,
                  next_action: "发出Hello",
                },
              },
            ],
          },
        ],
        clarification: null,
        reply_intent: "receipt",
        summary: "已安排",
      }),
    };
    const input = h.input(text);
    await h.core.receive(input);
    await expect
      .poll(() =>
        h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id),
      )
      .toMatchObject({ status: "processed" });
    expect(h.store.registry().tasks).toHaveLength(1);
    expect(h.store.registry().plans).toHaveLength(1);
    expect(h.store.registry().proposals).toHaveLength(0);
    expect(
      JSON.parse(
        (
          h.store.db
            .prepare("SELECT metadata_json FROM inbox WHERE id=?")
            .get(input.id) as any
        ).metadata_json,
      ).groups,
    ).toEqual([{ status: "accepted", operation_id: expect.any(String) }]);
  }
});
it("a model summary cannot claim a pending proposal was already created", async () => {
  const h = harness();
  cleanups.push(() => h.close());
  h.core.agent = {
    interpret: async () => ({
      action_groups: [
        {
          action_identity: "pending-reminder",
          actions: [
            {
              type: "create_task",
              title: "发Hello",
              outcome: "按安排发出Hello",
              status: "ready",
              acceptance: [
                { id: "sent", kind: "check", description: "按安排发出Hello" },
              ],
            },
          ],
        },
      ],
      clarification: null,
      reply_intent: "proposal",
      summary: "建了一条任务",
    }),
  };
  const input = h.input("我是不是应该安排一个提醒？");
  await h.core.receive(input);
  await expect
    .poll(() =>
      h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id),
    )
    .toMatchObject({ status: "processed" });
  expect(h.store.registry().proposals).toHaveLength(1);
  const reply = JSON.parse(
    (
      h.store.db
        .prepare("SELECT metadata_json FROM inbox WHERE id=?")
        .get(input.id) as any
    ).metadata_json,
  ).reply as string;
  expect(reply).toContain("尚未创建任务或设置提醒");
  expect(reply).not.toBe("建了一条任务");
});
it("an accepted reminder inside quiet hours is recorded with an explicit delivery warning", async () => {
  const h = harness("2026-10-23T16:12:00Z");
  cleanups.push(() => h.close());
  const result = await h.run({
    ...taskAction,
    initial_plan: {
      kind: "fixed",
      window_start: "2026-10-23T16:13:00Z",
      window_end: "2026-10-23T16:15:00Z",
      duration_minutes: 2,
      next_action: "发出Hello",
    },
  });
  expect(result.message).toContain("静默时段");
  expect(h.store.registry().tasks).toHaveLength(1);
  expect(h.store.registry().plans).toHaveLength(1);
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
  const input = h.input("分析这篇笔记");
  await h.core.receive(input);
  await expect.poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id)).toMatchObject({ status: "processed" });
  expect(h.store.registry().proposals).toHaveLength(0);
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

it("a read answer in summary is delivered rather than replaced with a generic acknowledgement", async () => {
  const h = harness();
  cleanups.push(() => h.close());
  atomicWrite(h.store.files.resolve("MOC.md"), "# 首页\n");
  h.core.agent = {
    interpret: async (_input, ctx: any) => ({
      action_groups: [],
      clarification: null,
      reply_intent: "discussion",
      summary: "读到 MOC.md：" + ctx.documents[0].content,
    }),
  };
  const input = {
    ...h.input("读一下 MOC.md"),
    note_scope: [
      { path: "MOC.md", heading: null, relation: "evidence" as const },
    ],
  };
  await h.core.receive(input);
  await expect
    .poll(() => {
      const row = h.store.db
        .prepare(
          "SELECT metadata_json FROM inbox WHERE id=? AND status='processed'",
        )
        .get(input.id) as any;
      return row ? JSON.parse(row.metadata_json).reply : null;
    })
    .toBe("读到 MOC.md：# 首页\n");
});

it("partial workspace execution remains visible when a failed answer is later polled", async () => {
  const h = harness();
  cleanups.push(() => h.close());
  h.core.agent = {
    interpret: async (input) => {
      h.store.db
        .prepare(
          "UPDATE inbox SET metadata_json=json_set(metadata_json,'$.workspace_operations',json(?)) WHERE id=?",
        )
        .run(
          JSON.stringify([
            { operation: "write", path: "03. Manual/已执行.md" },
          ]),
          input.id,
        );
      throw new Error("invalid final model output");
    },
  };
  const input = h.input("创建临时笔记");
  await h.core.receive(input);
  await h.core.processPending();
  await expect
    .poll(() =>
      h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id),
    )
    .toMatchObject({ status: "failed" });
  const row: any = h.store.db
    .prepare("SELECT metadata_json FROM inbox WHERE id=?")
    .get(input.id);
  expect(JSON.parse(row.metadata_json).reply).toContain("部分文件操作已完成");
});

it("an optional next-step question cannot replace the answer to the current question", async () => {
  const h = harness();
  cleanups.push(() => h.close());
  h.core.agent = {
    interpret: async () => ({
      action_groups: [],
      reply_intent: "discussion",
      discussion: "默认调用现有模板创建日记，自动生成父级引用。",
      clarification: "要不要我现在创建？",
    }),
  };
  const input = h.input("默认怎么创建？先说明，不要创建。");
  await h.core.receive(input);
  await h.core.processPending();
  await expect
    .poll(() => {
      const row: any = h.store.db
        .prepare(
          "SELECT metadata_json FROM inbox WHERE id=? AND status='processed'",
        )
        .get(input.id);
      return row ? JSON.parse(row.metadata_json).reply : null;
    })
    .toBe("默认调用现有模板创建日记，自动生成父级引用。");
});
