import { afterEach, expect, it } from "vitest";
import { harness, habitAction, taskAction } from "./helpers.js";
import { workspaceCall } from "../apps/core/workspace.js";
import { applicationCall } from "../apps/core/application.js";
import { atomicWrite, hash } from "../apps/core/files.js";
import { cleanup } from "../apps/core/maintenance.js";
import { ruleValue, workingPrinciples } from "../packages/domain/assistant.js";
import {
  activationIssues,
  syncFollowups,
} from "../packages/domain/followups.js";
import { Scheduler } from "../apps/core/scheduler.js";
import { route } from "../packages/calendar/index.js";
import type { Action, Input } from "../packages/contracts/types.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
function setup(time = "2026-10-25T01:00:00Z") {
  const h = harness(time);
  cleanups.push(() => h.close());
  return h;
}
type Harness = ReturnType<typeof setup>;
async function turn(h: Harness, text: string) {
  const input = h.input(text);
  await h.core.receive(input);
  await expect
    .poll(() =>
      h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id),
    )
    .toMatchObject({ status: "processed" });
  return {
    input,
    meta: JSON.parse(
      (
        h.store.db
          .prepare("SELECT metadata_json FROM inbox WHERE id=?")
          .get(input.id) as any
      ).metadata_json,
    ),
  };
}
function session(h: Harness, text: string): Input {
  const input = h.input(text);
  h.store.db
    .prepare(
      "INSERT INTO inbox(id,channel,actor_ref,external_id,body,metadata_json,status,received_at,occurred_at) VALUES(?,?,?,?,?,'{}','processing',?,?)",
    )
    .run(
      input.id,
      input.channel,
      input.actor_ref,
      input.external_id,
      text,
      h.store.now(),
      h.store.now(),
    );
  return input;
}
const result = (actions: Action[], discussion = "已根据实际记录回答。") => ({
  action_groups: actions.length ? [{ action_identity: "test", actions }] : [],
  reply_intent: "discussion",
  clarification: null,
  discussion,
});

it("B09 initial commitment cannot schedule work after its newly declared deadline; failed pairs leave no task or plan", async () => {
  const h = setup("2026-10-26T01:00:00Z");
  const action: Action = { ...taskAction, due_at: "2026-10-26T03:00:00+08:00", initial_plan: {
    window_start: "2026-10-26T10:00:00+08:00", window_end: "2026-10-26T10:20:00+08:00",
    duration_minutes: 20, next_action: "先打开词表A", kind: "window",
  }};
  await expect(h.run(action)).rejects.toMatchObject({ code: "DEADLINE_WINDOW_CONFLICT" });
  expect(h.store.registry().tasks).toHaveLength(0);
  expect(h.store.registry().plans).toHaveLength(0);
  await h.run({ ...action, due_at: "2026-10-26T11:00:00+08:00" });
  const r = h.store.registry();
  expect(r.tasks[0].due_at).toBe("2026-10-26T03:00:00.000Z");
  expect(r.plans[0].window_end).toBe("2026-10-26T02:20:00.000Z");
});

it("G04 late habit reports preserve actual local time separately from report time, survive restart, and keep time corrections", async () => {
  const h = setup("2026-10-26T00:00:00Z");
  await h.run(habitAction);
  const habit = h.store.registry().habits[0];
  const report: Action = { type: "report_habit", target_id: habit.id, expected_version: habit.version,
    business_date: "2026-10-26", status: "did", performed_at: "2026-10-26T06:00:00+08:00" };
  await h.run(report);
  await h.restart();
  expect(h.store.day("2026-10-26").occurrences[0]).toMatchObject({
    performed_at: "2026-10-25T22:00:00.000Z", reported_at: "2026-10-26T00:00:00.000Z", status: "did",
  });
  expect(h.store.day("2026-10-25").occurrences).toHaveLength(0);
  await h.run({ ...report, performed_at: "2026-10-26T06:10:00+08:00" });
  expect(h.store.day("2026-10-26").corrections.at(-1)).toMatchObject({
    old_performed_at: "2026-10-25T22:00:00.000Z", new_performed_at: "2026-10-25T22:10:00.000Z",
  });
  await h.run({ ...report, status: "did_not", performed_at: null });
  expect(h.store.day("2026-10-26").occurrences[0].performed_at).toBeNull();
});

it("G04 unknown habit time stays unknown; future or wrong-date behavior times cannot mutate the saved fact", async () => {
  const h = setup("2026-10-26T00:00:00Z");
  await h.run(habitAction);
  const habit = h.store.registry().habits[0];
  const report: Action = { type: "report_habit", target_id: habit.id, expected_version: habit.version,
    business_date: "2026-10-26", status: "did" };
  await h.run(report);
  expect(h.store.day("2026-10-26").occurrences[0].performed_at).toBeNull();
  const before = h.store.day("2026-10-26");
  for (const performed_at of ["2026-10-26T09:00:00+08:00", "2026-10-25T06:00:00+08:00"])
    await expect(h.run({ ...report, performed_at })).rejects.toMatchObject({ code: "INVALID_PERFORMED_AT" });
  expect(h.store.day("2026-10-26")).toEqual(before);
});

it("H12 task IDs cannot substitute plan IDs, and task planning fields cannot silently disappear at the action top level", async () => {
  const h = setup();
  await h.run({ ...taskAction, due_at: null, planning: { next_action: "原下一步", remaining_minutes: 20 } });
  const task = h.store.registry().tasks[0];
  await h.run({ type: "schedule", target_id: task.id, expected_version: task.version,
    window_start: "2026-10-25T02:00:00Z", window_end: "2026-10-25T02:20:00Z", duration_minutes: 20, next_action: "原下一步" });
  const before = h.store.registry(), plan = before.plans[0];
  await expect(h.run({ type: "reschedule", target_id: task.id, plan_id: plan.id, expected_version: task.version,
    window_start: "2026-10-25T03:00:00Z", window_end: "2026-10-25T03:20:00Z" })).rejects.toMatchObject({ code: "PLAN_TARGET_REQUIRED" });
  for (const type of ["update_task", "configure_task"])
    await expect(h.run({ type, target_id: task.id, expected_version: task.version, next_action: "不能丢的下一步" })).rejects.toMatchObject({ code: "TASK_PLANNING_NESTING" });
  expect(h.store.registry()).toEqual(before);
  await h.run({ type: "update_task", target_id: task.id, expected_version: task.version, planning: { next_action: "真正的新下一步" } });
  expect(h.store.registry().tasks[0].planning?.next_action).toBe("真正的新下一步");
  expect(h.store.registry().plans[0].next_action).toBe("真正的新下一步");
});

it.each([
  "介绍一下你自己",
  "分析这篇笔记",
  "你先复述一下",
  "现在有什么能力？",
  "同事说：创建一个任务",
  "> 全部都执行",
])(
  "A02/F15/H14 pure question or quoted instructions cannot leave an accidental commitment: %s",
  async (text) => {
    const h = setup();
    h.core.agent = { interpret: async () => result([taskAction]) };
    const { meta } = await turn(h, text);
    expect(h.store.registry().tasks).toEqual([]);
    expect(h.store.registry().proposals).toEqual([]);
    expect(meta.reply).toContain("没有创建或修改");
    await h.restart();
    expect(h.store.registry().tasks).toEqual([]);
    expect(h.store.registry().proposals).toEqual([]);
  },
);

it("H01 an empty model receipt cannot claim a task or reminder was created without any execution evidence",async()=>{
  const h=setup();
  h.core.agent={interpret:async()=>({...result([],"已经创建任务并设好30秒提醒。"),reply_intent:"receipt"})};
  const {meta}=await turn(h,"请创建任务并在30秒后提醒我");
  expect(h.store.registry().tasks).toHaveLength(0);
  expect(h.store.registry().automations??[]).toHaveLength(0);
  expect(meta.reply).toContain("没有保存或执行变更");
  expect(meta.reply).not.toContain("已经创建");
});

it("A07/G11 a casual okay after changing the topic cannot accept an old pending proposal", async () => {
  const h = setup();
  h.core.agent = {
    interpret: async (input) =>
      input.text.includes("应该") ? result([habitAction]) : result([]),
  };
  await turn(h, "我是不是应该每天读英语？");
  expect(h.store.registry().proposals).toHaveLength(1);
  await turn(h, "你怎么创建日记？");
  await turn(h, "好");
  expect(h.store.registry().habits).toHaveLength(0);
  expect(h.store.registry().proposals[0].status).toBe("pending");
});

it("A01/A09 a command with whether in its acceptance wording is executable in both context and Core", async () => {
  const h = setup();
  h.core.agent = {
    interpret: async (_input, context: any) => {
      expect(context.input_mode).toBe("interpret_request");
      return result([habitAction]);
    },
  };
  await turn(
    h,
    "请建立每天10点到10点20的英语习惯，最低读一句，只按最低行为判断有没有做。",
  );
  expect(h.store.registry().habits).toHaveLength(1);
  expect(h.store.registry().proposals).toHaveLength(0);
});

it("D09 a record-blocked command is not vetoed by a whether-clause in the review instruction", async () => {
  const h = setup(),
    target = (await h.run(taskAction)).updated_ids[0];
  h.core.agent = {
    interpret: async (_input, context: any) => {
      expect(context.input_mode).toBe("interpret_request");
      return result([
        {
          type: "report_execution",
          target_id: target,
          expected_version: h.store.registry().tasks[0].version,
          execution: "blocked",
          blocker: {
            kind: "waiting",
            detail: "等待合成资料",
            review_at: "2026-10-25T03:30:00Z",
          },
        },
      ]);
    },
  };
  await turn(h, "请记录报告受阻，今天11点30检查是否收到资料。");
  expect(h.store.registry().tasks[0].status).toBe("blocked");
  expect(h.store.registry().tasks[0].planning?.blocker?.review_at).toBe(
    "2026-10-25T03:30:00.000Z",
  );
});

it.each(["再创建一个整理发票任务", "请保存今天例外，不改历史"])(
  "A01/F09 positive instructions retain authority across continuation wording: %s",
  async (text) => {
    const h = setup();
    h.core.agent = {
      interpret: async () =>
        result([
          text.includes("例外")
            ? {
                type: "set_personal_rule",
                key: "contact.style",
                value: "gentle",
                expected_rules_revision: 0,
                ends_at: "2026-10-25T15:59:59Z",
              }
            : taskAction,
        ]),
    };
    await turn(h, text);
    expect(h.store.registry().proposals).toHaveLength(0);
    expect(
      text.includes("例外")
        ? h.store.registry().user_rules?.length
        : h.store.registry().tasks.length,
    ).toBe(1);
  },
);

it("A07 reviewed batch confirmation accepts only that displayed batch, without another model turn", async () => {
  const h = setup();
  h.core.agent = {
    interpret: async (input) => result([{ ...habitAction, title: input.text }]),
  };
  await turn(h, "我是不是应该每天读英语？");
  await turn(h, "我是不是应该每天做运动？");
  await turn(h, "先列一下要创建什么");
  h.core.agent = undefined;
  await turn(h, "好");
  expect(
    h.store.registry().proposals.every((p) => p.status === "accepted"),
  ).toBe(true);
  expect(h.store.registry().habits).toHaveLength(2);
});

it("H14 a timed-message request does not authorize direct file edits, but ordinary reads remain usable", async () => {
  const h = setup(),
    input = session(h, "设置30秒后提醒我Hello");
  atomicWrite(h.store.files.resolve("MOC.md"), "# 原文");
  await expect(
    workspaceCall(h.core, {
      input_id: input.id,
      call_id: "write",
      operation: "write",
      path: "03. Manual/injected.md",
      content: "不应保存",
    }),
  ).rejects.toMatchObject({ code: "DOCUMENT_AUTHORIZATION_REQUIRED" });
  await expect(
    applicationCall(
      h.core,
      { input_id: input.id, call_id: "period", operation: "create_period" },
      { status: () => ({}), backup: {} as any },
    ),
  ).rejects.toMatchObject({ code: "DOCUMENT_AUTHORIZATION_REQUIRED" });
  expect(
    (
      (await workspaceCall(h.core, {
        input_id: input.id,
        call_id: "read",
        operation: "read",
        path: "MOC.md",
      })) as any
    ).content,
  ).toBe("# 原文");
  expect(h.store.files.list()).toEqual(["MOC.md"]);
});

it("H03/H19 a repeated mutating tool call returns its receipt once and never stores note bodies in the event", async () => {
  const h = setup(),
    input = session(h, "创建一份笔记");
  const args = {
    input_id: input.id,
    call_id: "same",
    operation: "write" as const,
    path: "03. Manual/test.md",
    content: "正文唯一真源-合成测试",
  };
  const first = await workspaceCall(h.core, args);
  expect(await workspaceCall(h.core, args)).toEqual(first);
  const rows = h.store.db
    .prepare("SELECT payload_json FROM events WHERE kind='tool_effect'")
    .all() as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0].payload_json).not.toContain(args.content);
  await expect(
    workspaceCall(h.core, { ...args, content: "另一份正文" }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_REUSED" });
  expect(h.store.files.read(args.path)).toBe(args.content);
});

it("A05/H03 idempotency distinguishes different same-title actions but ignores random agent identities", async () => {
  const h = setup(),
    input = h.input("创建两个同名但交付内容不同的任务");
  const first = { ...taskAction, title: "报告", outcome: "交付第一份报告" };
  const second = { ...taskAction, title: "报告", outcome: "交付第二份报告" };
  await h.core.execute(input, [first], "random-a");
  await h.core.execute(input, [second], "random-b");
  await h.core.execute(input, [first], "another-random-id");
  expect(h.store.registry().tasks.map((t) => t.outcome)).toEqual([
    "交付第一份报告",
    "交付第二份报告",
  ]);
});

it("H06/I05 a crash after a file write but before its receipt never reruns the model or rewrites the file", async () => {
  const h = setup(),
    input = session(h, "创建一份笔记");
  h.store.fault = (stage) => {
    if (stage === "tool_effect_written") throw Error("simulated power loss");
  };
  await expect(
    workspaceCall(h.core, {
      input_id: input.id,
      call_id: "write",
      operation: "write",
      path: "03. Manual/test.md",
      content: "只保存一次",
    }),
  ).rejects.toThrow("simulated power loss");
  h.store.fault = undefined;
  await h.restart();
  let calls = 0;
  h.core.agent = {
    interpret: async () => {
      calls++;
      return result([]);
    },
  };
  await h.core.processPending();
  expect(calls).toBe(0);
  expect(h.store.files.read("03. Manual/test.md")).toBe("只保存一次");
  const row = h.store.db
    .prepare("SELECT status,error_code,metadata_json FROM inbox WHERE id=?")
    .get(input.id) as any;
  expect(row.status).toBe("failed");
  expect(row.error_code).toBe("INPUT_INTERRUPTED");
  expect(JSON.parse(row.metadata_json).reply).toContain("未重放");
  expect(JSON.parse(row.metadata_json).reply).toContain("未取得最终回执");
});

it("H06/I05 a business commit before a lost final receipt is recovered without creating a second task", async () => {
  const h = setup(),
    input = session(h, "创建一个任务");
  await h.core.execute(input, [taskAction], "accepted");
  await h.restart();
  let calls = 0;
  h.core.agent = {
    interpret: async () => {
      calls++;
      return result([taskAction]);
    },
  };
  await h.core.processPending();
  expect(calls).toBe(0);
  expect(h.store.registry().tasks).toHaveLength(1);
  const row = h.store.db
    .prepare("SELECT status,metadata_json FROM inbox WHERE id=?")
    .get(input.id) as any;
  expect(row.status).toBe("failed");
  expect(JSON.parse(row.metadata_json).reply).toContain("已保存");
});

it("H07/I06 changing personal rules while the model is working rejects its old business result", async () => {
  const h = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.core.agent = {
    interpret: async () => {
      await gate;
      return result([taskAction]);
    },
  };
  const input = h.input("创建一个任务");
  await h.core.receive(input);
  await expect
    .poll(() =>
      h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id),
    )
    .toMatchObject({ status: "processing" });
  await h.run({
    type: "set_personal_rule",
    key: "contact.style",
    value: "gentle",
    expected_rules_revision: 0,
  });
  release();
  await expect
    .poll(() =>
      h.store.db
        .prepare("SELECT status,error_code FROM inbox WHERE id=?")
        .get(input.id),
    )
    .toMatchObject({ status: "failed", error_code: "VERSION_CONFLICT" });
  expect(h.store.registry().tasks).toHaveLength(0);
  expect(
    ruleValue(h.store.registry(), "contact.style", "missing", h.store.now()),
  ).toBe("gentle");
});

it("E07/E08 file existence alone cannot satisfy a content criterion or an unspecified tool checker", async () => {
  const h = setup();
  atomicWrite(h.store.files.resolve("03. Manual/result.md"), "# 空壳报告");
  const created = await h.run({
    ...taskAction,
    verification: "tool",
    acceptance: [
      {
        id: "output",
        kind: "artifact",
        description: "交付含结论与证据的报告",
        artifact_ref: "03. Manual/result.md",
        artifact_check: { kind: "contains_all", terms: ["## 结论", "## 证据"] },
      },
    ],
  });
  await expect(
    h.run({ type: "complete_task", target_id: created.updated_ids[0] }),
  ).rejects.toMatchObject({ code: "VERIFICATION_PENDING" });
  expect(h.store.registry().tasks[0].status).toBe("ready");
  atomicWrite(
    h.store.files.resolve("03. Manual/result.md"),
    "## 结论\n合成结论\n## 证据\n合成证据",
  );
  await h.run({ type: "complete_task", target_id: created.updated_ids[0] });
  expect(h.store.registry().tasks[0].status).toBe("done");
  const unspecified = await h.run({
    ...taskAction,
    verification: "tool",
    acceptance: [
      {
        id: "x",
        kind: "artifact",
        description: "高质量文章",
        artifact_ref: "03. Manual/result.md",
      },
    ],
  });
  await expect(
    h.run({ type: "complete_task", target_id: unspecified.updated_ids[0] }),
  ).rejects.toMatchObject({ code: "VERIFICATION_PENDING" });
});

it("H01/H12 repeat kind cannot silently discard an hourly schedule and promise a different frequency", async () => {
  const h = setup();
  await expect(h.run({ type: "create_automation", kind: "recurring", title: "每小时回顾", schedule: {
    weekdays: [1,2,3,4,5], starts_on: "2026-10-26", local_start: "09:00", local_end: "18:00", minute: 55,
  } })).rejects.toMatchObject({ code: "ASSISTANT_INVALID" });
  expect(h.store.registry().automations ?? []).toHaveLength(0);
  await expect(h.run({type:"create_automation",kind:"one_shot",title:"Hello",delay_seconds:30,due_at:"2026-10-25T02:00:00Z"}))
    .rejects.toMatchObject({code:"ASSISTANT_INVALID"});
  expect(h.store.registry().automations ?? []).toHaveLength(0);
});

it("J02/J03/J04/J05/J08/J12/J16/J17 ninety controlled days preserve a staged project, rules, habit facts and one delivery per slot", async () => {
  const h = setup("2026-10-25T01:00:00Z");
  const habit = (await h.run({ ...habitAction, reminder_mode: "off" }))
    .updated_ids[0];
  const project = (
    await h.run({
      ...taskAction,
      title: "合成长期项目",
      due_at: "2027-01-23T10:00:00Z",
      planning: { enabled: false },
    })
  ).updated_ids[0];
  const original = structuredClone(
    h.store.registry().tasks.find((t) => t.id === project)!,
  );
  let stage = "";
  await h.run({
    type: "set_personal_rule",
    key: "working.start_small",
    value: {
      instruction: "英语先读一句再继续",
      task_ids: [],
      categories: [],
      purpose: "all",
    },
    expected_rules_revision: 0,
  });
  await h.run({
    type: "set_personal_rule",
    key: "contact.style",
    value: "gentle",
    expected_rules_revision: h.store.registry().rules_revision,
  });
  await h.run({
    type: "create_automation",
    kind: "recurring",
    title: "合成订阅",
    body: "合成定时消息",
    schedule: {
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      starts_on: "2026-10-25",
      local_start: "10:00",
      local_end: "10:01",
    },
  });
  const sent: string[] = [];
  const scheduler = () =>
    new Scheduler(
      h.core,
      {
        health: () => ({ connected: true, lastEventAt: null }),
        send: async (m) => {
          sent.push(m.body);
          return { status: "sent", externalId: "synthetic-" + sent.length };
        },
      },
      "user",
    );
  for (let d = 0; d < 90; d++) {
    const date = new Date(Date.UTC(2026, 9, 25 + d, 2));
    h.setTime(date.toISOString());
    const businessDate = date.toISOString().slice(0, 10);
    if (d % 15 === 0) {
      if (stage) await h.run({ type: "complete_task", target_id: stage });
      stage = (
        await h.run({
          ...taskAction,
          title: "阶段" + (d / 15 + 1),
          due_at: original.due_at,
          parent_task_id: project,
          planning: { enabled: false },
        })
      ).updated_ids[0];
    }
    if (d === 20)
      await h.run({
        type: "report_execution",
        target_id: stage,
        execution: "blocked",
        blocker: {
          kind: "waiting",
          detail: "等待合成外部条件",
          review_at: null,
        },
      });
    if (d === 24)
      await h.run({
        type: "configure_task",
        target_id: stage,
        planning: { blocker: null },
      });
    if (d === 45)
      await h.run({
        type: "configure_task",
        target_id: stage,
        planning: { priority: 1 },
      });
    if (d % 3 !== 2)
      await h.run({
        type: "report_habit",
        target_id: habit,
        business_date: businessDate,
        status: d % 3 === 0 ? "did" : "skipped",
      });
    if (d % 15 === 0)
      await h.run({
        type: "set_personal_rule",
        key: "contact.style",
        value: "direct",
        ends_at: new Date(+date + 3600000).toISOString(),
        expected_rules_revision: h.store.registry().rules_revision,
      });
    await h.core.assistant.tick();
    await scheduler().tick();
    await scheduler().tick();
    expect(sent).toHaveLength(d + 1);
    expect(
      h.store.day(businessDate).occurrences.find((o) => o.habit_id === habit)
        ?.status ?? "unreported",
    ).toBe(["did", "skipped", "unreported"][d % 3]);
    h.advance(2 * 3600000);
    expect(
      ruleValue(h.store.registry(), "contact.style", "none", h.store.now()),
    ).toBe("gentle");
    if (d % 7 === 0) {
      cleanup(h.store);
      await h.restart();
    }
    expect(
      workingPrinciples(h.store.registry(), h.store.now())[0].instruction,
    ).toBe("英语先读一句再继续");
    const current = h.store.registry().tasks.find((t) => t.id === project)!;
    expect(current.outcome).toBe(original.outcome);
    expect(current.acceptance).toEqual(original.acceptance);
    expect(current.due_at).toBe(original.due_at);
    expect(
      h.store.registry().tasks.find((t) => t.id === stage)?.parent_task_id,
    ).toBe(project);
  }
  await h.run({ type: "complete_task", target_id: stage });
  await h.run({ type: "complete_task", target_id: project });
  await h.restart();
  expect(
    h.store
      .registry()
      .tasks.filter((t) => t.id === project || t.parent_task_id === project)
      .every((t) => t.status === "done"),
  ).toBe(true);
  expect(h.store.registry().habits).toHaveLength(1);
  expect(
    h.store.registry().automations?.filter((a) => a.status === "active"),
  ).toHaveLength(1);
  expect(
    h.store.db.prepare("SELECT count(*) n FROM outbox").get(),
  ).toMatchObject({ n: expect.any(Number) });
  expect(
    (h.store.db.prepare("SELECT count(*) n FROM outbox").get() as any).n,
  ).toBeLessThanOrEqual(37);
}, 60000);

it("C05/D13/J10 deadline risk updates with time without inventing user progress", async () => {
  const h = setup();
  const target = (
    await h.run({
      ...taskAction,
      due_at: "2026-11-01T09:00:00Z",
      planning: { next_action: "写报告提纲", remaining_minutes: 500 },
    })
  ).updated_ids[0];
  for (let d = 0; d < 9; d++) {
    h.setTime(new Date(Date.UTC(2026, 9, 25 + d, 10)).toISOString());
    await h.core.coordinator.tick();
    expect(h.store.registry().tasks.find((t) => t.id === target)?.status).toBe(
      "ready",
    );
    expect(h.store.registry().tasks[0].planning?.feedback).toBe("unknown");
  }
  expect(
    h.core.coordinator
      .view("2026-11-02")
      .issues.some((i) => i.kind === "deadline"),
  ).toBe(true);
});

it("D14/J20 confirmed repeated non-starting differs from silence and survives cleanup and restart", async () => {
  const h = setup();
  const target = (
    await h.run({
      ...taskAction,
      due_at: null,
      planning: { next_action: "写第一行", remaining_minutes: 10 },
    })
  ).updated_ids[0];
  for (let i = 0; i < 3; i++) {
    h.advance(86400000);
    await h.run({
      type: "report_execution",
      target_id: target,
      execution: "not_started",
    });
  }
  const r = h.store.registry(),
    settings = h.core.assistant.view().planning;
  const issues = activationIssues(r, "2026-10-28", settings, (d) =>
    h.store.day(d),
  );
  expect(
    issues.some((i) => i.task_id === target && i.kind === "activation"),
  ).toBe(true);
  h.store.commit("persist-followup", "test", "test", (reg, load, op) => {
    syncFollowups(reg, issues, "2026-10-28", h.store.now(), op, load);
    return { ids: [], message: "fixture" };
  });
  h.advance(31 * 86400000);
  cleanup(h.store);
  await h.restart();
  expect(
    h.store
      .registry()
      .followups?.some(
        (f) => f.issue.task_id === target && f.status !== "resolved",
      ),
  ).toBe(true);
  expect(h.store.registry().tasks[0].planning?.execution_history).toHaveLength(
    3,
  );
});

it("B02/H01 one business write path protects task sections while leaving diary prose editable", async () => {
  const h=setup(), input=session(h,"请按模板创建今天的日记并把任务写进去");
  const created:any=await applicationCall(h.core,{input_id:input.id,call_id:"template",operation:"create_period",kind:"daily",date:"2026-10-25"},{status:()=>({}),backup:{} as any});
  const before=h.store.files.read(created.path);
  for(const [n,content] of [before.replace("# 任务","# 任务\n- [ ] 10:00—12:00 背单词"),before.replace("# 任务","# 任务\n10:00背单词")].entries())
    await expect(workspaceCall(h.core,{input_id:input.id,call_id:"fake-plan-"+n,operation:"write",path:created.path,base_hash:hash(before),content})).rejects.toMatchObject({code:"BUSINESS_TOOL_REQUIRED"});
  expect(h.store.files.read(created.path)).toBe(before);
  await workspaceCall(h.core,{input_id:input.id,call_id:"prose",operation:"write",path:created.path,base_hash:hash(before),content:before+"\n今天的真实随笔\n"});
  expect(h.store.files.read(created.path)).toContain("今天的真实随笔");
  expect(h.store.registry().tasks).toHaveLength(0);
});

it("A09/H07 reschedule, deadline and next-step changes share the original transaction snapshot and project only actual state", async () => {
  const h=setup("2026-10-26T01:50:00Z");
  const created=await h.run({...taskAction,due_at:null,title:"背单词",initial_plan:{kind:"fixed",window_start:"2026-10-27T02:00:00Z",window_end:"2026-10-27T04:00:00Z",duration_minutes:120,next_action:"打开材料"}});
  const original=h.store.registry(), task=original.tasks.find(t=>created.updated_ids.includes(t.id))!, plan=original.plans[0];
  h.core.agent={interpret:async(input)=>{
    await applicationCall(h.core,{input_id:input.id,call_id:"template",operation:"create_period",kind:"daily",date:"2026-10-26"},{status:()=>({}),backup:{} as any});
    return result([
    {type:"reschedule",target_id:plan.id,expected_version:plan.version,window_start:"2026-10-26T02:00:00Z",window_end:"2026-10-26T04:00:00Z"},
    {type:"update_task",target_id:task.id,expected_version:task.version,due_at:"2026-10-26T10:00:00Z"},
    {type:"configure_task",target_id:task.id,expected_version:task.version,planning:{next_action:"先打开词表A",remaining_minutes:120}}
  ]);}};
  const {meta}=await turn(h,"请把明天背单词改成今天10点到12点，今天18点截止，先打开词表A，按模板写好今天日记");
  expect(meta.groups).toHaveLength(1); expect(meta.groups[0].status).toBe("accepted");
  const r=h.store.registry();
  expect(r.tasks).toHaveLength(1);expect(r.tasks[0].due_at).toBe("2026-10-26T10:00:00.000Z");
  expect(r.tasks[0].planning!.next_action).toBe("先打开词表A");
  expect(r.plans[0].window_start).toBe("2026-10-26T02:00:00.000Z");
  expect(r.plans[0].next_action).toBe("先打开词表A");
  expect(h.store.files.read(route("daily","2026-10-26"))).toContain("10:00");
  expect(h.store.files.read(route("daily","2026-10-26"))).toContain("先打开词表A");
});

it.each(["update_task","configure_task"])("E23 %s by itself synchronizes the next action to a fixed plan and its diary without moving the appointment",async(type)=>{
  const h=setup(), created=await h.run({...taskAction,due_at:"2026-10-26T10:00:00Z",initial_plan:{kind:"fixed",window_start:"2026-10-25T02:00:00Z",window_end:"2026-10-25T03:00:00Z",duration_minutes:60,next_action:"旧动作"}});
  h.core.coordinator.ensureDiary("2026-10-25");
  const t=h.store.registry().tasks.find(t=>created.updated_ids.includes(t.id))!;
  await h.run({type,target_id:t.id,expected_version:t.version,planning:{next_action:"打开词表A"}});
  expect(h.store.registry().plans[0]).toMatchObject({kind:"fixed",window_start:"2026-10-25T02:00:00.000Z",next_action:"打开词表A"});
  expect(h.store.files.read(route("daily","2026-10-25"))).toContain("打开词表A");
});

it("E23 reschedule applies every advertised field and retains the task's hard deadline",async()=>{
  const h=setup(), created=await h.run({...taskAction,due_at:"2026-10-26T10:00:00Z",initial_plan:{kind:"fixed",window_start:"2026-10-25T02:00:00Z",window_end:"2026-10-25T03:00:00Z",duration_minutes:60,next_action:"旧动作"}});
  const plan=h.store.registry().plans[0];
  await h.run({type:"reschedule",target_id:plan.id,expected_version:plan.version,kind:"window",window_start:"2026-10-25T04:00:00Z",window_end:"2026-10-25T04:30:00Z",duration_minutes:30,next_action:"打开词表A"});
  expect(h.store.registry().plans[0]).toMatchObject({kind:"window",duration_minutes:30,next_action:"打开词表A",window_start:"2026-10-25T04:00:00.000Z"});
  expect(h.store.registry().tasks.find(t=>created.updated_ids.includes(t.id))!).toMatchObject({due_at:"2026-10-26T10:00:00.000Z",planning:{next_action:"打开词表A"}});
});

it("A05/E11 a quoted task title in a multi-action input must not overwrite the independent hourly report",async()=>{
  const h=setup("2026-10-25T01:50:00Z");
  const task=(await h.run({...taskAction,due_at:"2026-10-26T10:00:00Z"})).updated_ids[0];
  await h.run({type:"create_automation",kind:"hourly_checkin",title:"小时回顾",schedule:{weekdays:[1,2,3,4,5,6,7],starts_on:"2026-10-25",local_start:"09:00",local_end:"18:00",minute:55}});
  await h.core.assistant.tick(); const occurrence=h.store.day("2026-10-25").automation_occurrences![0];
  await h.run([{type:"report_automation",target_id:occurrence.automation_id,expected_version:1,business_date:"2026-10-25",occurrence_id:occurrence.id,report:"整理资料"},
    {type:"update_task",target_id:task,expected_version:h.store.registry().tasks[0].version,title:"新标题"}],h.input('把任务标题改成“新标题”，同时记录这一小时在整理资料。'));
  expect(h.store.day("2026-10-25").automation_occurrences![0].report!.text).toBe("整理资料");
  expect(h.store.registry().tasks[0].title).toBe("新标题");
});

it("E11/H01 explicit quoted feedback is saved verbatim and correction history is separate from the current report", async () => {
  const h = setup("2026-10-25T01:50:00Z");
  await h.run({type:"create_automation",kind:"hourly_checkin",title:"小时回顾",to_diary:true,
    schedule:{weekdays:[1,2,3,4,5,6,7],starts_on:"2026-10-25",local_start:"09:00",local_end:"18:00",minute:55}});
  await h.core.assistant.tick();
  const occurrence = h.store.day("2026-10-25").automation_occurrences![0];
  h.core.agent = {interpret:async (input) => result([{type:"report_automation",
    target_id:occurrence.automation_id,expected_version:h.store.registry().automations![0].version,
    business_date:"2026-10-25",occurrence_id:occurrence.id,
    report:input.text.includes("记错") ? "整理资料（更正：此前误记为英语阅读）" : "这一小时在读英语",
    to_diary:input.text.includes("允许") }])};
  const first=await turn(h,'请记为“英语阅读”，这次不要写日记。');
  expect(h.store.day("2026-10-25").automation_occurrences![0].report).toMatchObject({text:"英语阅读",to_diary:false});
  expect(first.meta.reply).not.toContain("已保存自动提醒");
  await turn(h,'刚才记错了，改成“整理资料”，这次允许写到日记。');
  const current=h.store.day("2026-10-25").automation_occurrences![0];
  expect(current.report).toMatchObject({text:"整理资料",to_diary:true});
  expect(current.report_history).toHaveLength(1);
  expect(current.report_history![0].text).toBe("英语阅读");
  await h.core.assistant.tick();
  expect(h.store.files.read(route("daily","2026-10-25"))).toContain("整理资料");
});

it("K01 one ordinary day keeps the same task through prior-night planning, reminder, progress, completion and next-night continuation", async () => {
  const h = setup("2026-10-25T13:00:00Z"),
    sent: { body: string; refs: any[] }[] = [];
  await h.run({
    type: "set_planning",
    preferences: {
      availability: [
        { weekdays: [1, 2, 3, 4, 5, 6, 7], start: "10:00", end: "12:00" },
      ],
    },
  });
  h.core.agent = {
    interpret: async (input, context: any) => {
      if (input.channel === "coordinator")
        return result([], "按已经接受的安排接续，没有新增承诺。");
      if (input.text.includes("创建"))
        return result([
          {
            ...taskAction,
            title: "明日合成报告",
            due_at: "2026-10-26T10:00:00Z",
            planning: {
              next_action: "打开报告写三个小标题",
              remaining_minutes: 60,
            },
            initial_plan: {
              kind: "window",
              window_start: "2026-10-26T02:00:00Z",
              window_end: "2026-10-26T03:00:00Z",
              duration_minutes: 60,
              next_action: "打开报告写三个小标题",
            },
          },
        ]);
      const task = context.items.find((t: any) => t.title === "明日合成报告");
      return result([
        input.text.includes("完整交付")
          ? {
              type: "complete_task",
              target_id: task.id,
              expected_version: task.version,
            }
          : {
              type: "report_execution",
              target_id: task.id,
              expected_version: task.version,
              execution: input.text.includes("开始") ? "started" : "progress",
              remaining_minutes: 30,
            },
      ]);
    },
  };
  await turn(h, "请创建明天十点写报告的任务");
  const target = h.store.registry().tasks[0].id;
  await h.core.coordinator.tick();
  h.core.assistant.startPlanning();
  await h.core.assistant.drain();
  const p = route("daily", "2026-10-26");
  expect(h.store.files.read(p)).toContain("10:00");
  const scheduler = () =>
    new Scheduler(
      h.core,
      {
        health: () => ({ connected: true, lastEventAt: null }),
        send: async (m) => {
          const row = h.store.db
            .prepare("SELECT target_refs_json FROM outbox WHERE id=?")
            .get(m.id) as any;
          sent.push({ body: m.body, refs: JSON.parse(row.target_refs_json) });
          return { status: "sent", externalId: "day-" + sent.length };
        },
      },
      "user",
    );
  h.setTime("2026-10-26T02:00:00Z");
  await scheduler().tick();
  expect(
    sent.some((m) => m.refs.some((r) => r.kind === "task" && r.id === target)),
  ).toBe(true);
  await turn(h, "报告开始了");
  h.setTime("2026-10-26T02:30:00Z");
  await turn(h, "报告做到一半，还差半小时");
  expect(h.store.registry().tasks[0].status).not.toBe("done");
  h.setTime("2026-10-26T02:59:00Z");
  await turn(h, "报告已完整交付，验收全部满足");
  expect(h.store.files.read(p)).toMatch(/- \[x\].*明日合成报告/);
  const count = sent.filter((m) =>
    m.refs.some((r) => r.kind === "task" && r.id === target),
  ).length;
  h.setTime("2026-10-26T13:00:00Z");
  await h.core.coordinator.tick();
  h.core.assistant.startPlanning();
  await h.core.assistant.drain();
  await scheduler().tick();
  expect(h.store.registry().tasks).toHaveLength(1);
  expect(h.store.registry().tasks[0].status).toBe("done");
  expect(
    h.store
      .registry()
      .plans.filter((p) => p.target_ref.id === target)
      .every((p) => p.status === "finished"),
  ).toBe(true);
  expect(
    sent.filter((m) =>
      m.refs.some((r) => r.kind === "task" && r.id === target),
    ),
  ).toHaveLength(count);
});
