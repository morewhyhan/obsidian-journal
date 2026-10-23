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
