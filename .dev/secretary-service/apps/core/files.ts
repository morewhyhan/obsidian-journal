import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AppError } from "../../packages/contracts/types.js";
export { hash, id, canonicalJson } from "../../packages/shared/identity.js";
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
/** Resolves symlinks and Windows junctions; denies a path that cannot be resolved. */
function canonicalPath(target: string) {
  let real: string;
  try {
    real = fs.realpathSync.native(target);
  } catch {
    throw new AppError("PATH_FORBIDDEN", "不允许符号链接或无法解析的路径", 403);
  }
  // GetFinalPathNameByHandle can return an extended-length prefix.
  if (process.platform === "win32" && real.startsWith("\\\\?\\")) real = real.slice(4);
  return real;
}
export function serialize(value: unknown) {
  return JSON.stringify(value, null, 2) + "\n";
}
export class VaultFiles {
  root: string;
  maxDocumentBytes = 2 * 1024 * 1024;
  legacy = new Set<string>();
  legacyRoutes = new Map<string, string>();
  /**
   * Installed by Store after the exclusive writer lock is held. Path validation
   * below cannot sequence with a host-level mount change; the single-writer
   * deployment is the actual boundary. This guard makes it observable: once the
   * lock is gone, vault access stops rather than continuing on a stale premise.
   */
  writerGuard?: () => boolean;
  constructor(root: string) {
    fs.mkdirSync(root, { recursive: true });
    // Native realpath resolves Windows junctions; the JS implementation only
    // follows symlinks and would leave a junction looking like a plain folder.
    this.root = canonicalPath(root);
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
    return this.resolveChecked(relative,mode);
  }
  private resolveChecked(relative:string,mode:"document"|"attachment"|"internal",parents?:Set<string>) {
    if (this.writerGuard && !this.writerGuard())
      throw new AppError("INSTANCE_LOCKED", "写锁已失效，文件访问暂停", 503);
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
        relative.endsWith(".md") ||
        relative === ".agent/context/memory.md" ||
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
      relative !== ".agent/context/memory.md" &&
      relative.split("/").some((p) => p.startsWith("."))
    )
      throw new AppError("PATH_FORBIDDEN", "不允许访问隐藏目录", 403);
    const resolved = path.resolve(this.root, relative);
    if (!resolved.startsWith(this.root + path.sep))
      throw new AppError("PATH_FORBIDDEN", "路径越界", 403);
    let cur = this.root;
    const segments=relative.split("/");
    for (const [index,p] of segments.entries()) {
      cur = path.join(cur, p);
      const directory=index<segments.length-1;
      if(directory && parents?.has(cur))continue;
      let stat: fs.Stats | undefined;
      try {
        stat = fs.lstatSync(cur);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // A Windows junction whose target is gone cannot be stat'ed, but the
        // directory entry still marks it as a link and must not be traversed.
        if (this.isLinkEntry(path.dirname(cur), path.basename(cur)))
          throw new AppError("PATH_FORBIDDEN", "路径越界：不允许符号链接", 403);
      }
      if (stat) {
        if (stat.isSymbolicLink())
          throw new AppError("PATH_FORBIDDEN", "不允许符号链接", 403);
        // Junction points are reported as directories by lstat on Windows.
        // Resolving the real target is the only reliable containment check, and
        // a segment that resolves elsewhere is a link even when it stays inside.
        const real = canonicalPath(cur);
        const same = process.platform === "win32"
          ? real.toLowerCase() === cur.toLowerCase() : real === cur;
        if (!same)
          throw new AppError("PATH_FORBIDDEN", "路径越界：不允许符号链接", 403);
        if (real !== this.root && !real.startsWith(this.root + path.sep))
          throw new AppError("PATH_FORBIDDEN", "路径越界：不允许符号链接", 403);
        if(directory && stat.isDirectory())parents?.add(cur);
      }
    }
    return resolved;
  }
  private isLinkEntry(dir: string, name: string) {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => entry.name === name && entry.isSymbolicLink());
    } catch {
      return false;
    }
  }
  read(relative: string) {
    return this.readBytes(relative).toString("utf8");
  }
  readBytes(relative:string,mode:"document"|"attachment"|"internal"="document",limit=this.maxDocumentBytes) {
    return this.readChecked(relative,mode,limit);
  }
  private readChecked(relative:string,mode:"document"|"attachment"|"internal",limit:number,parents?:Set<string>) {
    const file = this.resolveChecked(relative,mode,parents);
    if (!fs.existsSync(file))
      throw new AppError("NOT_FOUND", "笔记不存在", 404);
    const fd=fs.openSync(file,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW??0));
    try {
    const stat=fs.fstatSync(fd);
    if(!stat.isFile() || stat.nlink!==1)throw new AppError("PATH_FORBIDDEN","仅允许独立普通文件",403);
    if (stat.size > limit)
      throw new AppError(
        "DOCUMENT_TOO_LARGE",
        "笔记超过文本编辑上限，请拆分内容或作为附件保存",
        413,
      );
    return fs.readFileSync(fd);
    } finally {fs.closeSync(fd);}
  }
  /** One synchronous scan under the exclusive-writer deployment boundary.
   * Parent validation is reused only within this call; every leaf is opened and fstat-checked.
   * No persistent full-text mirror or cross-request path authorization cache. */
  search(paths:string[],query:string) {
    const parents=new Set<string>(),q=query.toLocaleLowerCase();
    return paths.flatMap(p=>{
      let body="";
      try{body=this.readChecked(p,"document",this.maxDocumentBytes,parents).toString("utf8");}
      catch(e){if(!(e instanceof AppError) || e.code!=="DOCUMENT_TOO_LARGE")throw e;}
      const at=body.toLocaleLowerCase().indexOf(q);
      return p.toLocaleLowerCase().includes(q) || at>=0
        ? [{path:p,snippet:at>=0?body.slice(Math.max(0,at-40),Math.max(0,at-40)+180):""}]:[];
    });
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
    walk(this.root);
    for (const p of this.legacy)
      if (fs.existsSync(this.resolve(p))) paths.push(p);
    return [...new Set(paths)].sort();
  }
}
