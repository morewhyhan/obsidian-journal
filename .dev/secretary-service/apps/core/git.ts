import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "../../packages/contracts/types.js";
import { atomicWrite, VaultFiles } from "./files.js";
const exec = promisify(execFile);
export const git = (root: string, args: string[]) =>
  exec("git", ["-C", root, ...args], {
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).then((r) => r.stdout);
export const backupPath = (p: string) => {
  if (p === ".gitignore") return true;
  if (
    p
      .split("/")
      .some(
        (part, index) =>
          part.startsWith(".") && !(index === 0 && part === ".agent"),
      )
  )
    return false;
  if (
    /(?:^|\/)(?:id_rsa|id_ed25519|credentials[^/]*\.json)$|\.(pem|key|log|tmp)$/i.test(
      p,
    )
  )
    return false;
  return (
    /^(01\. Daily|02\. Decisions|03\. Manual|Attachment|Template)\//.test(p) ||
    (!p.startsWith(".agent/") && p.endsWith(".md")) ||
    ["Someday.md", "MOC.md", "README.md"].includes(p) ||
    /^\.agent\/(state|context|prompts)\//.test(p) ||
    [".agent/config.json", ".agent/SPEC.md"].includes(p)
  );
};
export async function verifyGitHubPrivate(
  remote: string,
  metadataToken: string | undefined,
) {
  const match = remote.match(
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git$/,
  );
  if (!match || !metadataToken) return false;
  try {
    const response = await fetch(
      "https://api.github.com/repos/" +
        encodeURIComponent(match[1]) +
        "/" +
        encodeURIComponent(match[2]),
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + metadataToken,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      },
    );
    if (!response.ok) return false;
    const data = (await response.json()) as {
      private?: boolean;
      full_name?: string;
    };
    return (
      data.private === true &&
      data.full_name?.toLowerCase() ===
        (match[1] + "/" + match[2]).toLowerCase()
    );
  } catch {
    return false;
  }
}
export async function initializePrivateBackup(
  root: string,
  remote: string,
  verify: (remote: string) => Promise<boolean>,
) {
  if (fs.existsSync(path.join(root, ".git")))
    throw new AppError("EXISTING_REPOSITORY", "不自动改动已有仓库");
  if (!/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(remote))
    throw new AppError("INVALID_REMOTE", "需要明确的 GitHub SSH 数据仓库地址");
  if (!(await verify(remote)))
    throw new AppError(
      "PRIVATE_REMOTE_REQUIRED",
      "无法核验目标仓库为私有，尚未初始化",
    );
  atomicWrite(
    path.join(root, ".gitignore"),
    ".agent/data/\n.git/\n.dev/\n.local/\n.obsidian/*\n!.obsidian/plugins/\n.obsidian/plugins/*\n!.obsidian/plugins/light-okr/\n.obsidian/plugins/light-okr/*\n!.obsidian/plugins/light-okr/legacy-notes.json\n.env\n.env.*\n*.log\n*.tmp\n*.pem\n*.key\n",
  );
  await git(root, ["init", "-b", "main"]);
  await git(root, ["remote", "add", "origin", remote]);
  await git(root, ["config", "user.name", "Private Secretary"]);
  await git(root, ["config", "user.email", "secretary@localhost"]);
}
type WriteLock = <T>(fn: () => Promise<T>) => Promise<T>;
export class GitWorker {
  dirtyAt = 0;
  firstDirtyAt = 0;
  lastCommit: string | null = null;
  lastPush: string | null = null;
  error: string | null = null;
  conflict = false;
  private running = false;
  private retryAt = 0;
  private failures = 0;
  private generation = 0;
  private initial = true;
  private pendingPush = true;
  constructor(
    public root: string,
    public options: {
      enabled: boolean;
      debounceSeconds: number;
      maxSeconds: number;
      branch: string;
      remote?: string;
      verifyPrivate?: (remote: string) => Promise<boolean>;
      withWriteLock?: WriteLock;
      now?: () => number;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  changed() {
    this.generation++;
    this.dirtyAt = this.now();
    if (!this.firstDirtyAt) this.firstDirtyAt = this.dirtyAt;
  }
  private async snapshot() {
    const files = new VaultFiles(this.root),
      mapping = ".obsidian/plugins/light-okr/legacy-notes.json",
      legacy = [...files.legacy].filter((p) => p.endsWith(".md"));
    const allowed = (p: string) => {
      if (!(backupPath(p) || legacy.includes(p) || p === mapping)) return false;
      try {
        files.resolve(
          p,
          p.startsWith("Attachment/")
            ? "attachment"
            : p.startsWith(".agent/") ||
                p.startsWith(".obsidian/") ||
                p === ".gitignore"
              ? "internal"
              : "document",
        );
        return true;
      } catch {
        return false;
      }
    };
    const tracked = (await git(this.root, ["ls-files", "-z"]))
      .split("\0")
      .filter(Boolean);
    const notes = files.list();
    if (tracked.some((p) => !allowed(p)))
      throw new AppError(
        "UNSAFE_TRACKED_PATH",
        "数据仓库包含不允许的已跟踪文件",
      );
    const entries = (
      await git(this.root, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
      ])
    )
      .split("\0")
      .filter(Boolean);
    const changed = new Set<string>();
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index],
        status = entry.slice(0, 2),
        p = entry.slice(3);
      if (status === "!!") {
        if (
          allowed(p) ||
          (p === ".agent/" &&
            fs.existsSync(files.resolve(".agent/state", "internal"))) ||
          (p.endsWith("/") && legacy.some((file) => file.startsWith(p))) ||
          (p.endsWith("/") &&
            notes.some((file) => file.startsWith(p) && allowed(file))) ||
          (p.endsWith("/") &&
            mapping.startsWith(p) &&
            fs.existsSync(files.resolve(mapping, "internal"))) ||
          (/^(01\. Daily|02\. Decisions|03\. Manual|Attachment)\//.test(p) &&
            p.endsWith("/"))
        )
          throw new AppError(
            "BACKUP_IGNORED_CONTENT",
            "生产忽略规则遗漏了需要备份的资料",
          );
        continue;
      }
      if (allowed(p)) changed.add(p);
      else if (tracked.includes(p))
        throw new AppError("UNSAFE_TRACKED_PATH", "不允许备份此文件");
      if (/[RC]/.test(status)) {
        const old = entries[++index];
        if (old && allowed(old)) changed.add(old);
      }
    }
    if (changed.size) {
      let batch: string[] = [],
        length = 0;
      for (const relative of changed) {
        if (
          batch.length &&
          (batch.length >= 100 || length + relative.length + 3 > 8000)
        ) {
          await git(this.root, ["add", "--", ...batch]);
          batch = [];
          length = 0;
        }
        batch.push(relative);
        length += relative.length + 3;
      }
      if (batch.length) await git(this.root, ["add", "--", ...batch]);
      const staged = await git(this.root, [
        "diff",
        "--cached",
        "--name-only",
        "-z",
      ]);
      if (staged) {
        await git(this.root, [
          "commit",
          "-m",
          "Saved " +
            new Date(this.now()).toISOString().slice(0, 10) +
            " (" +
            changed.size +
            " files)",
        ]);
        this.lastCommit = new Date(this.now()).toISOString();
        this.pendingPush = true;
      }
    }
  }
  async tick() {
    if (!this.options.enabled || this.running) return;
    if (!fs.existsSync(path.join(this.root, ".git"))) {
      this.error = "BACKUP_NOT_INITIALIZED";
      return;
    }
    const ready =
      this.initial ||
      (this.dirtyAt > 0 &&
        (this.now() - this.dirtyAt >= this.options.debounceSeconds * 1000 ||
          this.now() - this.firstDirtyAt >= this.options.maxSeconds * 1000));
    const pushReady =
      !this.conflict && this.pendingPush && this.now() >= this.retryAt;
    if (!ready && !pushReady) return;
    this.running = true;
    try {
      const remote = (
        await git(this.root, ["remote", "get-url", "origin"])
      ).trim();
      if (!this.options.remote || remote !== this.options.remote)
        throw new AppError("REMOTE_MISMATCH", "备份远端不匹配");
      if (ready) {
        const generation = this.generation;
        const work = () => this.snapshot();
        if (this.options.withWriteLock) await this.options.withWriteLock(work);
        else await work();
        this.initial = false;
        if (generation === this.generation) {
          this.dirtyAt = 0;
          this.firstDirtyAt = 0;
        }
      }
      if (!this.pendingPush || this.conflict || this.now() < this.retryAt)
        return;
      if (
        !this.options.verifyPrivate ||
        !(await this.options.verifyPrivate(remote))
      )
        throw new AppError(
          "PRIVATE_VERIFICATION_FAILED",
          "未能核验仓库为私有，已保留本地提交",
        );
      try {
        await git(this.root, ["rev-parse", "--verify", "HEAD"]);
      } catch {
        this.pendingPush = false;
        return;
      }
      await git(this.root, ["push", "origin", this.options.branch]);
      this.lastPush = new Date(this.now()).toISOString();
      this.pendingPush = false;
      this.error = null;
      this.failures = 0;
    } catch (error) {
      const text = String(error);
      if (/non-fast-forward|fetch first|rejected/i.test(text))
        this.conflict = true;
      this.error = this.conflict
        ? "GIT_CONFLICT"
        : error instanceof AppError
          ? error.code
          : "GIT_PUSH_FAILED";
      this.retryAt =
        this.now() + [1, 5, 15, 60][Math.min(this.failures++, 3)] * 60000;
    } finally {
      this.running = false;
    }
  }
  async history(relative: string) {
    try {
      const raw = await git(this.root, [
        "log",
        "--follow",
        "--format=%H%x09%cI",
        "-20",
        "--",
        relative,
      ]);
      return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [commit, at] = line.split("\t");
          return { commit, at };
        });
    } catch {
      return [];
    }
  }
  async drain() {
    while (this.running)
      await new Promise((resolve) => setTimeout(resolve, 25));
  }
  async content(relative: string, commit: string) {
    if (!/^[0-9a-f]{40}$/.test(commit))
      throw new AppError("INVALID_COMMIT", "无效版本");
    try {
      return await git(this.root, ["show", commit + ":" + relative]);
    } catch {
      throw new AppError("HISTORY_NOT_FOUND", "历史版本不存在", 404);
    }
  }
}
