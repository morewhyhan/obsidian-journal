import { afterEach, it, expect } from "vitest";
import { harness, habitAction, taskAction } from "./helpers.js";
import { atomicWrite } from "../apps/core/files.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});
function setup() {
  const h = harness();
  cleanups.push(() => h.close());
  return h;
}
it("P05 an explicit supporting relation permits independent habit and task facts from one input", async () => {
  const h = setup(),
    habit = await h.run(habitAction),
    habitId = habit.updated_ids[0];
  atomicWrite(h.store.files.resolve("03. Manual/method.md"), "自己写的方法");
  const task = await h.run({
    ...taskAction,
    supporting_habit_ids: [habitId],
    note_refs: [
      { path: "03. Manual/method.md", heading: null, relation: "method" },
    ],
  });
  await h.run([
    {
      type: "report_habit",
      target_id: habitId,
      business_date: "2026-10-23",
      status: "did",
    },
    {
      type: "update_task_progress",
      target_id: task.updated_ids[0],
      criterion_id: "count",
      value: 2,
      unit: "题",
      mode: "total",
    },
  ]);
  expect(h.store.day("2026-10-23").occurrences[0].status).toBe("did");
  const current = h.store.registry().tasks[0];
  expect(current.status).toBe("in_progress");
  expect(current.progress.criteria.count.reported_value).toBe(2);
  expect(current.supporting_habit_ids).toEqual([habitId]);
  expect(current.note_refs[0].path).toBe("03. Manual/method.md");
});
it("relations cannot point to a missing habit or private filesystem paths", async () => {
  const h = setup();
  await expect(
    h.run({ ...taskAction, supporting_habit_ids: ["missing"] }),
  ).rejects.toMatchObject({ code: "INVALID_RELATION" });
  await expect(
    h.run({
      ...habitAction,
      note_refs: [{ path: "../outside.md", relation: "method" }],
    }),
  ).rejects.toMatchObject({ code: "INVALID_PATH" });
  expect(h.store.registry().tasks).toHaveLength(0);
});
it("P06 workspace artifact checker verifies a real file; model-provided success cannot replace evidence", async () => {
  const h = setup();
  const task = await h.run({
    ...taskAction,
    verification: "tool",
    acceptance: [
      {
        id: "output",
        kind: "artifact",
        description: "交付正文",
        artifact_ref: "03. Manual/result.md",
      },
    ],
  });
  await expect(
    h.run({
      type: "complete_task",
      target_id: task.updated_ids[0],
      verified: true,
    }),
  ).rejects.toMatchObject({ code: "VERIFICATION_PENDING" });
  atomicWrite(h.store.files.resolve("03. Manual/result.md"), "");
  await expect(
    h.run({ type: "complete_task", target_id: task.updated_ids[0] }),
  ).rejects.toMatchObject({ code: "VERIFICATION_PENDING" });
  atomicWrite(h.store.files.resolve("03. Manual/result.md"), "实际交付");
  await h.run({ type: "complete_task", target_id: task.updated_ids[0] });
  expect(h.store.registry().tasks[0].status).toBe("done");
});
it("P09 first report about yesterday uses the former minimum even after the definition changes", async () => {
  const h = setup(),
    created = await h.run(habitAction),
    target_id = created.updated_ids[0];
  await h.run({
    type: "update_habit",
    target_id,
    min_behavior: "读一段英语",
    optional_target: null,
    recurrence: { weekdays: [1, 3, 5], starts_on: "2026-01-01" },
    anchor: { kind: "time_window", local_start: "18:00", local_end: "19:00" },
  });
  await h.run({
    type: "report_habit",
    target_id,
    business_date: "2026-10-22",
    status: "did",
  });
  expect(h.store.day("2026-10-22").occurrences[0].min_behavior_snapshot).toBe(
    "读一句英语",
  );
  expect(h.store.registry().habits[0].optional_target).toBeNull();
  expect(h.store.registry().habits[0].recurrence.weekdays).toEqual([1, 3, 5]);
});
it("task parent cycle and duplicate acceptance IDs are rejected without partial writes", async () => {
  const h = setup(),
    parent = await h.run(taskAction),
    child = await h.run({
      ...taskAction,
      title: "子任务",
      parent_task_id: parent.updated_ids[0],
    });
  await expect(
    h.run({
      type: "update_task",
      target_id: parent.updated_ids[0],
      parent_task_id: child.updated_ids[0],
    }),
  ).rejects.toMatchObject({ code: "INVALID_RELATION" });
  await expect(
    h.run({
      ...taskAction,
      acceptance: [
        { id: "same", kind: "check", description: "一" },
        { id: "same", kind: "check", description: "二" },
      ],
    }),
  ).rejects.toMatchObject({ code: "INVALID_ACCEPTANCE" });
  expect(h.store.registry().tasks).toHaveLength(2);
});
it("changing acceptance invalidates previously met criteria and reopens a completed task", async () => {
  const h = setup(),
    task = await h.run(taskAction);
  await h.run({ type: "complete_task", target_id: task.updated_ids[0] });
  await h.run({
    type: "update_task",
    target_id: task.updated_ids[0],
    acceptance: [{ id: "new", kind: "check", description: "新的交付条件" }],
  });
  const current = h.store.registry().tasks[0];
  expect(current.status).toBe("in_progress");
  expect(current.done_at).toBeNull();
  expect(current.progress.criteria).toEqual({});
});
it("invalid recurrence and same-time anchor cannot silently become a daily reminder", async () => {
  const h = setup();
  await expect(
    h.run({
      ...habitAction,
      recurrence: {
        weekdays: [1],
        starts_on: "2026-10-23",
        ends_on: "2026-01-01",
      },
    }),
  ).rejects.toMatchObject({ code: "INVALID_RECURRENCE" });
  await expect(
    h.run({
      ...habitAction,
      anchor: { kind: "time_window", local_start: "20:00", local_end: "20:00" },
    }),
  ).rejects.toMatchObject({ code: "INVALID_ANCHOR" });
});
it("one atomic group can update separate criteria using the same base version", async () => {
  const h = setup(),
    task = await h.run(taskAction);
  await h.run([
    {
      type: "update_task_progress",
      target_id: task.updated_ids[0],
      expected_version: 1,
      criterion_id: "count",
      mode: "total",
      value: 2,
      unit: "题",
    },
    {
      type: "update_task_progress",
      target_id: task.updated_ids[0],
      expected_version: 1,
      criterion_id: "correct",
      status: "met",
      report: "做过的两题已经订正",
    },
  ]);
  const current = h.store.registry().tasks[0];
  expect(current.progress.criteria.count.reported_value).toBe(2);
  expect(current.progress.criteria.correct.status).toBe("met");
  expect(current.status).toBe("in_progress");
});
it("a self-contradictory partial report cannot also mark the whole task done", async () => {
  const h = setup(),
    task = await h.run(taskAction);
  await expect(
    h.run([
      {
        type: "update_task_progress",
        target_id: task.updated_ids[0],
        expected_version: 1,
        criterion_id: "count",
        value: 2,
        unit: "题",
        mode: "total",
      },
      {
        type: "complete_task",
        target_id: task.updated_ids[0],
        expected_version: 1,
      },
    ]),
  ).rejects.toMatchObject({ code: "ACCEPTANCE_CONTRADICTION" });
  expect(h.store.registry().tasks[0].status).toBe("ready");
});
it("a qualitative progress note keeps earlier quantities and its own source after restart", async () => {
  const h = setup(),
    task = await h.run(taskAction);
  await h.run({
    type: "update_task_progress",
    target_id: task.updated_ids[0],
    criterion_id: "count",
    mode: "total",
    value: 2,
    unit: "题",
  });
  const input = h.input("订正时卡住了");
  await h.run(
    {
      type: "update_task_progress",
      target_id: task.updated_ids[0],
      task_status: "blocked",
      report: "订正时卡住了",
    },
    input,
  );
  await h.restart();
  const current = h.store.registry().tasks[0];
  expect(current.status).toBe("blocked");
  expect(current.progress.criteria.count.reported_value).toBe(2);
  expect(current.progress.last_report).toBe("订正时卡住了");
  expect(current.progress.report_source?.input_id).toBe(input.id);
});
it("tool proof is tied to the exact criterion and cannot approve a different file after editing", async () => {
  const h = setup();
  atomicWrite(h.store.files.resolve("03. Manual/existing.md"), "actual file");
  const task = await h.run({
    ...taskAction,
    verification: "tool",
    acceptance: [
      {
        id: "output",
        kind: "artifact",
        description: "存在文件",
        artifact_ref: "03. Manual/existing.md",
      },
    ],
  });
  await expect(
    h.run([
      {
        type: "update_task",
        target_id: task.updated_ids[0],
        expected_version: 1,
        acceptance: [
          {
            id: "output",
            kind: "artifact",
            description: "另一个文件",
            verification: "tool",
            artifact_ref: "03. Manual/missing.md",
          },
        ],
      },
      {
        type: "complete_task",
        target_id: task.updated_ids[0],
        expected_version: 1,
      },
    ]),
  ).rejects.toMatchObject({ code: "VERIFICATION_PENDING" });
  expect(h.store.registry().tasks[0].status).toBe("ready");
});
