import { afterEach, it, expect } from "vitest";
import fs from "node:fs";
import { harness, habitAction } from "./helpers.js";
import { atomicWrite } from "../apps/core/files.js";
import { cleanup } from "../apps/core/maintenance.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});
function setup() {
  const h = harness();
  cleanups.push(() => h.close());
  return h;
}
it("D07 rename updates explicit links and bindings while preserving code, frontmatter, ambiguity and prose", async () => {
  const h = setup(),
    created = await h.run(habitAction);
  const daily = await h.core.newPeriod("daily", "2026-10-23");
  const old = daily.path,
    next = old.replace("2026-10-23.md", "2026-10-23-edited.md");
  const body =
    '---\nref: "[[' +
    old.replace(/\.md$/, "") +
    ']]"\n---\n' +
    "普通原文 " +
    old +
    "\n[[" +
    old.replace(/\.md$/, "") +
    "#习惯|今天]]\n```md\n[[" +
    old +
    "]]\n```\n`[[" +
    old +
    "]]`\n";
  atomicWrite(h.store.files.resolve("03. Manual/ref.md"), body);
  await h.store.exclusive(() =>
    h.core.documents.rename(
      old,
      next,
      h.store.document(old).hash,
      "rename-fixture",
    ),
  );
  const expected = body.replace(
    "[[" + old.replace(/\.md$/, "") + "#习惯|今天]]",
    "[[" + next.replace(/\.md$/, "") + "#习惯|今天]]",
  );
  expect(h.store.files.read("03. Manual/ref.md")).toBe(expected);
  expect(
    h.store
      .registry()
      .diary_links.find((x) => x.target_ref.id === created.updated_ids[0])
      ?.path,
  ).toBe(next);
  expect(fs.existsSync(h.store.files.resolve(old))).toBe(false);
});
for (const stage of ["rename_prepared", "document_renamed", "backlink_written"])
  it("D07 rename recovers safely after " + stage, async () => {
    const h = setup();
    const old = "03. Manual/old.md",
      next = "03. Manual/new.md";
    atomicWrite(h.store.files.resolve(old), "unique untouched body");
    atomicWrite(
      h.store.files.resolve("02. Decisions/ref.md"),
      "[[03. Manual/old]]\n",
    );
    const before = h.store.document(old);
    let triggered = false;
    h.store.fault = (point) => {
      if (point === stage && !triggered) {
        triggered = true;
        throw new Error("simulated power loss");
      }
    };
    await expect(
      h.store.exclusive(() =>
        h.core.documents.rename(old, next, before.hash, "crash-rename"),
      ),
    ).rejects.toThrow("simulated power loss");
    expect(triggered).toBe(true);
    h.store.fault = undefined;
    await h.restart();
    expect(h.store.files.read(next)).toBe("unique untouched body");
    expect(h.store.files.read("02. Decisions/ref.md")).toBe(
      "[[03. Manual/new]]\n",
    );
    expect(fs.existsSync(h.store.files.resolve(old))).toBe(false);
    const all = h.store.db.prepare("SELECT payload_json FROM events").all();
    expect(JSON.stringify(all)).not.toContain("unique untouched body");
    const retry = await h.store.exclusive(() =>
      h.core.documents.rename(old, next, before.hash, "crash-rename"),
    );
    expect(retry.path).toBe(next);
  });
it("ambiguous basename links remain untouched with an explicit warning", async () => {
  const h = setup();
  atomicWrite(h.store.files.resolve("03. Manual/a/same.md"), "one");
  atomicWrite(h.store.files.resolve("02. Decisions/b/same.md"), "two");
  atomicWrite(h.store.files.resolve("README.md"), "[[same]]");
  const current = h.store.document("03. Manual/a/same.md"),
    result = await h.store.exclusive(() =>
      h.core.documents.rename(
        current.path,
        "03. Manual/a/renamed.md",
        current.hash,
        "ambiguous",
      ),
    );
  expect(result.warnings).toContain("README.md");
  expect(h.store.files.read("README.md")).toBe("[[same]]");
});
it("moving a note updates its outgoing relative link without changing headings or code", async () => {
  const h = setup();
  atomicWrite(
    h.store.files.resolve("03. Manual/a.md"),
    "[对象](b.md#标题)\n`[不动](b.md)`",
  );
  atomicWrite(h.store.files.resolve("03. Manual/b.md"), "B");
  const current = h.store.document("03. Manual/a.md");
  await h.store.exclusive(() =>
    h.core.documents.rename(
      current.path,
      "03. Manual/nested/a.md",
      current.hash,
      "move",
    ),
  );
  expect(h.store.files.read("03. Manual/nested/a.md")).toBe(
    "[对象](../b.md#标题)\n`[不动](b.md)`",
  );
});
it("D07 habit projections keep their business date after the diary filename changes", async () => {
  const h = setup(),
    habit = await h.run(habitAction),
    daily = await h.core.newPeriod("daily", "2026-10-23"),
    document = h.store.document(daily.path),
    next = daily.path.replace("2026-10-23.md", "renamed.md");
  await h.store.exclusive(() =>
    h.core.documents.rename(daily.path, next, document.hash, "rename-day"),
  );
  await h.run({
    type: "report_habit",
    target_id: habit.updated_ids[0],
    business_date: "2026-10-23",
    status: "did",
  });
  expect(h.store.files.read(next)).toContain("- [x] 英语");
});
for (const stage of ["document_trashed", "trash_recovered"])
  it(
    "delete and recovery survive " + stage + " without body snapshots",
    async () => {
      const h = setup(),
        relative = "03. Manual/recover.md";
      atomicWrite(h.store.files.resolve(relative), "exact body\r\n原文\r\n");
      const document = h.store.document(relative);
      let recoveryId: string | undefined;
      if (stage === "trash_recovered")
        recoveryId = (
          await h.store.exclusive(() =>
            h.core.documents.delete(relative, document.hash, "delete"),
          )
        ).recovery_id;
      let triggered = false;
      h.store.fault = (point) => {
        if (point === stage && !triggered) {
          triggered = true;
          throw new Error("power loss");
        }
      };
      await expect(
        h.store.exclusive(() =>
          stage === "document_trashed"
            ? h.core.documents.delete(relative, document.hash, "delete")
            : h.core.documents.restoreTrash(recoveryId!, "restore"),
        ),
      ).rejects.toThrow("power loss");
      h.store.fault = undefined;
      await h.restart();
      if (stage === "document_trashed") {
        expect(h.core.documents.listTrash()).toHaveLength(1);
        recoveryId = h.core.documents.listTrash()[0].id;
        await h.store.exclusive(() =>
          h.core.documents.restoreTrash(recoveryId!, "restore"),
        );
      }
      expect(h.store.files.read(relative)).toBe("exact body\r\n原文\r\n");
      expect(h.core.documents.listTrash()).toHaveLength(0);
    },
  );
it("B03 old note modification time cannot shorten the seven-day trash retention", async () => {
  const h = setup(),
    relative = "03. Manual/old-history.md";
  atomicWrite(h.store.files.resolve(relative), "historical original");
  const old = new Date("2025-01-01T00:00:00Z");
  fs.utimesSync(h.store.files.resolve(relative), old, old);
  const current = h.store.document(relative);
  await h.store.exclusive(() =>
    h.core.documents.delete(relative, current.hash, "delete-old"),
  );
  await h.store.exclusive(() => cleanup(h.store));
  expect(h.core.documents.listTrash()).toHaveLength(1);
  h.advance(8 * 86400000);
  await h.store.exclusive(() => cleanup(h.store));
  expect(h.core.documents.listTrash()).toHaveLength(0);
});
it("D07 renamed display labels remain pending instead of guessing a binding", async () => {
  const h = setup(),
    habit = await h.run(habitAction),
    daily = await h.core.newPeriod("daily", "2026-10-23"),
    before = h.store.document(daily.path);
  const renamed = before.content.replace(
    "- [ ] 英语",
    "- [ ] 自己重命名的展示",
  );
  await h.core.saveDocument(daily.path, before.hash, renamed, "rename-label");
  expect(h.store.registry().diary_links[0].status).toBe("pending");
  await h.run({
    type: "report_habit",
    target_id: habit.updated_ids[0],
    business_date: "2026-10-23",
    status: "did",
  });
  expect(h.store.files.read(daily.path)).toBe(renamed);
  expect(h.store.registry().habits[0].status).toBe("active");
});
