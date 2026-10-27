import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createApp } from "../apps/core/app.js";
import { passwordHash } from "../apps/core/auth.js";
import { atomicWrite } from "../apps/core/files.js";
import { temporary, removeTemporary } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup() {
  const root = temporary();
  cleanups.push(async () => removeTemporary(root));
  const h = await createApp({
    vault: root,
    passwordHash: passwordHash("fixture"),
    sessionKey: "fixture-signing",
    origin: "http://localhost",
    secure: false,
    timers: false,
    env: { SECRETARY_BRIDGE_TOKEN: "fixture-internal" },
  });
  cleanups.push(() => h.app.close());
  h.store.db
    .prepare(
      "INSERT INTO inbox(id,channel,actor_ref,external_id,body,metadata_json,received_at,occurred_at,status) VALUES('active','qq','owner','unique','用户授权操作笔记','{}',?,?, 'processing')",
    )
    .run(h.store.now(), h.store.now());
  const call = async (payload: any, token = "fixture-internal") => {
    const r = await h.app.inject({
      method: "POST",
      url: "/internal/workspace",
      headers: { authorization: "Bearer " + token },
      payload: { input_id: "active", call_id: crypto.randomUUID(), ...payload },
    });
    return { status: r.statusCode, body: r.json() };
  };
  return { ...h, root, call };
}
it("workspace tools do real CRUD, exact editing, search and recoverable delete", async () => {
  const h = await setup();
  const file = "新建目录/测试/说明.md";
  expect(
    (
      await h.call({
        operation: "write",
        path: file,
        content: "# 内容\n旧内容\n",
      })
    ).status,
  ).toBe(200);
  expect((await h.call({ operation: "list" })).body.paths).toContain(file);
  expect(
    (await h.call({ operation: "search", query: "旧内容" })).body.results[0]
      .path,
  ).toBe(file);
  const read = await h.call({ operation: "read", path: file });
  expect(read.body.content).toBe("# 内容\n旧内容\n");
  expect(
    (
      await h.call({
        operation: "edit",
        path: file,
        base_hash: read.body.hash,
        old_text: "旧内容",
        new_text: "新内容",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await h.call({
        operation: "write",
        path: file,
        base_hash: read.body.hash,
        content: "stale",
      })
    ).status,
  ).toBe(409);
  const edited = await h.call({ operation: "read", path: file });
  const moved = await h.call({
    operation: "rename",
    path: file,
    new_path: "03. Manual/测试/改名.md",
    base_hash: edited.body.hash,
  });
  expect(moved.status).toBe(200);
  expect(
    (
      await h.call({
        operation: "delete",
        path: moved.body.path,
        base_hash: moved.body.hash,
      })
    ).status,
  ).toBe(200);
  expect(h.core.documents.listTrash()).toHaveLength(1);
});
it("workspace is request-bound, denies secrets/traversal/symlinks, and only exposes designated memory", async () => {
  const h = await setup();
  expect((await h.call({ operation: "list" }, "wrong")).status).toBe(403);
  expect((await h.call({ operation: "list", input_id: "other" })).status).toBe(
    403,
  );
  for (const p of [
    "../outside.md",
    "/etc/passwd",
    "C:/Users/secret.md",
    ".agent/config.json",
    ".agent/state/registry.json",
    ".agent/prompts/system.md",
    ".git/config",
  ])
    expect((await h.call({ operation: "read", path: p })).status).toBe(403);
  const memory = ".agent/context/memory.md";
  expect(
    (
      await h.call({
        operation: "write",
        path: memory,
        content: "已确认的用户偏好",
      })
    ).status,
  ).toBe(200);
  expect(
    (await h.call({ operation: "read", path: memory })).body.content,
  ).toContain("偏好");
  const outside = temporary();
  cleanups.push(async () => removeTemporary(outside));
  atomicWrite(path.join(outside, "outside.md"), "outside secret");
  fs.mkdirSync(path.join(h.root, "03. Manual"), { recursive: true });
  fs.symlinkSync(
    outside,
    path.join(h.root, "03. Manual/escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(
    (await h.call({ operation: "read", path: "03. Manual/escape/outside.md" }))
      .status,
  ).toBe(403);
  h.store.db
    .prepare(
      "UPDATE inbox SET status='processed', processed_at='2026-10-23T12:00:00Z' WHERE id='active'",
    )
    .run();
  expect((await h.call({ operation: "list" })).status).toBe(403);
});
it("all user phrasings get the same workspace capability without prefetch or a keyword gate", async () => {
  const h = await setup();
  for (const text of [
    "列目录",
    "你给我们当前的目录直接发给我",
    "把仓库目录结构在这里输出给我",
    "你阅读一下我们这个月的计划",
    "你再试一试",
  ]) {
    const ctx = h.core.context({
      id: "x",
      channel: "qq",
      actor_ref: "owner",
      external_id: "x",
      text,
      occurred_at: h.store.now(),
    });
    expect(ctx.workspace.available).toBe(true);
    expect(ctx.documents).toEqual([]);
  }
});
