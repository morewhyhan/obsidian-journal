import fs from "node:fs";
import path from "node:path";
import { afterEach, it, expect } from "vitest";
import { temporary, removeTemporary } from "./helpers.js";
import { git, GitWorker } from "../apps/core/git.js";
import { atomicWrite } from "../apps/core/files.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeTemporary(root);
});
function temp() {
  const root = temporary();
  roots.push(root);
  return root;
}
async function repo(root: string) {
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  atomicWrite(path.join(root, ".gitignore"), ".agent/data/\n.env\n");
  atomicWrite(path.join(root, "README.md"), "first");
  atomicWrite(path.join(root, "01. Daily/2026年/日记.md"), "日记");
  atomicWrite(path.join(root, "Attachment/a.txt"), "附件");
  atomicWrite(path.join(root, ".agent/state/registry.json"), "{}");
  for (const name of ["README.md", "ARCHITECTURE.md", "DECISIONS.md"])
    atomicWrite(path.join(root, ".agent/Research", name), "fixture documentation");
  atomicWrite(path.join(root, ".agent/data/secret.sqlite"), "excluded");
  atomicWrite(path.join(root, ".env"), "excluded-secret");
  atomicWrite(path.join(root, "我的新目录/说明.md"), "新目录也必须备份");
}
it("B02 local bare-remote fixture includes diary, attachment and state, but never database or secret file", async () => {
  const root = temp(),
    remote = temp();
  await git(remote, ["init", "--bare"]);
  await repo(root);
  await git(root, ["remote", "add", "origin", remote]);
  const worker = new GitWorker(root, {
    enabled: true,
    debounceSeconds: 0,
    maxSeconds: 1,
    branch: "main",
    remote,
    verifyPrivate: async () => true,
  });
  worker.changed();
  await worker.tick();
  expect(worker.error).toBeNull();
  const names = (
    await git(remote, ["ls-tree", "-r", "--name-only", "-z", "main"])
  ).split("\0");
  expect(names).toContain("README.md");
  expect(names).toContain("Attachment/a.txt");
  expect(names).toContain("我的新目录/说明.md");
  expect(names).toContain(".agent/state/registry.json");
  for (const name of ["README.md", "ARCHITECTURE.md", "DECISIONS.md"])
    expect(names).toContain(".agent/Research/" + name);
  expect(names.join("\n")).not.toContain("secret.sqlite");
  expect(names).not.toContain(".env");
  expect(worker.lastPush).not.toBeNull();
});
it("B01 push failure does not stop later local commits during retry backoff", async () => {
  const root = temp();
  await repo(root);
  const remote = path.join(temp(), "missing-remote");
  await git(root, ["remote", "add", "origin", remote]);
  let now = Date.now();
  const worker = new GitWorker(root, {
    enabled: true,
    debounceSeconds: 0,
    maxSeconds: 1,
    branch: "main",
    remote,
    verifyPrivate: async () => true,
    now: () => now,
  });
  worker.changed();
  await worker.tick();
  expect(worker.error).toBe("GIT_PUSH_FAILED");
  const first = (await git(root, ["rev-parse", "HEAD"])).trim();
  now += 1000;
  atomicWrite(path.join(root, "README.md"), "second while offline");
  worker.changed();
  await worker.tick();
  expect((await git(root, ["rev-parse", "HEAD"])).trim()).not.toBe(first);
  expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toBe(
    "second while offline",
  );
});
it("B01 non-fast-forward keeps both sides and disables pushes without reset or force", async () => {
  const root = temp(),
    remote = temp(),
    other = temp();
  await git(remote, ["init", "--bare"]);
  await repo(root);
  await git(root, ["remote", "add", "origin", remote]);
  const worker = new GitWorker(root, {
    enabled: true,
    debounceSeconds: 0,
    maxSeconds: 1,
    branch: "main",
    remote,
    verifyPrivate: async () => true,
  });
  worker.changed();
  await worker.tick();
  await git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(root, ["clone", remote, other]);
  await git(other, ["config", "user.name", "Other fixture"]);
  await git(other, ["config", "user.email", "other@example.invalid"]);
  atomicWrite(path.join(other, "README.md"), "remote side");
  await git(other, ["add", "--", "README.md"]);
  await git(other, ["commit", "-m", "Remote change"]);
  await git(other, ["push", "origin", "main"]);
  atomicWrite(path.join(root, "README.md"), "local side");
  worker.changed();
  await worker.tick();
  expect(worker.conflict).toBe(true);
  expect(worker.error).toBe("GIT_CONFLICT");
  expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toBe(
    "local side",
  );
  expect((await git(remote, ["show", "main:README.md"])).trim()).toBe(
    "remote side",
  );
});
it("privacy verification failure preserves a local snapshot and sends no commits to remote", async () => {
  const root = temp(),
    remote = temp();
  await git(remote, ["init", "--bare"]);
  await repo(root);
  await git(root, ["remote", "add", "origin", remote]);
  const worker = new GitWorker(root, {
    enabled: true,
    debounceSeconds: 0,
    maxSeconds: 1,
    branch: "main",
    remote,
    verifyPrivate: async () => false,
  });
  worker.changed();
  await worker.tick();
  expect(worker.error).toBe("PRIVATE_VERIFICATION_FAILED");
  expect((await git(root, ["rev-parse", "HEAD"])).trim()).toMatch(
    /^[0-9a-f]{40}$/,
  );
  await expect(
    git(remote, ["rev-parse", "--verify", "main"]),
  ).rejects.toThrow();
});
it.each([".agent/", "我的新目录/"])(
  "B02 ignoring %s is detected instead of silently omitting backup content",
  async (ignored) => {
    const root = temp(),
      remote = temp();
    await git(remote, ["init", "--bare"]);
    await repo(root);
    atomicWrite(path.join(root, ".gitignore"), ignored + "\n.env\n");
    await git(root, ["remote", "add", "origin", remote]);
    const worker = new GitWorker(root, {
      enabled: true,
      debounceSeconds: 0,
      maxSeconds: 1,
      branch: "main",
      remote,
      verifyPrivate: async () => true,
    });
    await worker.tick();
    expect(worker.error).toBe("BACKUP_IGNORED_CONTENT");
    await expect(
      git(remote, ["rev-parse", "--verify", "main"]),
    ).rejects.toThrow();
  },
);
it("B02 explicitly mapped legacy notes and their exact map are included in backup", async () => {
  const root = temp(),
    remote = temp();
  await git(remote, ["init", "--bare"]);
  await repo(root);
  atomicWrite(path.join(root, "2025年/历史原文.md"), "历史原文不改");
  atomicWrite(
    path.join(root, ".obsidian/plugins/light-okr/legacy-notes.json"),
    JSON.stringify({ files: [{ path: "2025年/历史原文.md" }], routes: {} }),
  );
  atomicWrite(
    path.join(root, ".obsidian/workspace.json"),
    "excluded workspace",
  );
  await git(root, ["remote", "add", "origin", remote]);
  const worker = new GitWorker(root, {
    enabled: true,
    debounceSeconds: 0,
    maxSeconds: 1,
    branch: "main",
    remote,
    verifyPrivate: async () => true,
  });
  await worker.tick();
  expect(worker.error).toBeNull();
  const names = (
    await git(remote, ["ls-tree", "-r", "--name-only", "-z", "main"])
  ).split("\0");
  expect(names).toContain("2025年/历史原文.md");
  expect(names).toContain(".obsidian/plugins/light-okr/legacy-notes.json");
  expect(names).not.toContain(".obsidian/workspace.json");
});
