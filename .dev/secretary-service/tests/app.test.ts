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
import fs from "node:fs";
import { Store, restoreData } from "../apps/core/store.js";
import { loadConfig } from "../apps/core/config.js";
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
it("unknown command fields are rejected rather than silently stripped before execution",async()=>{
  const h=await setup();
  const response=await h.app.inject({method:"POST",url:"/api/v1/commands",headers:h.headers(),payload:{...taskAction,unrecognized_next_action:"必须不能被静默丢弃"}});
  expect(response.statusCode).toBe(400);
  expect(h.store.registry().tasks).toHaveLength(0);
});
it("T36 authenticated export restores exact Markdown, attachments and private rules into a separate empty vault", async () => {
  const h = await setup(),
    text = "# 原文\r\n\r\n这不是数据库全文。\r\n";
  atomicWrite(h.store.files.resolve("03. Manual/exact.md"), text);
  const image = Buffer.from([0, 255, 17, 42]);
  atomicWrite(h.store.files.resolve("Attachment/a.bin", "attachment"), image);
  atomicWrite(
    h.store.files.resolve(".agent/data/do-not-export.secret", "internal"),
    "secret-exclusion-fixture",
  );
  atomicWrite(
    h.store.files.resolve(".agent/prompts/persona.md", "internal"),
    "私人角色覆盖：只按原文汇报。\n",
  );
  await h.core.execute(
    {
      id: "rule-export",
      channel: "web",
      actor_ref: "user",
      external_id: "rule-export",
      text: "停止主动联系",
      occurred_at: h.store.now(),
    },
    [
      {
        type: "set_personal_rule",
        key: "contact.enabled",
        value: false,
        expected_rules_revision: 0,
      },
    ],
    "export-rule",
    true,
  );
  expect((await h.app.inject({ url: "/api/v1/export" })).statusCode).toBe(401);
  const result = await h.app.inject({
    url: "/api/v1/export",
    headers: h.headers(),
  });
  expect(result.statusCode).toBe(200);
  expect(result.headers["content-disposition"]).toContain("attachment");
  expect(result.body).not.toContain("secret-exclusion-fixture");
  expect(result.json().files.some((entry:{path:string})=>/\.sqlite(?:-|$)/.test(entry.path))).toBe(false);
  const target = temporary();
  let restored: Store | undefined;
  cleanups.push(async () => {
    await restored?.close();
    removeTemporary(target);
  });
  restoreData(target, result.json());
  restored = new Store(target, loadConfig(target));
  expect(restored.files.read("03. Manual/exact.md")).toBe(text);
  expect(
    fs.readFileSync(restored.files.resolve("Attachment/a.bin", "attachment")),
  ).toEqual(image);
  expect(
    restored.registry().user_rules?.find((x) => x.key === "contact.enabled")
      ?.value,
  ).toBe(false);
  expect(
    restored.files
      .readBytes(".agent/prompts/persona.md", "internal")
      .toString("utf8"),
  ).toBe("私人角色覆盖：只按原文汇报。\n");
  expect(restored.recoveryUntil).toBeTruthy();
  expect(
    restored.db.prepare("SELECT count(*) n FROM inbox").get(),
  ).toMatchObject({ n: 0 });
});
it("real one-second background polling queues ten due subscriptions within the five-second local timing target", async () => {
  const root = temporary(),
    instance = await createApp({
      vault: root,
      passwordHash: passwordHash("timing-test-password"),
      sessionKey: "timing-test-key",
      origin: "http://localhost:3180",
      secure: false,
      env: {},
    });
  cleanups.push(async () => {
    await instance.app.close();
    removeTemporary(root);
  });
  const due = new Date(Date.now() + 2000).toISOString();
  await instance.core.execute(
    {
      id: "timing",
      channel: "web",
      actor_ref: "user",
      external_id: "timing",
      text: "提醒测试",
      occurred_at: instance.store.now(),
    },
    Array.from({ length: 10 }, (_, n) => ({
      type: "create_automation",
      kind: "one_shot",
      title: "timing" + n,
      due_at: due,
    })),
    "timing",
    true,
  );
  await expect
    .poll(
      () => {
        const rows = instance.store.db
          .prepare(
            "SELECT source_versions_json FROM outbox WHERE counts_as_proactive=1",
          )
          .all() as any[];
        return new Set(
          rows.flatMap((row) =>
            Object.keys(JSON.parse(row.source_versions_json)).filter((k) =>
              k.startsWith("occ:"),
            ),
          ),
        ).size;
      },
      { timeout: 7000, interval: 100 },
    )
    .toBe(10);
  const rows = instance.store.db
      .prepare(
        "SELECT source_versions_json,created_at FROM outbox WHERE counts_as_proactive=1",
      )
      .all() as any[],
    delays = rows
      .flatMap((row) =>
        Object.keys(JSON.parse(row.source_versions_json))
          .filter((k) => k.startsWith("occ:"))
          .map(() => Date.parse(row.created_at) - Date.parse(due)),
      )
      .sort((a, b) => a - b);
  expect(delays.length).toBe(10);
  expect(delays[Math.ceil(delays.length * 0.95) - 1]).toBeLessThanOrEqual(5000);
}, 12000);
it("T36 legacy auxiliary state round-trips without weakening registry or daily revision checks", async () => {
  const h = await setup(),
    auxiliary = ".agent/state/legacy-channel.json",
    text = '{"schema_version":1,"app_id":"old-app","user_id":"old-user","bound_at":"2026-01-01T00:00:00Z"}\r\n';
  atomicWrite(h.store.files.resolve(auxiliary, "internal"), text);
  const bundle = h.store.exportData(), target = temporary();
  cleanups.push(async () => removeTemporary(target));
  restoreData(target, bundle);
  expect(fs.readFileSync(target + "/" + auxiliary, "utf8")).toBe(text);

  const invalidDay = JSON.stringify({ schema_version: 1, business_date: "2026-10-23" });
  const invalidRegistry = JSON.stringify({ ...h.store.registry(), revision: undefined });
  for (const [relative, content] of [
    [bundle.storage.day_records + "/2026-10-23.json", invalidDay],
    [bundle.storage.registry, invalidRegistry],
    [auxiliary, JSON.stringify({ schema_version: 1, revision: "wrong" })],
  ]) {
    const empty = temporary();
    cleanups.push(async () => removeTemporary(empty));
    const malformed = {
      ...bundle,
      files: [...bundle.files.filter((x) => x.path !== relative),
        { path: relative, encoding: "utf8", content, hash: hash(content) }],
    };
    expect(() => restoreData(empty, malformed)).toThrow("状态格式不兼容");
    expect(fs.readdirSync(empty)).toHaveLength(0);
  }
});
it("T36 restore validates the entire package before writing and refuses occupied or escaping destinations", async () => {
  const h = await setup(),
    bundle = h.store.exportData(),
    target = temporary();
  cleanups.push(async () => removeTemporary(target));
  const malicious = {
    ...bundle,
    files: [
      ...bundle.files,
      { path: "../escape.md", encoding: "utf8", content: "x", hash: hash("x") },
    ],
  };
  expect(() => restoreData(target, malicious)).toThrow();
  expect(fs.readdirSync(target)).toHaveLength(0);
  atomicWrite(target + "/keep.md", "keep");
  expect(() => restoreData(target, bundle)).toThrow("空数据目录");
  expect(fs.readFileSync(target + "/keep.md", "utf8")).toBe("keep");
});
it("typed HTTP commands accept persistent rules and automation while enforcing current revisions", async () => {
  const h = await setup();
  const send = (payload: unknown) =>
    h.app.inject({
      method: "POST",
      url: "/api/v1/commands",
      headers: h.headers(),
      payload: payload as any,
    });
  expect(
    (
      await send({
        type: "set_personal_rule",
        key: "planning.evening_time",
        value: "20:00",
        expected_rules_revision: 0,
      })
    ).statusCode,
  ).toBe(200);
  const stale = await send({
    type: "set_personal_rule",
    key: "planning.evening_time",
    value: "19:00",
    expected_rules_revision: 0,
  });
  expect(stale.statusCode).toBe(409);
  const reminder = await send({
    type: "create_automation",
    kind: "one_shot",
    title: "API Hello",
    body: "Hello",
    delay_seconds: 30,
  });
  expect(reminder.statusCode, reminder.body).toBe(200);
  expect(reminder.json().message).toContain("提醒已保存");
  expect(
    (
      await send({
        type: "control_automation",
        target_id: reminder.json().updated_ids[0],
        control: "stop",
      })
    ).statusCode,
  ).toBe(400);
});
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
                artifact_check: { kind: "exists_nonempty" },
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
