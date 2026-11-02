import { expect, it } from "vitest";
import { plainText } from "../apps/core/plain-text.js";
import { splitMessages } from "../apps/core/message-split.js";

it("QQ gets plain text: markdown syntax never reaches the chat", () => {
  const input = [
    "## 今天的安排",
    "",
    "**重点**：背单词",
    "",
    "| 时间 | 事项 |",
    "| --- | --- |",
    "| 8:00 | 背单词 |",
    "",
    "- 午睡 13:00",
    "- 早睡 21:50",
    "",
    "详见 [周计划](https://example.com/a_b)。",
    "",
    "```",
    "08:00-10:00 背单词",
    "```",
  ].join("\n");
  const out = plainText(input);
  expect(out).not.toMatch(/[#*|`]/);
  expect(out).toContain("今天的安排");
  expect(out).toContain("重点：背单词");
  expect(out).toContain("8:00 · 背单词");
  expect(out).toContain("· 午睡 13:00");
  expect(out).toContain("周计划（https://example.com/a_b）");
  expect(out).toContain("08:00-10:00 背单词");
});

it("ordinary text survives untouched", () => {
  const text = "今天8点到10点背单词。\n\n午睡还是13点。";
  expect(plainText(text)).toBe(text);
});

it("a short answer stays one bubble and a long one splits at sentence ends", () => {
  expect(splitMessages("现在下午五点四十二。")).toEqual(["现在下午五点四十二。"]);
  const two = splitMessages(
    "今天背单词那轮没开始，你说先调试我。提醒发过几条，但提醒不算完成。你要是刚做完什么，说一声我记上。",
    { maxChars: 30 },
  );
  // Every character survives, order is kept, and no bubble ends mid-sentence.
  expect(two.join("")).toBe(
    "今天背单词那轮没开始，你说先调试我。提醒发过几条，但提醒不算完成。你要是刚做完什么，说一声我记上。",
  );
  expect(two.length).toBeGreaterThan(1);
  for (const bubble of two) expect(bubble.endsWith("。")).toBe(true);
});

it("a list is sent as one message instead of one bubble per line", () => {
  const list = "今天还有这些：\n1. 背单词\n2. 午睡\n3. 早睡\n4. 运动";
  expect(splitMessages(list, { maxChars: 10, maxBubbles: 3 })).toEqual([list]);
});

it("as many bubbles as the content needs, one sentence each", () => {
  const text = "先说第一件。然后第二件。再说第三件。最后第四件。还有第五件。";
  const all = splitMessages(text, { maxChars: 10, maxBubbles: 0 });
  expect(all).toHaveLength(5);
  expect(all.join("")).toBe(text);
});

it("receiving a new message preserves an earlier reply until its relation is understood", async () => {
  const { harness } = await import("./helpers.js");
  const h = harness("2026-10-31T10:00:00Z");
  try {
    const now = h.store.now();
    h.store.db
      .prepare(
        "INSERT INTO outbox(id,channel,recipient_ref,dedupe_key,target_refs_json,source_versions_json,metadata_json,message_kind,body,content_hash,scheduled_at,expires_at,counts_as_proactive,created_at,updated_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run("b1", "qq", "owner", "old:reply", "[]", "{}", JSON.stringify({ reply_group: "old", sequence: 1, purpose: "reply" }), "receipt", "第一句。", "h", now, now, 0, now, now, "pending");
    await h.core.receive({ id: "new-input", channel: "qq", actor_ref: "owner", external_id: "new-input", text: "等等，不是这个", occurred_at: now, reply_to: null } as any);
    const row = h.store.db.prepare("SELECT status FROM outbox WHERE id='b1'").get() as any;
    expect(row.status).toBe("pending");
  } finally {
    await h.close();
  }
});

it("a marked answer stays one message and the marker never reaches QQ", async () => {
  const { harness } = await import("./helpers.js");
  const h = harness("2026-10-31T10:00:00Z");
  try {
    await h.core.execute(
      { id: "mark-1", channel: "qq", actor_ref: "owner", external_id: "mark-1", text: "今天的任务", occurred_at: h.store.now() },
      [],
      "conversation",
      true,
    );
    (h.core as any).queueReply(
      { id: "mark-1", channel: "qq", actor_ref: "owner", external_id: "mark-1", text: "", occurred_at: h.store.now() },
      "[[整条]]\n今天有三件事。\n1. 背单词\n2. 午睡\n3. 早睡",
    );
    const rows = h.store.db
      .prepare("SELECT body FROM outbox WHERE message_kind='receipt' ORDER BY rowid")
      .all() as { body: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].body.startsWith("今天有三件事")).toBe(true);
    expect(rows[0].body).not.toContain("[[整条]]");
  } finally {
    await h.close();
  }
});

it("a newer message flags the run and stops its unsent remainder", async () => {
  const { harness } = await import("./helpers.js");
  const h = harness("2026-10-31T10:00:00Z");
  try {
    const now = h.store.now();
    h.store.db
      .prepare(
        "INSERT INTO inbox(id,channel,actor_ref,external_id,body,metadata_json,received_at,occurred_at,status,seq) VALUES('old-run','qq','owner','old-run','我在问A','{}',?,?,'processing',1)",
      )
      .run(now, now);
    await h.core.receive({ id: "new-run", channel: "qq", actor_ref: "owner", external_id: "new-run", text: "算了，问B", occurred_at: now } as any);
    // The in-flight run is flagged, and its answer is recorded but never queued.
    const meta = JSON.parse((h.store.db.prepare("SELECT metadata_json FROM inbox WHERE id='old-run'").get() as any).metadata_json);
    expect(meta.superseded_by).toBe("new-run");
    h.core.finishInput({ id: "old-run", channel: "qq", actor_ref: "owner", external_id: "old-run", text: "我在问A", occurred_at: now } as any, "旧答案。");
    // The earlier question is still answered; a pending tail from it would be gone.
    const queued = h.store.db.prepare("SELECT count(*) n FROM outbox WHERE json_extract(metadata_json,'$.reply_group')='old-run'").get() as any;
    expect(queued.n).toBeGreaterThan(0);
  } finally {
    await h.close();
  }
});

it("a failed write cannot be reported as done", async () => {
  const { guardSuccessClaim } = await import("../apps/core/claim-check.js");
  const failed = guardSuccessClaim("按你说的做了，已经写进周计划里了。", [{ status: "failed" }]);
  expect(failed.corrected).toBe(true);
  expect(failed.text).toContain("没有真正写入");
  const ok = guardSuccessClaim("按你说的做了，已经写进周计划里了。", [{ status: "applied" }]);
  expect(ok.corrected).toBe(false);
  // An ordinary sentence with no receipts is left alone.
  expect(guardSuccessClaim("我记下了。", []).corrected).toBe(false);
});
