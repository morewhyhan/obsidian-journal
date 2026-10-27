import { afterEach, expect, it } from "vitest";
import { harness, temporary, removeTemporary, taskAction } from "./helpers.js";
import { Store } from "../apps/core/store.js";
import { loadConfig } from "../apps/core/config.js";
import { Lifecycle } from "../apps/core/lifecycle.js";
import { effectivePolicy } from "../apps/core/policy.js";
import { createApp } from "../apps/core/app.js";
import { passwordHash } from "../apps/core/auth.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

it("lifecycle only accepts declared transitions and repeating a state is not an event", () => {
  const state = new Lifecycle();
  expect(state.current).toBe("starting");
  state.set("recovering");
  state.set("migrating");
  state.set("ready");
  expect(state.acceptsWork()).toBe(true);
  expect(state.acceptsBackground()).toBe(true);
  state.degrade("RECOVERY_GUARD_ACTIVE");
  expect(state.snapshot()).toMatchObject({
    state: "degraded",
    reasons: ["RECOVERY_GUARD_ACTIVE"],
    accepts_work: true,
    accepts_background: false,
  });
  expect(() => state.set("ready")).not.toThrow();
  expect(state.degradedReasons).toEqual([]);
  state.set("draining");
  expect(() => state.set("ready")).toThrow(/不允许该迁移/);
  expect(() => state.degrade("LATE")).toThrow(/不能降级/);
  state.set("stopped");
  expect(() => state.set("ready")).toThrow(/不允许该迁移/);
  expect(state.set("stopped")).toBe("stopped");
});

it("degraded keeps serving business writes but refuses background and new input once draining", async () => {
  const h = harness("2026-10-27T02:00:00Z");
  cleanups.push(() => h.close());
  expect(h.store.lifecycle).toBe("ready");
  h.store.updateRuntimeMeta((meta) => ({
    ...meta,
    recovery_guard: { active: true, reason: "RUNTIME_REBUILT" },
  }));
  h.store.state.degrade("RECOVERY_GUARD_ACTIVE");
  const created = await h.run(taskAction);
  expect(created.updated_ids.length).toBe(1);
  expect(effectivePolicy(h.store).capabilities.business_write).toBe(true);
  expect(effectivePolicy(h.store).capabilities.background_write).toBe(false);
  expect(effectivePolicy(h.store).capabilities.contact).toBe(false);
  expect(h.store.state.acceptsBackground()).toBe(false);
  h.store.state.set("draining");
  await expect(h.core.receive(h.input())).rejects.toMatchObject({
    code: "RUNTIME_NOT_READY",
    status: 503,
  });
  await expect(h.run(taskAction)).rejects.toMatchObject({
    code: "CAPABILITY_BLOCKED",
    status: 403,
  });
});

it("restart enters degraded from the persisted recovery guard instead of claiming ready", async () => {
  const h = harness("2026-10-27T03:00:00Z");
  cleanups.push(() => h.close());
  h.store.updateRuntimeMeta((meta) => ({
    ...meta,
    recovery_guard: { active: true, reason: "RUNTIME_REBUILT" },
  }));
  await h.restart();
  expect(h.store.lifecycle).toBe("degraded");
  expect(h.store.state.degradedReasons).toContain("RECOVERY_GUARD_ACTIVE");
  expect(h.store.state.acceptsBackground()).toBe(false);
  expect((await h.run(taskAction)).updated_ids.length).toBe(1);
});

it("maintenance round trips keep the degraded reasons that caused them", async () => {
  const h = harness("2026-10-27T04:00:00Z");
  cleanups.push(() => h.close());
  h.store.state.degrade("REPLAY_WINDOW_OPEN");
  h.store.state.set("maintenance");
  h.store.state.set("degraded");
  expect(h.store.state.snapshot().reasons).toEqual(["REPLAY_WINDOW_OPEN"]);
  expect(h.store.state.acceptsBackground()).toBe(false);
});

it("a stopped store refuses writes and vault access instead of serving stale state", async () => {
  const root = temporary();
  const store = new Store(root, loadConfig(root), () => new Date("2026-10-27T05:00:00Z"));
  await store.close();
  expect(store.lifecycle).toBe("stopped");
  await expect(store.exclusive(() => 1)).rejects.toMatchObject({
    code: "INSTANCE_LOCKED",
  });
  expect(() => store.files.read(".agent/context/memory.md")).toThrow(
    /写锁已失效/,
  );
  expect(() => store.files.read("01. Daily/2026-10-27.md")).toThrow(
    /写锁已失效/,
  );
  removeTemporary(root);
});

it("readyz reports lifecycle state and stops reporting ready while draining", async () => {
  const root = temporary();
  const app = await createApp({
    vault: root,
    passwordHash: passwordHash("lifecycle-password-123"),
    sessionKey: "lifecycle-signing-key",
    origin: "http://localhost:3180",
    secure: false,
    timers: false,
    env: {},
  });
  cleanups.push(async () => {
    await app.app.close();
    removeTemporary(root);
  });
  const ready = await app.app.inject({ method: "GET", url: "/readyz" });
  expect(ready.statusCode).toBe(200);
  expect(ready.json()).toMatchObject({ ready: true, state: "ready" });
  app.store.state.degrade("RECOVERY_GUARD_ACTIVE");
  const degraded = await app.app.inject({ method: "GET", url: "/readyz" });
  expect(degraded.statusCode).toBe(200);
  expect(degraded.json()).toMatchObject({
    ready: true,
    state: "degraded",
    reasons: ["RECOVERY_GUARD_ACTIVE"],
  });
  app.store.state.set("draining");
  const draining = await app.app.inject({ method: "GET", url: "/readyz" });
  expect(draining.statusCode).toBe(503);
  expect(draining.json()).toMatchObject({
    ready: false,
    state: "draining",
    accepts_work: false,
  });
});
