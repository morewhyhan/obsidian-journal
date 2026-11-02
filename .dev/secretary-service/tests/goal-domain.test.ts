import { afterEach, describe, expect, it } from "vitest";
import { harness } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
const setup = () => {
  const h = harness();
  cleanups.push(() => h.close());
  return h;
};
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

const goal = {
  type: "create_goal",
  title: "三个月完成英语面试准备",
  problem: "目前无法稳定完成面试英语准备。",
  desired_outcome: "三个月后能够完成目标岗位的英文面试练习。",
  acceptance: [{ id: "interview", kind: "check", description: "完成一次完整模拟面试" }],
  constraints: ["每天最多一小时"],
  non_goals: ["不同时启动第二门语言"],
  principles: ["先保证最低行为，再增加时长"],
  status: "active",
} as const;

describe("M0 Goal & Decision bounded context", () => {
  it("stores a first-class goal instead of using a parent task", async () => {
    const h = setup();
    const created = await h.run(goal as any);
    const target = created.updated_ids[0];
    expect(h.store.registry().goals).toHaveLength(1);
    expect(h.store.registry().goals[0]).toMatchObject({ id: target, status: "active", desired_outcome: goal.desired_outcome });
    expect(h.store.registry().tasks).toHaveLength(0);
  });

  it("links execution to a goal and rejects a terminal goal link", async () => {
    const h = setup();
    const created = await h.run(goal as any);
    const goalId = created.updated_ids[0];
    await h.run({
      type: "create_task",
      title: "做一套模拟题",
      outcome: "完成并订正一套模拟题",
      goal_id: goalId,
      acceptance: [{ id: "done", kind: "check", description: "完成订正" }],
    } as any);
    expect(h.store.registry().tasks[0].goal_id).toBe(goalId);
    const version = h.store.registry().goals[0].version;
    await h.run({ type: "complete_goal", target_id: goalId, expected_version: version, completion_evidence: ["已完成一次模拟面试并保存记录"] } as any);
    await expect(h.run({
      type: "create_task",
      title: "不应继续新增",
      outcome: "不应写入",
      goal_id: goalId,
      acceptance: [{ id: "done", kind: "check", description: "完成" }],
    } as any)).rejects.toMatchObject({ code: "INVALID_RELATION" });
  });

  it("requires a version and evidence when completing a goal", async () => {
    const h = setup();
    const created = await h.run(goal as any);
    const goalId = created.updated_ids[0];
    await expect(h.run({ type: "complete_goal", target_id: goalId, expected_version: 1 } as any)).rejects.toMatchObject({ code: "GOAL_EVIDENCE_REQUIRED" });
    await h.run({ type: "pause_goal", target_id: goalId, expected_version: 1 } as any);
    await expect(h.run({ type: "activate_goal", target_id: goalId, expected_version: 1 } as any)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("keeps the reason for a material choice inside the goal aggregate", async () => {
    const h = setup();
    const created = await h.run(goal as any);
    const goalId = created.updated_ids[0];
    await h.run({
      type: "record_goal_decision",
      target_id: goalId,
      expected_version: 1,
      decision_question: "先练听力还是先背词？",
      decision_context: ["每天只有一小时"],
      decision_options: ["先练听力", "先背词"],
      decision_chosen: "先背词",
      decision_rationale: "先建立最低可持续动作。",
      decision_rejected: ["先练听力"],
    } as any);
    expect(h.store.registry().goals[0].decision_log[0]).toMatchObject({ chosen: "先背词", options: ["先练听力", "先背词"] });
  });
});
