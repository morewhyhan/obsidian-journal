import fs from "node:fs";
import { afterEach, it, expect } from "vitest";
import { RuntimeLog } from "../apps/core/log.js";
import { harness, habitAction } from "./helpers.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
function setup() {
  const h = harness();
  cleanups.push(() => h.close());
  return h;
}
it("runtime logging writes only whitelisted metadata and removes logs after seven calendar days", () => {
  const h = setup(),
    log = new RuntimeLog(h.store);
  log.write("request_error", {
    request_id: "req-1",
    code: "SAVE_FAILED",
    body: "PRIVATE-DIARY",
    password: "PRIVATE-PASSWORD",
  } as any);
  const today = h.store.files.resolve(
      ".agent/data/logs/2026-10-23.0.log",
      "internal",
    ),
    body = fs.readFileSync(today, "utf8");
  expect(body).toContain("SAVE_FAILED");
  expect(body).not.toContain("PRIVATE-");
  h.advance(7 * 86400000);
  log.write("healthy");
  expect(fs.existsSync(today)).toBe(false);
});
it("a derived short current context is rebuilt from files and contains no diary narrative", async () => {
  const h = setup();
  await h.run(habitAction);
  const file = h.store.files.resolve(".agent/context/current.md", "internal");
  expect(fs.readFileSync(file, "utf8")).toContain("有效习惯 1 项");
  await h.restart();
  expect(fs.readFileSync(file, "utf8")).toContain("registry:1");
  expect(h.store.files.list()).toHaveLength(0);
});

it("QQ context distinguishes delivered text from replies still pending or delivery unknown", () => {
  const h = setup();
  for (const state of ["sent", "pending", "unknown"]) {
    const input = { ...h.input(state), channel: "qq", actor_ref: "owner" };
    h.store.db.prepare("INSERT INTO inbox(id,channel,actor_ref,external_id,body,metadata_json,received_at,occurred_at,status) VALUES(?,?,?,?,?,'{}',?,?,'processing')")
      .run(input.id, input.channel, input.actor_ref, input.external_id, input.text, h.store.now(), h.store.now());
    h.core.finishInput(input, `reply-${state}`);
    if (state !== "pending") h.store.db.prepare("UPDATE outbox SET status=?,sent_at=?,finished_at=?,external_id='test-receipt' WHERE json_extract(metadata_json,'$.reply_group')=?")
      .run(state, state === "sent" ? h.store.now() : null, h.store.now(), input.id);
  }
  const rows = h.core.context(h.input()).recent_interactions as any[];
  expect(rows.find(x => x.text === "sent").reply).toBe("reply-sent");
  expect(rows.find(x => x.text === "pending").reply).toBe("");
  expect(rows.find(x => x.text === "unknown").reply).toBe("");
  expect(rows.find(x => x.text === "unknown").reply_status).toBe("unknown");
});
