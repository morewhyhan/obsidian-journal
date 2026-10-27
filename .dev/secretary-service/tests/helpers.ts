import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../apps/core/config.js";
import { Store } from "../apps/core/store.js";
import { Core } from "../apps/core/core.js";
import { id } from "../apps/core/files.js";
import type { Action, Input } from "../packages/contracts/types.js";
export function temporary() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "secretary-test-"));
}
export function removeTemporary(root: string) {
  const resolved = path.resolve(root),
    relative = path.relative(os.tmpdir(), resolved);
  if (!relative.startsWith("secretary-test-") || relative.includes(path.sep))
    throw new Error("Refusing unsafe test cleanup");
  fs.rmSync(resolved, { recursive: true, force: true });
}
export function harness(date = "2026-10-23T12:00:00Z") {
  const root = temporary();
  let now = new Date(date),
    store = new Store(root, loadConfig(root), () => now),
    core = new Core(store);

  const input = (text = "用户明确交代"): Input => ({
    id: id("input"),
    channel: "web",
    actor_ref: "user",
    external_id: id("msg"),
    text,
    occurred_at: now.toISOString(),
  });
  const run = (action: Action | Action[], message?: Input) =>
    core.execute(
      message ?? input(),
      Array.isArray(action) ? action : [action],
      "test",
      true,
    );
  return {
    root,
    get store() {
      return store;
    },
    get core() {
      return core;
    },
    input,
    run,
    advance(ms: number) {
      now = new Date(+now + ms);
    },
    setTime(time: string) {
      now = new Date(time);
    },
    async restart() {
      await store.close();
      store = new Store(root, loadConfig(root), () => now);
      core = new Core(store);
    },
    async close() {
      await store.close();
      removeTemporary(root);
    },
  };
}
export const habitAction: Action = {
  type: "create_habit",
  title: "英语",
  min_behavior: "读一句英语",
  optional_target: { value: 1, unit: "章" },
  recurrence: { weekdays: [1, 2, 3, 4, 5, 6, 7], starts_on: "2026-01-01" },
  anchor: { kind: "time_window", local_start: "20:00", local_end: "23:00" },
  reminder_mode: "window",
};
export const taskAction: Action = {
  type: "create_task",
  title: "阅读练习",
  outcome: "完成五题并订正",
  due_at: "2026-10-24T10:00:00Z",
  acceptance: [
    {
      id: "count",
      kind: "count",
      description: "完成五题",
      target: 5,
      unit: "题",
    },
    { id: "correct", kind: "check", description: "完成订正" },
  ],
};
