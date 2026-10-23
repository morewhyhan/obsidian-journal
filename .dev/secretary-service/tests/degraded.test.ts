import fs from "node:fs";
import path from "node:path";
import { afterEach, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { harness, habitAction } from "./helpers.js";
import { Store } from "../apps/core/store.js";
import { loadConfig } from "../apps/core/config.js";
import { Scheduler } from "../apps/core/scheduler.js";
import { atomicWrite } from "../apps/core/files.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0)) await fn();
});
function setup() {
  const h = harness();
  cleanup.push(() => h.close());
  return h;
}
it("SQLite unavailable: plain body saving continues while a bound checkbox change stays unsaved", async () => {
  const h = setup();
  await h.run(habitAction);
  const day = await h.core.newPeriod("daily", "2026-10-23"),
    before = h.store.document(day.path);
  h.store.db.close();
  const content = before.content + "\n自己的原文";
  const saved = await h.core.saveDocument(
    day.path,
    before.hash,
    content,
    "body-only",
  );
  expect(saved.hash).toBe(h.store.document(day.path).hash);
  expect(h.store.files.read(day.path)).toBe(content);
  await expect(
    h.core.saveDocument(
      day.path,
      saved.hash,
      content.replace("- [ ] 英语", "- [x] 英语"),
      "checkbox",
    ),
  ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  expect(h.store.files.read(day.path)).toBe(content);
});
it("B04 old channel deliveries are suppressed after a lost database, while a new pause is accepted", async () => {
  const h = setup();
  await h.run(habitAction);
  await h.store.close();
  fs.unlinkSync(path.join(h.root, ".agent/data/state.sqlite"));
  h.advance(120000);
  await h.restart();
  const old = {
    ...h.input("今天不提醒了"),
    channel: "qq",
    occurred_at: "2026-10-23T12:00:00Z",
  };
  await expect(h.core.receive(old)).rejects.toMatchObject({
    code: "INPUT_REPLAY_SUPPRESSED",
  });
  expect(h.store.registry().controls).toHaveLength(0);
  await h.core.receive({ ...h.input("今天不提醒了"), channel: "qq" });
  expect(h.store.registry().controls).toHaveLength(1);
});
it("an unsupported schema version is refused without modifying its metadata or state", async () => {
  const h = setup();
  await h.run(habitAction);
  h.store.db.prepare("UPDATE schema_meta SET version=2").run();
  const before = fs.readFileSync(
    path.join(h.root, ".agent/state/registry.json"),
    "utf8",
  );
  await h.store.close();
  expect(() => new Store(h.root, loadConfig(h.root))).toThrow("运行库版本");
  const check = new Database(path.join(h.root, ".agent/data/state.sqlite"), {
    readonly: true,
  });
  expect(check.prepare("SELECT version FROM schema_meta").get()).toMatchObject({
    version: 2,
  });
  check.close();
  expect(
    fs.readFileSync(path.join(h.root, ".agent/state/registry.json"), "utf8"),
  ).toBe(before);
});
it("a pending business write is recovered before any new scheduler dispatch", async () => {
  const h = setup(),
    created = await h.run([
      habitAction,
      { ...habitAction, title: "另一个习惯" },
    ]),
    target = created.updated_ids[0];
  h.store.fault = (stage) => {
    if (stage === "file:.agent/state/registry.json")
      throw new Error("incomplete write");
  };
  await expect(
    h.run([
      { type: "update_habit", target_id: target, min_behavior: "新的最小行为" },
      {
        type: "report_habit",
        target_id: target,
        business_date: "2026-10-23",
        status: "did",
      },
    ]),
  ).rejects.toThrow("incomplete write");
  const original = fs.renameSync.bind(fs);
  const failing = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to).endsWith("2026-10-23.json"))
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return original(from, to);
  });
  let sends = 0;
  const scheduler = new Scheduler(
    h.core,
    {
      health: () => ({ connected: true, lastEventAt: null }),
      send: async () => {
        sends++;
        return { status: "sent", externalId: "fixture" };
      },
    },
    "user",
  );
  await scheduler.tick();
  expect(sends).toBe(0);
  expect(scheduler.lastError).not.toBeNull();
  failing.mockRestore();
  h.store.fault = undefined;
  await scheduler.tick();
  expect(sends).toBe(1);
  expect(
    h.store.db
      .prepare(
        "SELECT count(*) AS n FROM events WHERE kind='business' AND status='prepared'",
      )
      .get(),
  ).toMatchObject({ n: 0 });
});
it("failed atomic replacement retains the old body and never reports a successful save", async () => {
  const h = setup(),
    relative = "03. Manual/disk.md";
  atomicWrite(h.store.files.resolve(relative), "old exact body");
  const before = h.store.document(relative),
    original = fs.renameSync.bind(fs);
  const replacement = vi
    .spyOn(fs, "renameSync")
    .mockImplementation((from, to) => {
      if (String(to) === h.store.files.resolve(relative))
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return original(from, to);
    });
  await expect(
    h.core.saveDocument(relative, before.hash, "new unsaved body", "disk-full"),
  ).rejects.toThrow("disk full");
  expect(h.store.files.read(relative)).toBe("old exact body");
  replacement.mockRestore();
  const saved = await h.core.saveDocument(
    relative,
    before.hash,
    "new unsaved body",
    "disk-full",
  );
  expect(saved.content).toBe("new unsaved body");
});
it("A02 template customization cannot read through a symlink to another directory", async () => {
  const h = setup();
  fs.symlinkSync(
    path.join(h.root, ".agent"),
    path.join(h.root, "Template"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(h.core.newPeriod("daily", "2026-10-23")).rejects.toMatchObject({
    code: "PATH_FORBIDDEN",
  });
  expect(fs.existsSync(path.join(h.root, "01. Daily"))).toBe(false);
});
it("a readable but read-only runtime database cannot prevent saving plain Markdown", async () => {
  const h = setup(),
    relative = "03. Manual/readonly-db.md";
  atomicWrite(h.store.files.resolve(relative), "before");
  const current = h.store.document(relative);
  h.store.db.close();
  h.store.db = new Database(path.join(h.root, ".agent/data/state.sqlite"), {
    readonly: true,
  });
  const saved = await h.core.saveDocument(
    relative,
    current.hash,
    "after",
    "read-only-db",
  );
  expect(saved.content).toBe("after");
  expect(saved.runtime_degraded).toBe(true);
  expect(h.store.files.read(relative)).toBe("after");
});
