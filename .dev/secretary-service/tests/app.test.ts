import { afterEach, describe, it, expect } from "vitest";
import { createApp } from "../apps/core/app.js";
import { passwordHash } from "../apps/core/auth.js";
import {
  temporary,
  removeTemporary,
  habitAction,
  taskAction,
} from "./helpers.js";
import { id, hash, atomicWrite } from "../apps/core/files.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function setup() {
  const root = temporary();
  const instance = await createApp({
    vault: root,
    passwordHash: passwordHash("test-password-123"),
    sessionKey: "test-signing-key",
    origin: "http://localhost:3180",
    secure: false,
    timers: false,
    env: {},
  });
  cleanups.push(async () => {
    await instance.app.close();
    removeTemporary(root);
  });
  const login = await instance.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: "http://localhost:3180" },
    payload: { password: "test-password-123" },
  });
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies[0].name + "=" + login.cookies[0].value;
  const headers = () => ({
    cookie,
    origin: "http://localhost:3180",
    "idempotency-key": id("request"),
  });
  return { ...instance, root, headers };
}
describe("Web API and diary integration", () => {
  it("mixed tool verification saves a user checkbox as pending feedback without falsely completing the task or breaking recovery", async () => {
    const h = await setup(),
      input = {
        id: "mixed-tool",
        channel: "web",
        actor_ref: "user",
        external_id: "mixed-tool",
        text: "明确创建报告任务",
        occurred_at: h.store.now(),
      },
      task = await h.core.execute(
        input,
        [
          {
            ...taskAction,
            title: "报告",
            acceptance: [
              {
                id: "review",
                kind: "check",
                description: "自己确认",
                verification: "self_report",
              },
              {
                id: "file",
                kind: "artifact",
                description: "存在交付文件",
                verification: "tool",
                artifact_ref: "03. Manual/report.md",
              },
            ],
          },
        ],
        "task",
      );
    const daily = await h.core.newPeriod("daily", "2026-10-23");
    await h.core.saveDocument(
      daily.path,
      h.store.document(daily.path).hash,
      "# 任务\n- [ ] 报告\n# 随笔\n原文\n",
      "prepare-checkbox",
    );
    await h.core.execute(
      { ...input, id: "bind-mixed" },
      [
        {
          type: "link_diary",
          target_id: task.updated_ids[0],
          path: daily.path,
          label: "报告",
        },
      ],
      "bind",
    );
    const before = h.store.document(daily.path);
    await h.core.saveDocument(
      daily.path,
      before.hash,
      before.content.replace("[ ]", "[x]"),
      "claim-complete",
    );
    expect(h.store.registry().tasks[0].status).toBe("in_progress");
    expect(h.store.registry().tasks[0].progress.verification_pending).toBe(
      true,
    );
    h.core.recoverPending();
    expect(h.store.files.read(daily.path)).toContain("- [x] 报告");
    await expect(
      h.core.execute(
        { ...input, id: "verify-missing" },
        [{ type: "complete_task", target_id: task.updated_ids[0] }],
        "verify",
      ),
    ).rejects.toMatchObject({ code: "VERIFICATION_PENDING" });
    atomicWrite(h.store.files.resolve("03. Manual/report.md"), "实际交付文件");
    await h.core.execute(
      { ...input, id: "verify-file" },
      [{ type: "complete_task", target_id: task.updated_ids[0] }],
      "verify",
    );
    expect(h.store.registry().tasks[0].status).toBe("done");
    expect(h.store.registry().tasks[0].progress.verification_pending).toBe(
      false,
    );
  });
  it("login limits failed guesses without rate-limiting successful sessions", async () => {
    const h = await setup();
    for (let i = 0; i < 6; i++) {
      const success = await h.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: "http://localhost:3180" },
        payload: { password: "test-password-123" },
      });
      expect(success.statusCode).toBe(200);
    }
    for (let i = 0; i < 5; i++) {
      const bad = await h.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: "http://localhost:3180" },
        payload: { password: "incorrect" },
      });
      expect(bad.statusCode).toBe(401);
    }
    const blocked = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:3180" },
      payload: { password: "incorrect" },
    });
    expect(blocked.statusCode).toBe(429);
  });
  it("OpenAPI describes registered routes and validates mutation shape before filesystem work", async () => {
    const h = await setup();
    const specification = await h.app.inject({
      url: "/api/v1/openapi.json",
      headers: h.headers(),
    });
    expect(specification.statusCode).toBe(200);
    expect(
      specification.json().paths["/api/v1/documents/rename"].post,
    ).toBeDefined();
    const bad = await h.app.inject({
      method: "POST",
      url: "/api/v1/documents/rename",
      headers: h.headers(),
      payload: { path: "03. Manual/missing.md" },
    });
    expect(bad.statusCode).toBe(400);
    const period = await h.app.inject({
      method: "POST",
      url: "/api/v1/documents",
      headers: h.headers(),
      payload: { kind: "daily", date: "2026-10-23" },
    });
    expect(period.statusCode).toBe(200);
    expect(period.json().created).toHaveLength(5);
  });
  it("D07 deleting a display row unlinks it without cancelling the habit", async () => {
    const h = await setup();
    const input = {
      id: "create-unlink",
      channel: "web",
      actor_ref: "user",
      external_id: "create-unlink",
      text: "创建习惯",
      occurred_at: h.store.now(),
    };
    const habit = await h.core.execute(
      input,
      [{ ...habitAction, title: "早起" }],
      "create",
    );
    const note = await h.core.newPeriod("daily", "2026-10-23"),
      document = h.store.document(note.path);
    expect(document.content).toContain("- [ ] 早起");
    await h.core.saveDocument(
      note.path,
      document.hash,
      document.content.replace(/^- \[ \] 早起\r?\n/m, ""),
      "remove-habit-row",
    );
    expect(
      h.store
        .registry()
        .diary_links.some(
          (link) => link.target_ref.id === habit.updated_ids[0],
        ),
    ).toBe(false);
    expect(h.store.registry().habits[0].status).toBe("active");
  });
  it("document save retries return the first result and reject a reused key with different content", async () => {
    const h = await setup();
    await h.app.inject({
      method: "POST",
      url: "/api/v1/documents",
      headers: h.headers(),
      payload: { path: "03. Manual/retry.md", content: "before" },
    });
    const document = h.store.document("03. Manual/retry.md"),
      headers = h.headers(),
      payload = {
        path: document.path,
        base_hash: document.hash,
        content: "after",
      };
    const first = await h.app.inject({
      method: "PUT",
      url: "/api/v1/documents",
      headers,
      payload,
    });
    const second = await h.app.inject({
      method: "PUT",
      url: "/api/v1/documents",
      headers,
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().version).toBe(first.json().version);
    const changed = await h.app.inject({
      method: "PUT",
      url: "/api/v1/documents",
      headers,
      payload: { ...payload, content: "other" },
    });
    expect(changed.statusCode).toBe(409);
    expect(h.store.files.read(document.path)).toBe("after");
  });
  it("A04 rejects anonymous requests and cross-origin writes", async () => {
    const h = await setup();
    expect((await h.app.inject("/api/v1/tree")).statusCode).toBe(401);
    const result = await h.app.inject({
      method: "POST",
      url: "/api/v1/documents",
      headers: { ...h.headers(), origin: "https://evil.invalid" },
      payload: { path: "03. Manual/a.md", content: "x" },
    });
    expect(result.statusCode).toBe(403);
    expect(h.store.files.list()).toHaveLength(0);
  });
  it("D01 saves exact Markdown without copying it into SQLite", async () => {
    const h = await setup(),
      content = "# 我的笔记\r\n\r\n独有正文SECRET-BODY-8492\r\n";
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/documents",
      headers: h.headers(),
      payload: { path: "03. Manual/a.md", content },
    });
    expect(res.statusCode).toBe(200);
    expect(h.store.files.read("03. Manual/a.md")).toBe(content);
    const tables = h.store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    for (const table of tables) {
      const rows = h.store.db.prepare("SELECT * FROM " + table.name).all();
      expect(JSON.stringify(rows)).not.toContain("SECRET-BODY-8492");
    }
  });
  it("D02 rejects stale save and retains both server checkbox and user draft", async () => {
    const h = await setup();
    await h.app.inject({
      method: "POST",
      url: "/api/v1/documents",
      headers: h.headers(),
      payload: { path: "03. Manual/a.md", content: "old" },
    });
    const original = h.store.document("03. Manual/a.md");
    await h.core.saveDocument(
      original.path,
      original.hash,
      "updated server",
      "save-one",
    );
    const stale = await h.app.inject({
      method: "PUT",
      url: "/api/v1/documents",
      headers: h.headers(),
      payload: {
        path: original.path,
        base_hash: original.hash,
        content: "my draft",
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(h.store.files.read(original.path)).toBe("updated server");
  });
  it("A02 blocks hidden files, traversal and absolute paths", async () => {
    const h = await setup();
    for (const p of [
      ".agent/config.json",
      "../outside.md",
      "C:/secret.md",
      "03. Manual/../../secret.md",
    ]) {
      const result = await h.app.inject({
        url: "/api/v1/documents?path=" + encodeURIComponent(p),
        headers: h.headers(),
      });
      expect(result.statusCode).toBe(403);
    }
  });
  it("D08 projects only a bound checkbox, preserving narrative and line endings", async () => {
    const h = await setup(),
      input = {
        id: "create",
        channel: "web",
        actor_ref: "user",
        external_id: "create",
        text: "创建习惯",
        occurred_at: h.store.now(),
      };
    const result = await h.core.execute(input, [habitAction], "habit");
    const daily = await h.core.newPeriod("daily", "2026-10-23"),
      before =
        "---\r\ntype: daily\r\n---\r\n# 习惯\r\n- [ ] 英语\r\n# 禅\r\n自己的原始想法\r\n```md\r\n- [ ] 英语\r\n```\r\n";
    await h.core.saveDocument(
      daily.path,
      h.store.document(daily.path).hash,
      before,
      "set-body",
    );
    await h.core.execute(
      { ...input, id: "bind" },
      [
        {
          type: "link_diary",
          target_id: result.updated_ids[0],
          path: daily.path,
          label: "英语",
        },
      ],
      "bind",
    );
    await h.core.execute(
      { ...input, id: "feedback" },
      [
        {
          type: "report_habit",
          target_id: result.updated_ids[0],
          business_date: "2026-10-23",
          status: "did",
        },
      ],
      "feedback",
    );
    expect(h.store.files.read(daily.path)).toBe(
      before.replace("- [ ] 英语", "- [x] 英语"),
    );
  });
});
