import { expect, it } from "vitest";
import { Compile } from "typebox/compile";
import { Type } from "typebox";
import { actionSchema } from "../packages/contracts/api.js";
it("the shared tool contract distinguishes habit occurrence, definition and task progress states", () => {
  const validate = Compile(Type.Unsafe(actionSchema));
  const base = {
    target_id: "item",
    expected_version: 1,
    business_date: "2026-10-23",
  };
  expect(
    validate.Check({ ...base, type: "report_habit", status: "completed" }),
  ).toBe(false);
  expect(
    validate.Check({ ...base, type: "report_habit", status: "done" }),
  ).toBe(false);
  expect(validate.Check({ ...base, type: "report_habit", status: "did" })).toBe(
    true,
  );
  expect(validate.Check({ ...base, type: "update_habit", status: "did" })).toBe(
    false,
  );
  expect(
    validate.Check({ ...base, type: "update_habit", status: "paused" }),
  ).toBe(true);
  expect(validate.Check({ ...base, type: "update_task", status: "done" })).toBe(
    false,
  );
  expect(
    validate.Check({
      ...base,
      type: "update_task_progress",
      criterion_id: "check",
      status: "met",
    }),
  ).toBe(true);
});
it("ready tasks, including one-shot reminders, require an acceptance condition", () => {
  const validate = Compile(Type.Unsafe(actionSchema));
  const base = {
    type: "create_task",
    title: "发Hello",
    outcome: "按安排发出Hello",
    status: "ready",
  };
  expect(validate.Check(base)).toBe(false);
  expect(
    validate.Check({
      ...base,
      acceptance: [
        { id: "sent", kind: "check", description: "按安排发出Hello" },
      ],
    }),
  ).toBe(true);
});
