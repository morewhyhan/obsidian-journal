import fs from "node:fs";
import { afterEach, expect, it } from "vitest";
import { harness } from "./helpers.js";
import { applicationCall } from "../apps/core/application.js";
import { atomicWrite } from "../apps/core/files.js";
import { advanceUnderstood, understoodSeq } from "../apps/core/classification.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

it("F01 a forget interrupted after the files were written still clears the legacy note on restart", async () => {
  const h = harness("2026-10-24T09:00:00Z");
  cleanups.push(() => h.close());
  const legacy = "- 用户喜欢蓝封面词汇本\n- 早起在七点前\n";
  atomicWrite(h.store.files.resolve(".agent/context/user.md", "internal"), legacy);
  await h.run({
    type: "remember_fact",
    fact: "用户喜欢蓝封面词汇本",
    kind: "user_confirmed",
    fact_scope: ["学习"],
  } as any);
  const registered = (await import("../apps/core/facts.js")).readFacts(h.store).facts[0];
  expect(registered.content).toContain("蓝封面");

  // The write lands but the process dies before the legacy-note scrub.
  h.store.fault = (stage) => {
    if (stage === "files_applied") throw new Error("power loss");
  };
  await expect(
    h.run({ type: "forget_fact", target_id: registered.id, expected_version: registered.version } as any),
  ).rejects.toThrow("power loss");
  h.store.fault = undefined;

  // Restart runs the pending cleanup without ever storing the forgotten text.
  await h.restart();
  const userNote = fs.readFileSync(h.store.files.resolve(".agent/context/user.md", "internal"), "utf8");
  expect(userNote).not.toContain("蓝封面");
  expect(userNote).toContain("早起在七点前");
  const after = (await import("../apps/core/facts.js")).readFacts(h.store);
  const stored = after.facts.find((f) => f.id === registered.id)!;
  expect(stored.status).toBe("revoked");
  expect(stored.content).toBe("");

  // Normal context must not hand the forgotten text to the model any more.
  h.store.db
    .prepare(
      "INSERT INTO inbox(id,channel,actor_ref,external_id,body,metadata_json,received_at,occurred_at,status) VALUES('ask','qq','owner','ask','hi','{}',?,?,'processing')",
    )
    .run(h.store.now(), h.store.now());
  const prefs: any = await applicationCall(
    h.core,
    { input_id: "ask", call_id: "prefs-after-forget", operation: "preferences", query: "蓝封面" },
    {} as any,
  );
  expect(JSON.stringify(prefs)).not.toContain("蓝封面");
  const context = h.core.context(h.input ? h.input() : ({ id: "ask" } as any)) as any;
  expect(JSON.stringify(context.facts ?? [])).not.toContain("蓝封面");

  // Repeating the forget stays idempotent and reports truthfully.
  await expect(
    h.run({
      type: "forget_fact",
      target_id: registered.id,
      expected_version: stored.version,
    } as any),
  ).resolves.toBeTruthy();
  expect(
    (await import("../apps/core/facts.js")).readFacts(h.store).facts.find((f) => f.id === registered.id)!.status,
  ).toBe("revoked");
});

it("F03 the understood watermark survives maintenance cleanup yet still stops at a real gap", () => {
  const h = harness("2026-10-24T09:00:00Z");
  cleanups.push(() => h.close());
  const insert = h.store.db.prepare(
    "INSERT INTO inbox(id,channel,actor_ref,external_id,body,metadata_json,received_at,occurred_at,status,seq,classification,processed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const now = h.store.now();
  insert.run("i1", "qq", "owner", "i1", "one", "{}", now, now, "processed", 1, "classified", now);
  insert.run("i2", "qq", "owner", "i2", "two", "{}", now, now, "processed", 2, "classified", now);
  h.store.updateRuntimeMeta((meta) => ({ ...meta, understood_seq: 2 }));
  // Maintenance removed the earliest row: recomputing must not fall back to 0.
  h.store.db.prepare("DELETE FROM inbox WHERE id='i1'").run();
  const advanced = advanceUnderstood(h.store);
  expect(advanced).toBe(2);
  expect(understoodSeq(h.store)).toBe(2);

  // A genuinely unclassified newer message still blocks the watermark.
  insert.run("i3", "qq", "owner", "i3", "three", "{}", now, now, "pending", 3, "new", null);
  expect(advanceUnderstood(h.store)).toBe(2);
  insert.run("i4", "qq", "owner", "i4", "four", "{}", now, now, "pending", 4, "classified", null);
  // Contiguity is required: the gap at 3 keeps 4 from advancing the watermark.
  expect(advanceUnderstood(h.store)).toBe(2);
});

it("F01 a normal forget also clears the stored reply and the delivered receipt", async () => {
  const h = harness("2026-10-24T09:00:00Z");
  cleanups.push(() => h.close());
  const now = h.store.now();
  h.store.db
    .prepare(
      "INSERT INTO inbox(id,channel,actor_ref,external_id,body,metadata_json,received_at,occurred_at,status,seq,classification,processed_at) VALUES('src','qq','owner','src','记一下我喜欢蓝封面词汇本','{}',?,?,'processed',1,'classified',?)",
    )
    .run(now, now, now);
  await h.run({
    type: "remember_fact",
    fact: "用户喜欢蓝封面词汇本",
    kind: "user_confirmed",
    fact_scope: ["学习"],
  } as any);
  const fact = (await import("../apps/core/facts.js")).readFacts(h.store).facts[0];
  const sourceId = fact.source.id;
  // Business produces a reply for that message; forget must not leave its text behind.
  h.store.db
    .prepare(
      "INSERT INTO outbox(id,channel,recipient_ref,dedupe_key,target_refs_json,source_versions_json,metadata_json,message_kind,body,content_hash,scheduled_at,expires_at,counts_as_proactive,created_at,updated_at,status,external_id,sent_at,finished_at) VALUES('out1','qq','owner',?,'[]','{}','{}','receipt',?,?,?,?,0,?,?,'sent','ext-1',?,?)",
    )
    .run(sourceId + ":reply", "好的，记下了：蓝封面词汇本。", "h", now, now, now, now, now, now);
  await h.run({ type: "forget_fact", target_id: fact.id, expected_version: fact.version } as any);
  const outbox = h.store.db.prepare("SELECT body FROM outbox WHERE id='out1'").get() as any;
  expect(outbox.body).toBe("");
  const inbox = h.store.db.prepare("SELECT body FROM inbox WHERE id=?").get(sourceId) as any;
  expect(inbox?.body ?? null).toBeNull();
});

it("F01 a crash before the forget was written leaves the fact and the note intact", async () => {
  const h = harness("2026-10-24T09:00:00Z");
  cleanups.push(() => h.close());
  atomicWrite(h.store.files.resolve(".agent/context/user.md", "internal"), "- 用户喜欢蓝封面词汇本\n");
  await h.run({
    type: "remember_fact",
    fact: "用户喜欢蓝封面词汇本",
    kind: "user_confirmed",
    fact_scope: ["学习"],
  } as any);
  const fact = (await import("../apps/core/facts.js")).readFacts(h.store).facts[0];
  h.store.fault = (stage) => {
    if (stage === "prepared") throw new Error("power loss");
  };
  await expect(
    h.run({ type: "forget_fact", target_id: fact.id, expected_version: fact.version } as any),
  ).rejects.toThrow("power loss");
  h.store.fault = undefined;
  // A crash before the commit is durable may either leave the fact untouched or
  // replay it. What must never happen is a half-state: revoked while the note or
  // the retrievable context still carries the text.
  const afterCrash = (await import("../apps/core/facts.js")).readFacts(h.store).facts.find(
    (f) => f.id === fact.id,
  )!;
  const note = () => fs.readFileSync(h.store.files.resolve(".agent/context/user.md", "internal"), "utf8");
  if (afterCrash.status === "active") expect(note()).toContain("蓝封面");
  else expect(note()).not.toContain("蓝封面");
  // A retry must either finish the job or report a version conflict; neither may
  // leave the forgotten text behind in the note.
  await h.run({ type: "forget_fact", target_id: fact.id, expected_version: afterCrash.version } as any).catch(
    (error: any) => expect(["VERSION_CONFLICT", "RECOVERY_CONFLICT"]).toContain(error.code),
  );
  const finalFact = (await import("../apps/core/facts.js")).readFacts(h.store).facts.find(
    (f) => f.id === fact.id,
  )!;
  if (finalFact.status === "revoked") {
    expect(finalFact.content).toBe("");
    expect(note()).not.toContain("蓝封面");
  } else {
    expect(note()).toContain("蓝封面");
  }
});

it("F01 a source still in flight keeps the receipt honest while the note is already clean", async () => {
  const h = harness("2026-10-24T09:00:00Z");
  cleanups.push(() => h.close());
  const now = h.store.now();
  h.store.db
    .prepare(
      "INSERT INTO inbox(id,channel,actor_ref,external_id,body,metadata_json,received_at,occurred_at,status) VALUES('inflight','qq','owner','inflight','记一下蓝封面词汇本','{}',?,?,'processing')",
    )
    .run(now, now);
  atomicWrite(h.store.files.resolve(".agent/context/user.md", "internal"), "- 用户喜欢蓝封面词汇本\n");
  await h.run({
    type: "remember_fact",
    fact: "用户喜欢蓝封面词汇本",
    kind: "user_confirmed",
    fact_scope: ["学习"],
  } as any);
  const fact = (await import("../apps/core/facts.js")).readFacts(h.store).facts[0];
  // Point the fact at the in-flight message: that is the fragment cleanup must wait for.
  const factsPath = h.store.files.resolve(".agent/context/facts.json", "internal");
  const file = JSON.parse(fs.readFileSync(factsPath, "utf8"));
  file.facts[0].source = { ...file.facts[0].source, id: "inflight" };
  atomicWrite(factsPath, JSON.stringify(file));
  await h.run({ type: "forget_fact", target_id: fact.id, expected_version: fact.version } as any);
  // The note is scrubbed from its hash even while the chat fragment waits, but the
  // revocation stays pending so nothing claims a complete erase.
  expect(fs.readFileSync(h.store.files.resolve(".agent/context/user.md", "internal"), "utf8")).not.toContain("蓝封面");
  const pendingRow = h.store.db
    .prepare("SELECT cleanup_state FROM revocations WHERE target_id=?")
    .get(fact.id) as any;
  expect(pendingRow.cleanup_state).toBe("pending");
  // Once the source settles the same cleanup finishes and marks it done.
  h.store.db.prepare("UPDATE inbox SET status='processed',processed_at=? WHERE id='inflight'").run(now);
  const done = h.core.cleanupRevocations();
  expect(done.state).toBe("done");
  expect(
    (h.store.db.prepare("SELECT cleanup_state FROM revocations WHERE target_id=?").get(fact.id) as any)
      .cleanup_state,
  ).toBe("done");
});

it("A imported material is never handed to the model as a confirmed fact, and use is recorded once", async () => {
  const h = harness("2026-10-24T09:00:00Z");
  cleanups.push(() => h.close());
  const now = h.store.now();
  const { appendFactTo, readFacts, searchFacts } = await import("../apps/core/facts.js");
  const { recordFactUsage, applyFactUsage } = await import("../apps/core/fact-usage.js");
  let file = appendFactTo(
    { schema_version: 1, revision: 0, updated_at: now, facts: [] } as any,
    { content: "导入材料：用户可能喜欢蓝封面词汇本", kind: "imported_unverified" },
    { kind: "input", id: "import-src", channel: "qq", at: now },
    now,
  );
  atomicWrite(h.store.files.resolve(".agent/context/facts.json", "internal"), JSON.stringify(file));
  const facts = readFacts(h.store).facts;
  // Normal context search excludes imported material; an explicit preferences read can show it.
  expect(searchFacts(h.store, "蓝封面", now).items).toHaveLength(0);
  expect(searchFacts(h.store, "蓝封面", now, 20, 0, true).items).toHaveLength(1);

  // Usage is recorded once per event (SQLite only), then folded into the file at a
  // safe point between turns so a prepared commit is never invalidated.
  expect(recordFactUsage(h.store, [facts[0].id], "evt-1", now)).toBe(1);
  expect(recordFactUsage(h.store, [facts[0].id], "evt-1", now)).toBe(0);
  expect(readFacts(h.store).facts[0].last_used_at ?? null).toBeNull();
  applyFactUsage(
    h.store,
    () => readFacts(h.store),
    (file) =>
      atomicWrite(h.store.files.resolve(".agent/context/facts.json", "internal"), JSON.stringify(file)),
  );
  const used = readFacts(h.store).facts[0];
  expect(used.last_used_at).toBe(now);
  expect(used.used_event_ids).toEqual(["evt-1"]);
});
