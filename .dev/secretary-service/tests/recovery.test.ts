import fs from "node:fs";
import path from "node:path";
import { afterEach, it, expect } from "vitest";
import {
  harness,
  habitAction,
  taskAction,
  temporary,
  removeTemporary,
} from "./helpers.js";
import { atomicWrite } from "../apps/core/files.js";
import { Store } from "../apps/core/store.js";
import { Core } from "../apps/core/core.js";
import { loadConfig } from "../apps/core/config.js";
import { Scheduler } from "../apps/core/scheduler.js";
import { GitWorker, git } from "../apps/core/git.js";
import { Maintenance } from "../apps/core/maintenance.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function setup() {
  const h = harness();
  cleanup.push(() => h.close());
  return h;
}
it("reordered optional state fields remain recoverable after an interrupted patch", async () => {
  const h = setup();
  h.store.commit("old-order", "test", "test", (_r, load) => {
    load("2026-10-24").assistance = {
      status: "running",
      revision: 1,
      attempts: 1,
    };
    return { ids: [], message: "fixture" };
  });
  h.store.fault = (stage) => {
    if (stage === "prepared") throw new Error("power loss");
  };
  expect(() =>
    h.store.commit("new-order", "test", "test", (_r, load) => {
      load("2026-10-24").assistance = {
        status: "failed",
        attempts: 1,
        revision: 1,
        error: "offline",
      };
      return { ids: [], message: "fixture" };
    }),
  ).toThrow("power loss");
  h.store.fault = undefined;
  await h.restart();
  expect(h.store.day("2026-10-24").assistance?.status).toBe("failed");
  expect(
    h.store.db
      .prepare(
        "SELECT count(*) n FROM events WHERE status='prepared' AND kind='business'",
      )
      .get(),
  ).toMatchObject({ n: 0 });
});
it("B05 restore from an isolated backup retains exact Markdown and long-lived facts without replaying old messages", async () => {
  const h = setup(),
    habit = await h.run(habitAction);
  await h.run(taskAction);
  await h.run({
    type: "report_habit",
    target_id: habit.updated_ids[0],
    business_date: "2026-10-23",
    status: "did",
  });
  await h.run({ type: "remember_fact", fact: "提醒保持简单。" });
  atomicWrite(
    h.store.files.resolve("03. Manual/exact.md"),
    "---\r\ntitle: 原文\r\n---\r\n用户文字\r\n",
  );
  atomicWrite(
    h.store.files.resolve("Attachment/a.txt", "attachment"),
    "附件内容",
  );
  atomicWrite(path.join(h.root, ".gitignore"), ".agent/data/\n.env\n");
  const remote = temporary(),
    restored = temporary();
  cleanup.push(async () => {
    removeTemporary(remote);
    removeTemporary(restored);
  });
  await git(remote, ["init", "--bare"]);
  await git(h.root, ["init", "-b", "main"]);
  await git(h.root, ["config", "user.name", "Fixture"]);
  await git(h.root, ["config", "user.email", "fixture@example.invalid"]);
  await git(h.root, ["remote", "add", "origin", remote]);
  const worker = new GitWorker(h.root, {
    enabled: true,
    debounceSeconds: 0,
    maxSeconds: 1,
    branch: "main",
    remote,
    verifyPrivate: async () => true,
  });
  await worker.tick();
  expect(worker.lastPush).not.toBeNull();
  await git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(h.root, ["clone", remote, restored]);
  const clock = () => new Date("2026-10-23T12:00:00Z"),
    store = new Store(restored, loadConfig(restored), clock);
  cleanup.push(() => store.close());
  const core = new Core(store);
  expect(store.files.read("03. Manual/exact.md")).toBe(
    "---\r\ntitle: 原文\r\n---\r\n用户文字\r\n",
  );
  expect(
    fs.readFileSync(
      store.files.resolve("Attachment/a.txt", "attachment"),
      "utf8",
    ),
  ).toBe("附件内容");
  expect(store.registry().tasks).toHaveLength(1);
  expect(store.day("2026-10-23").occurrences[0].status).toBe("did");
  expect(
    fs.readFileSync(
      store.files.resolve(".agent/context/user.md", "internal"),
      "utf8",
    ),
  ).toContain("提醒保持简单");
  expect(store.recoveryUntil).toBe("2026-10-23T16:00:00.000Z");
  let sends = 0;
  await new Scheduler(
    core,
    {
      health: () => ({ connected: true, lastEventAt: null }),
      send: async () => {
        sends++;
        return { status: "sent", externalId: "should-not-send" };
      },
    },
    "user",
  ).tick();
  expect(sends).toBe(0);
  expect(
    store.db.prepare("SELECT count(*) AS n FROM inbox").get(),
  ).toMatchObject({ n: 0 });
});
for (const stage of [
  "file:.agent/state/registry.json",
  "file:.agent/state/days/2026-10-23.json",
])
  it(
    "D04 grouped registry and day mutation recovers exactly once after " +
      stage,
    async () => {
      const h = setup(),
        habit = await h.run(habitAction),
        task = await h.run(taskAction),
        input = h.input("又做两题，也读过一句"),
        actions = [
          {
            type: "report_habit",
            target_id: habit.updated_ids[0],
            business_date: "2026-10-23",
            status: "did",
          },
          {
            type: "update_task_progress",
            target_id: task.updated_ids[0],
            criterion_id: "count",
            value: 2,
            unit: "题",
            mode: "increment",
          },
        ];
      let triggered = false;
      h.store.fault = (point) => {
        if (point === stage && !triggered) {
          triggered = true;
          throw new Error("power loss");
        }
      };
      await expect(h.run(actions, input)).rejects.toThrow("power loss");
      h.store.fault = undefined;
      await h.restart();
      await h.run(actions, input);
      expect(h.store.day("2026-10-23").occurrences).toHaveLength(1);
      expect(
        h.store.registry().tasks[0].progress.criteria.count.reported_value,
      ).toBe(2);
    },
  );
it("D03 a crash after checkbox file write recovers both the index and one business fact", async () => {
  const h = setup(),
    habit = await h.run(habitAction),
    daily = await h.core.newPeriod("daily", "2026-10-23"),
    before = h.store.document(daily.path),
    after = before.content.replace("- [ ] 英语", "- [x] 英语");
  h.store.fault = (stage) => {
    if (stage === "document_written") throw new Error("power loss");
  };
  await expect(
    h.core.saveDocument(daily.path, before.hash, after, "save-crash"),
  ).rejects.toThrow("power loss");
  h.store.fault = undefined;
  await h.restart();
  expect(h.store.files.read(daily.path)).toBe(after);
  expect(h.store.day("2026-10-23").occurrences).toHaveLength(1);
  expect(h.store.day("2026-10-23").occurrences[0].habit_id).toBe(
    habit.updated_ids[0],
  );
  await h.core.saveDocument(daily.path, before.hash, after, "save-crash");
  expect(h.store.day("2026-10-23").occurrences).toHaveLength(1);
});
it("B03 daily maintenance survives restart and waits until 04:30 on the following day", async () => {
  const h = setup(),
    maintenance = new Maintenance(h.store);
  await maintenance.tick();
  const first = maintenance.last?.at;
  expect(first).toBe(h.store.now());
  await h.restart();
  const recovered = new Maintenance(h.store);
  await recovered.tick();
  expect(recovered.last?.at).toBe(first);
  h.setTime("2026-10-23T20:29:00Z");
  await recovered.tick();
  expect(recovered.last?.at).toBe(first);
  h.advance(60000);
  await recovered.tick();
  expect(recovered.last?.at).toBe(h.store.now());
});
it("A02 real and dangling symlinks are denied before a file can escape the vault", async () => {
  const h = setup(),
    outside = temporary();
  cleanup.push(async () => removeTemporary(outside));
  fs.mkdirSync(path.join(h.root, "03. Manual"), { recursive: true });
  atomicWrite(path.join(outside, "outside.md"), "outside-secret");
  fs.symlinkSync(
    outside,
    path.join(h.root, "03. Manual/escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(() => h.store.files.read("03. Manual/escape/outside.md")).toThrow(
    "符号链接",
  );
  fs.symlinkSync(
    path.join(outside, "missing"),
    path.join(h.root, "03. Manual/dangling"),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(() => h.store.files.resolve("03. Manual/dangling/new.md")).toThrow(
    "符号链接",
  );
  expect(fs.existsSync(path.join(outside, "missing/new.md"))).toBe(false);
});
