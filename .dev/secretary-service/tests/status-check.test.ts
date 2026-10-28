import { afterEach, expect, it } from "vitest";
import { harness } from "./helpers.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

it("a status check stays silent when the last message already says what is happening", async () => {
  const h = harness("2026-10-27T05:55:00Z");
  closers.push(() => h.close());
  const created = await h.run({
    type: "create_automation",
    kind: "status_check",
    title: "看看在做什么",
    body: "现在在做什么？回一句就行。",
    schedule: {
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      starts_on: "2026-10-26",
      local_start: "06:00",
      local_end: "22:00",
      minute: 0,
      every_hours: 2,
    },
  });
  expect(created.updated_ids.length).toBe(1);
  h.store.db
    .prepare(
      "INSERT INTO inbox(id,channel,actor_ref,external_id,body,metadata_json,status,attempts,received_at,occurred_at,processed_at) VALUES(?,?,?,?,?,?,'processed',1,?,?,?)",
    )
    .run("input_recent", "qq", "user", "m", "我在写报告", "{}", h.store.now(), h.store.now(), h.store.now());
  h.advance(6 * 60000);
  await h.core.assistant.tick();
  const today = h.store.day("2026-10-27");
  const skipped = (today.automation_occurrences ?? []).filter(
    (o: any) => o.checkin_status === "skip",
  );
  expect(skipped.length).toBeGreaterThan(0);
});

it("a check-in is asked once per silence episode, not every slot", async () => {
  const h = harness("2026-10-27T04:00:00Z");
  closers.push(() => h.close());
  const created = await h.run({
    type: "create_automation",
    kind: "status_check",
    title: "看看在做什么",
    body: "现在在做什么？回一句就行。",
    schedule: {
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      starts_on: "2026-10-26",
      local_start: "06:00",
      local_end: "22:00",
      minute: 0,
      every_hours: 2,
    },
  });
  const id = created.updated_ids[0];
  expect(h.core.assistant.awaitingCheckinReply(id)).toBe(false);
  h.store.db
    .prepare(
      "INSERT INTO outbox(id,channel,recipient_ref,dedupe_key,target_refs_json,source_versions_json,message_kind,body,content_hash,scheduled_at,expires_at,status,attempts,business_date,external_id,finished_at,created_at,updated_at,sent_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'sent',1,?,?,?,?,?,?)",
    )
    .run(
      "out_ask", "qq", "user", "k", "[]",
      JSON.stringify({ ["occ:" + id + ":2026-10-27T04:00:00Z"]: 1 }),
      "initial", "在做什么", "h", h.store.now(), h.store.now(),
      "2026-10-27", "ext-ask", h.store.now(), h.store.now(), h.store.now(), h.store.now(),
    );
  expect(h.core.assistant.awaitingCheckinReply(id)).toBe(true);
  h.store.db
    .prepare(
      "INSERT INTO inbox(id,channel,actor_ref,external_id,body,metadata_json,status,attempts,received_at,occurred_at,processed_at) VALUES(?,?,?,?,?,?,'processed',1,?,?,?)",
    )
    .run("input_reply", "qq", "user", "m2", "在写报告", "{}", h.store.now(), h.store.now(), h.store.now());
  expect(h.core.assistant.awaitingCheckinReply(id)).toBe(false);
});
