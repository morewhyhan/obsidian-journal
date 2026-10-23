import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AppError } from "../../packages/contracts/types.js";
export const hash = (content: string | Buffer) =>
  "sha256:" + crypto.createHash("sha256").update(content).digest("hex");
export const id = (prefix: string) => prefix + "_" + crypto.randomUUID();
export function atomicWrite(file: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(
    path.dirname(file),
    ".save-" + crypto.randomUUID() + ".tmp",
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    if (process.platform !== "win32") {
      const dir = fs.openSync(path.dirname(file), "r");
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
export function serialize(value: unknown) {
  return JSON.stringify(value, null, 2) + "\n";
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
const rootFiles = new Set([
  "MOC.md",
  "README.md",
  "总体目标.md",
  "长期待办任务.md",
]);
export class VaultFiles {
  root: string;
  maxDocumentBytes = 2 * 1024 * 1024;
  legacy = new Set<string>();
  legacyRoutes = new Map<string, string>();
  constructor(root: string) {
    fs.mkdirSync(root, { recursive: true });
    this.root = fs.realpathSync(root);
    const legacy = this.resolve(
      ".obsidian/plugins/light-okr/legacy-notes.json",
      "internal",
    );
    if (fs.existsSync(legacy)) {
      const map = JSON.parse(fs.readFileSync(legacy, "utf8"));
      for (const file of map.files ?? [])
        if (typeof file.path === "string") this.legacy.add(file.path);
      for (const [canonical, actual] of Object.entries(map.routes ?? {}))
        if (typeof actual === "string") {
          this.legacyRoutes.set(canonical, actual);
          this.legacy.add(actual);
        }
    }
  }
  actualPath(canonical: string) {
    const old = this.legacyRoutes.get(canonical);
    if (!old) return canonical;
    const year = canonical.match(/\/(\d{4})年\//)?.[1],
      oldYear = old.match(/(?:^|\/)(\d{4})年\//)?.[1];
    if (canonical.endsWith("/周计划.md") && year !== oldYear) return canonical;
    return fs.existsSync(this.resolve(old)) ? old : canonical;
  }
  resolve(
    relative: string,
    mode: "document" | "attachment" | "internal" = "document",
  ) {
    if (
      typeof relative !== "string" ||
      relative.includes("\0") ||
      relative.includes("\\") ||
      relative.startsWith("/") ||
      /^[A-Za-z]:/.test(relative) ||
      relative.split("/").some((p) => p === ".." || p === "." || p === "")
    )
      throw new AppError("INVALID_PATH", "无效的库内路径", 403);
    if (
      mode === "document" &&
      !(
        rootFiles.has(relative) ||
        /^(01\. Daily|02\. Decisions|03\. Manual|Template)\/.+\.md$/.test(
          relative,
        ) ||
        this.legacy.has(relative)
      )
    )
      throw new AppError("PATH_FORBIDDEN", "不允许访问此笔记路径", 403);
    if (mode === "attachment" && !/^Attachment\/[^/]+$/.test(relative))
      throw new AppError("PATH_FORBIDDEN", "附件必须存放在 Attachment", 403);
    if (
      mode !== "internal" &&
      relative.split("/").some((p) => p.startsWith("."))
    )
      throw new AppError("PATH_FORBIDDEN", "不允许访问隐藏目录", 403);
    const resolved = path.resolve(this.root, relative);
    if (!resolved.startsWith(this.root + path.sep))
      throw new AppError("PATH_FORBIDDEN", "路径越界", 403);
    let cur = this.root;
    for (const p of relative.split("/")) {
      cur = path.join(cur, p);
      let stat: fs.Stats | undefined;
      try {
        stat = fs.lstatSync(cur);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (stat) {
        if (stat.isSymbolicLink())
          throw new AppError("PATH_FORBIDDEN", "不允许符号链接", 403);
        const real = fs.realpathSync(cur);
        if (!real.startsWith(this.root + path.sep))
          throw new AppError("PATH_FORBIDDEN", "路径越界", 403);
      }
    }
    return resolved;
  }
  read(relative: string) {
    const file = this.resolve(relative);
    if (!fs.existsSync(file))
      throw new AppError("NOT_FOUND", "笔记不存在", 404);
    if (fs.statSync(file).size > this.maxDocumentBytes)
      throw new AppError(
        "DOCUMENT_TOO_LARGE",
        "笔记超过文本编辑上限，请拆分内容或作为附件保存",
        413,
      );
    return fs.readFileSync(file, "utf8");
  }
  list() {
    const paths: string[] = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      if (fs.lstatSync(dir).isSymbolicLink())
        throw new AppError("PATH_FORBIDDEN", "不允许符号链接目录", 403);
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        if (f.name.startsWith(".") || f.isSymbolicLink()) continue;
        const abs = path.join(dir, f.name);
        if (f.isDirectory()) walk(abs);
        else if (f.name.endsWith(".md"))
          paths.push(path.relative(this.root, abs).split(path.sep).join("/"));
      }
    };
    for (const dir of ["01. Daily", "02. Decisions", "03. Manual", "Template"])
      walk(path.join(this.root, dir));
    for (const p of rootFiles)
      if (fs.existsSync(path.join(this.root, p))) paths.push(p);
    for (const p of this.legacy)
      if (fs.existsSync(this.resolve(p))) paths.push(p);
    return [...new Set(paths)].sort();
  }
}
