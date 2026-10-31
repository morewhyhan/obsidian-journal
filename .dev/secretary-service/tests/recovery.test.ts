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
import { recoveryInventory } from "../apps/core/recovery-control.js";
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
it("D07b the operator CLI imports a fresh revocation list into the running vault", async () => {
  const h = setup();
  const store = h.store;
  const root = h.root;
  await h.store.close();
  // The operator supplies a list produced after the backup they restored.
  const listPath = path.join(root, "latest-revocations.json");
  fs.writeFileSync(
    listPath,
    JSON.stringify({
      revision: 7,
      entries: [
        {
          kind: "fact",
          target_id: "fact_cli_fixture",
          target_version: 1,
          scope: ["安排"],
          reason_code: "user_forgot",
          revoked_at: "2026-10-24T08:00:00Z",
        },
      ],
    }),
    "utf8",
  );
  const { execFileSync } = await import("node:child_process");
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "apps/core/cli.ts", "recovery-import-revocations", listPath],
    { cwd: process.cwd(), env: { ...process.env, SECRETARY_VAULT_ROOT: root }, encoding: "utf8" },
  );
  const reported = JSON.parse(output);
  expect(reported.imported).toBe(1);
  expect(reported.revision).toBe(7);
  const reopened = new Store(root, loadConfig(root), () => new Date("2026-10-24T09:00:00Z"));
  cleanup.push(async () => reopened.close());
  const rows = reopened.db.prepare("SELECT target_id FROM revocations").all() as any[];
  expect(rows.map((row) => row.target_id)).toContain("fact_cli_fixture");
  expect(reopened.revocationRevision()).toBe(7);
  expect(reopened.runtimeMeta().revocation_history).toMatchObject({ source: "imported", revision: 7, complete: true });
  fs.rmSync(listPath, { force: true });
});

it("G01 an older vault is upgraded on start exactly once and keeps its content", async () => {
  const h = setup();
  await h.run(taskAction);
  const registryPath = h.store.files.resolve(h.store.config.storage.registry, "internal");
  const v1 = h.store.registry() as any;
  v1.schema_version = 1;
  fs.writeFileSync(registryPath, JSON.stringify(v1, null, 2) + "\n", "utf8");
  const titles = v1.tasks.map((t: any) => t.title);
  await h.store.close();

  const reopened = new Store(h.root, loadConfig(h.root), () => new Date("2026-10-24T09:00:00Z"));
  cleanup.push(async () => reopened.close());
  expect(reopened.registry().schema_version).toBe(2);
  expect(reopened.registry().tasks.map((t) => t.title)).toEqual(titles);
  const migrations = reopened.db
    .prepare("SELECT count(*) n FROM events WHERE dedupe_key LIKE 'registry-migration%'")
    .get() as any;
  expect(migrations.n).toBe(1);
  // Starting again must not migrate a second time.
  await reopened.close();
  const again = new Store(h.root, loadConfig(h.root), () => new Date("2026-10-24T09:00:00Z"));
  cleanup.push(async () => again.close());
  expect(again.registry().schema_version).toBe(2);
  expect(
    again.db.prepare("SELECT count(*) n FROM events WHERE dedupe_key LIKE 'registry-migration%'").get(),
  ).toMatchObject({ n: 1 });
});

it("E14 a corrupt runtime database is quarantined and never reported as a healthy save", async () => {
  const h = setup();
  await h.run(taskAction);
  const dbFile = h.store.files.resolve(h.store.config.storage.database, "internal");
  const tasksBefore = h.store.registry().tasks.map((t) => t.title);
  await h.store.close();
  // A corrupt SQLite file cannot be used, but the Markdown/JSON truth stays.
  fs.writeFileSync(dbFile, "this is not a database", "utf8");
  const reopened = new Store(h.root, loadConfig(h.root), () => new Date("2026-10-24T08:00:00Z"));
  cleanup.push(async () => reopened.close());
  expect(reopened.registry().tasks.map((t) => t.title)).toEqual(tasksBefore);
  expect(reopened.runtimeMeta().recovery_guard).toMatchObject({ active: true, reason: "RUNTIME_REBUILT" });
  // The damaged file is kept for inspection, not deleted.
  expect(fs.readdirSync(path.dirname(dbFile)).some((name) => name.includes(".quarantine-"))).toBe(true);
});


it("D03b a real process kill during prepare recovers exactly one commit", { timeout: 60000 }, async () => {
  const root = temporary();
  cleanup.push(async () => removeTemporary(root));
  const serviceRoot = process.cwd();
  const script = path.join(root, "kill-during-prepare.ts");
  fs.writeFileSync(
    script,
    [
      'import { Store } from ' + JSON.stringify(path.join(serviceRoot, "apps/core/store.ts")) + ";",
      'import { loadConfig } from ' + JSON.stringify(path.join(serviceRoot, "apps/core/config.ts")) + ";",
      "const root = " + JSON.stringify(root) + ";",
      "const store = new Store(root, loadConfig(root), () => new Date('2026-10-24T08:00:00Z'));",
      "// Die outright after the commit is prepared but before any file is replaced.",
      "store.fault = (stage: string) => { if (stage === 'prepared') process.kill(process.pid, 'SIGKILL'); };",
      "store.commit('killed', 'test', 'killed', (_r, load) => {",
      "  Object.assign(load('2026-10-24'), { assistance: { status: 'running', revision: 1, attempts: 1 } });",
      "  return { ids: [], message: 'killed mid-commit' };",
      "});",
    ].join("\n"),
    "utf8",
  );
  const { spawnSync } = await import("node:child_process");
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", script],
    { cwd: serviceRoot, env: { ...process.env }, encoding: "utf8" },
  );
  // The child really died: no clean shutdown, no recovery inside that process.
  expect(child.signal ?? child.status).toBeTruthy();
  expect(child.status === 0 && !child.signal).toBe(false);

  // Reopening the vault performs recovery exactly once.
  const recovered = new Store(root, loadConfig(root), () => new Date("2026-10-24T09:00:00Z"));
  cleanup.push(async () => recovered.close());
  expect(recovered.day("2026-10-24").assistance?.status).toBe("running");
  expect(
    recovered.db.prepare("SELECT count(*) n FROM events WHERE status='prepared' AND kind='business'").get(),
  ).toMatchObject({ n: 0 });
  expect(
    recovered.db.prepare("SELECT count(*) n FROM events WHERE kind='business' AND status='applied'").get(),
  ).toMatchObject({ n: 1 });
});


it("D03d a live Core owns the vault, and a killed one is taken over", { timeout: 60000 }, async () => {
  const root = temporary();
  cleanup.push(async () => removeTemporary(root));
  const serviceRoot = process.cwd();
  const script = path.join(root, "hold-lock.ts");
  const ready = path.join(root, "ready.txt");
  fs.writeFileSync(
    script,
    [
      'import fs from "node:fs";',
      'import { Store } from ' + JSON.stringify(path.join(serviceRoot, "apps/core/store.ts")) + ";",
      'import { loadConfig } from ' + JSON.stringify(path.join(serviceRoot, "apps/core/config.ts")) + ";",
      "const root = " + JSON.stringify(root) + ";",
      "const store = new Store(root, loadConfig(root), () => new Date('2026-10-24T08:00:00Z'));",
      "fs.writeFileSync(" + JSON.stringify(ready) + ", 'ok');",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    "utf8",
  );
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: serviceRoot,
    env: { ...process.env },
    stdio: "ignore",
  });
  cleanup.push(async () => {
    child.kill("SIGKILL");
  });
  for (let i = 0; i < 100 && !fs.existsSync(ready); i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  expect(fs.existsSync(ready)).toBe(true);

  // A second Core must refuse promptly instead of waiting to take over.
  const started = Date.now();
  expect(
    () => new Store(root, loadConfig(root), () => new Date("2026-10-24T09:00:00Z")),
  ).toThrow();
  expect(Date.now() - started).toBeLessThan(5000);

  // Once that writer is gone, the same vault opens and recovers.
  child.kill("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const reopened = new Store(root, loadConfig(root), () => new Date("2026-10-24T09:00:00Z"));
  cleanup.push(async () => reopened.close());
  expect(reopened.registry().tasks).toEqual([]);
});

it("E07 a structured file changed after prepare is reported as a conflict, not overwritten", async () => {
  const h = setup();
  await h.run(habitAction);
  const registryPath = h.store.files.resolve(".agent/state/registry.json", "internal");
  // The next commit is prepared, then interrupted before its files are written.
  h.store.fault = (stage) => {
    if (stage === "prepared") throw new Error("power loss");
  };
  await expect(h.core.execute(h.input("建一个任务"), [taskAction], "test")).rejects.toThrow("power loss");
  h.store.fault = undefined;
  // Meanwhile a person edits the same structured file by hand.
  const edited = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  edited.habits[0].title = "手改的习惯";
  fs.writeFileSync(registryPath, JSON.stringify(edited, null, 2) + "\n", "utf8");
  const editedBytes = fs.readFileSync(registryPath, "utf8");
  await h.restart();
  // No rollback and no mixed view: the edit stays, the operation is recorded as a conflict.
  expect(fs.readFileSync(registryPath, "utf8")).toBe(editedBytes);
  expect(
    h.store.db
      .prepare("SELECT status,error_code FROM events WHERE kind='business' ORDER BY rowid DESC LIMIT 1")
      .get(),
  ).toMatchObject({ status: "conflict", error_code: "RECOVERY_CONFLICT" });
  // Reads still work on the user's own text, and the pending review is visible.
  expect(h.store.registry().habits).toHaveLength(1);
  expect(h.store.registry().habits[0].title).toBe("手改的习惯");
  const inventory = recoveryInventory(h.store);
  expect(inventory.review_required.join(" ")).toContain("外部改动");
  expect(inventory.conflicts).toHaveLength(1);
  expect(h.store.db.prepare("SELECT count(*) n FROM events WHERE status='applied' AND kind='business'").get()).toMatchObject({ n: 1 });
});

it("reordered optional state fields remain recoverable after an interrupted patch", async () => {
  const h = setup();
  h.store.commit("old-order", "test", "test", (_r, load) => {
    load("2026-12-01").assistance = {
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
      load("2026-12-01").assistance = {
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
  expect(h.store.day("2026-12-01").assistance?.status).toBe("failed");
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
    JSON.parse(
      fs.readFileSync(
        store.files.resolve(".agent/context/facts.json", "internal"),
        "utf8",
      ),
    ).facts.map((f: any) => f.content),
  ).toContain("提醒保持简单。");
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
  // Windows junctions can only be created while the target exists; removing the
  // target afterwards produces the same dangling link the check must refuse.
  fs.mkdirSync(path.join(outside, "missing"));
  fs.symlinkSync(
    path.join(outside, "missing"),
    path.join(h.root, "03. Manual/dangling"),
    process.platform === "win32" ? "junction" : "dir",
  );
  fs.rmdirSync(path.join(outside, "missing"));
  expect(() => h.store.files.resolve("03. Manual/dangling/new.md")).toThrow(
    "符号链接",
  );
  expect(fs.existsSync(path.join(outside, "missing/new.md"))).toBe(false);
});

it("E03 a crash halfway through a two-file commit completes the same operation on restart", async () => {
  const h = setup();
  let writes = 0;
  h.store.fault = (stage) => {
    if (stage.startsWith("file:") && ++writes === 1) throw new Error("power loss");
  };
  expect(() =>
    h.store.commit("multi-e03", "test", "test", (_r, load) => {
      load("2026-12-01").assistance = { status: "running", revision: 1, attempts: 1 };
      load("2026-12-02").assistance = { status: "running", revision: 1, attempts: 1 };
      return { ids: [], message: "fixture" };
    }),
  ).toThrow("power loss");
  h.store.fault = undefined;
  // The crash happened after one replacement; the operation stays unresolved
  // until recovery finishes it, so no reader may treat it as committed.
  expect(
    h.store.db
      .prepare("SELECT status FROM events WHERE dedupe_key='multi-e03' ORDER BY rowid DESC LIMIT 1")
      .get(),
  ).toMatchObject({ status: "prepared" });
  await h.restart();
  // Recovery finishes the same operation instead of publishing a mixed state.
  expect(h.store.day("2026-12-01").assistance?.status).toBe("running");
  expect(h.store.day("2026-12-02").assistance?.status).toBe("running");
  expect(
    h.store.db.prepare("SELECT status FROM events WHERE dedupe_key='multi-e03' ORDER BY rowid DESC LIMIT 1").get(),
  ).toMatchObject({ status: "applied" });
});

it("E03 a crash after the files were written only re-publishes the applied marker", async () => {
  const h = setup();
  const before = h.store.registry().revision;
  h.store.fault = (stage) => {
    if (stage === "files_applied") throw new Error("power loss");
  };
  expect(() =>
    h.store.commit("marker-e03", "test", "test", (_r, load) => {
      load("2026-12-01").assistance = { status: "running", revision: 1, attempts: 1 };
      return { ids: [], message: "fixture" };
    }),
  ).toThrow("power loss");
  h.store.fault = undefined;
  await h.restart();
  expect(h.store.day("2026-12-01").assistance?.status).toBe("running");
  expect(
    h.store.db.prepare("SELECT status FROM events WHERE dedupe_key='marker-e03' ORDER BY rowid DESC LIMIT 1").get(),
  ).toMatchObject({ status: "applied" });
  expect(h.store.registry().revision).toBeGreaterThanOrEqual(before);
});
