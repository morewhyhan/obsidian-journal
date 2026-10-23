import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DateTime } from "luxon";
import { lockSync } from "proper-lockfile";
import {
  AppError,
  type Registry,
  type Day,
} from "../../packages/contracts/types.js";
import { VaultFiles, atomicWrite, hash, id, serialize } from "./files.js";
import { resource, type Config } from "./config.js";
type Patch = { keys: (string | number)[]; value?: unknown; remove?: boolean };
type Change = {
  path: string;
  base_hash: string | null;
  target_hash: string;
  patch?: Patch[];
  append?: string;
};
const emptyRegistry = (): Registry => ({
  schema_version: 1,
  revision: 0,
  last_operation_id: null,
  updated_at: null,
  habits: [],
  tasks: [],
  plans: [],
  controls: [],
  diary_links: [],
  proposals: [],
});
export const emptyDay = (date: string): Day => ({
  schema_version: 1,
  revision: 0,
  last_operation_id: null,
  updated_at: null,
  business_date: date,
  occurrences: [],
  corrections: [],
});
function diff(a: any, b: any, keys: (string | number)[] = []): Patch[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (
    a &&
    b &&
    typeof a === "object" &&
    typeof b === "object" &&
    Array.isArray(a) === Array.isArray(b)
  ) {
    const out: Patch[] = [];
    for (const k of Object.keys(b)) {
      const key = Array.isArray(b) ? Number(k) : k;
      out.push(...diff(a[k], b[k], [...keys, key]));
    }
    for (const k of Object.keys(a).reverse())
      if (!(k in b))
        out.push({
          keys: [...keys, Array.isArray(a) ? Number(k) : k],
          remove: true,
        });
    return out;
  }
  return [{ keys, value: b }];
}
function apply(value: any, patch: Patch[]) {
  for (const p of patch) {
    if (!p.keys.length) {
      value = p.value;
      continue;
    }
    let current = value;
    for (const k of p.keys.slice(0, -1)) {
      if (["__proto__", "constructor", "prototype"].includes(String(k)))
        throw new Error("Unsafe patch");
      current = current[k];
    }
    const key = p.keys.at(-1)!;
    if (["__proto__", "constructor", "prototype"].includes(String(key)))
      throw new Error("Unsafe patch");
    if (p.remove) {
      if (Array.isArray(current)) current.splice(Number(key), 1);
      else delete current[key];
    } else current[key] = p.value;
  }
  return value;
}
export class Store {
  db!: Database.Database;
  files: VaultFiles;
  lockPath: string;
  fault?: (stage: string) => void;
  recoveryUntil: string | null = null;
  recoveryStartedAt: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private releaseLock?: () => void;
  private lockCompromised = false;
  closed = false;
  constructor(
    public root: string,
    public config: Config,
    public clock = () => new Date(),
  ) {
    this.files = new VaultFiles(root);
    this.files.maxDocumentBytes = config.web.max_document_bytes;
    const data = this.files.resolve(".agent/data", "internal");
    fs.mkdirSync(data, { recursive: true });
    this.lockPath = path.join(data, "core.lock");
    try {
      this.releaseLock = lockSync(data, {
        lockfilePath: this.lockPath,
        stale: 15000,
        update: 5000,
        realpath: true,
        onCompromised: () => {
          this.lockCompromised = true;
        },
      });
    } catch {
      throw new AppError(
        "INSTANCE_LOCKED",
        "已有 Core 正在使用这份笔记，异常退出后的锁将在15秒内过期",
        503,
      );
    }
    try {
      const file = this.files.resolve(config.storage.database, "internal"),
        initialized = path.join(data, ".initialized"),
        existed = fs.existsSync(file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const wasInitialized =
        fs.existsSync(initialized) ||
        fs.existsSync(this.files.resolve(config.storage.registry, "internal"));
      let rebuilt = false;
      try {
        this.db = new Database(file);
        if (this.db.pragma("quick_check", { simple: true }) !== "ok")
          throw new Error("Corrupt database");
      } catch (err) {
        if (this.db!) this.db.close();
        for (const suffix of ["", "-wal", "-shm"])
          if (fs.existsSync(file + suffix))
            fs.renameSync(
              file + suffix,
              file + ".quarantine-" + Date.now() + suffix,
            );
        this.db = new Database(file);
        rebuilt = true;
      }
      if (
        !this.db
          .prepare("SELECT name FROM sqlite_master WHERE name='schema_meta'")
          .get()
      )
        this.db.exec(fs.readFileSync(resource("schema.sql"), "utf8"));
      const schemaVersion = this.db
        .prepare("SELECT max(version) AS version FROM schema_meta")
        .get() as { version: number };
      if (schemaVersion.version !== 1)
        throw new AppError(
          "SCHEMA_UNSUPPORTED",
          "运行库版本与当前服务不兼容，原数据未改写",
          503,
        );
      this.db.pragma("journal_mode=WAL");
      this.db.pragma("foreign_keys=ON");
      this.db.pragma("synchronous=FULL");
      this.db.pragma("busy_timeout=5000");
      const suppression = path.join(data, "recovery-until");
      if (rebuilt || (!existed && wasInitialized)) {
        this.recoveryUntil = DateTime.fromJSDate(this.clock(), {
          zone: config.timezone,
        })
          .plus({ days: 1 })
          .startOf("day")
          .toUTC()
          .toISO()!;
        atomicWrite(suppression, this.recoveryUntil);
        this.recoveryStartedAt = this.now();
        atomicWrite(path.join(data, "recovery-since"), this.recoveryStartedAt);
      }
      if (fs.existsSync(suppression))
        this.recoveryUntil = fs.readFileSync(suppression, "utf8");
      const since = path.join(data, "recovery-since");
      if (fs.existsSync(since))
        this.recoveryStartedAt = fs.readFileSync(since, "utf8");
      atomicWrite(initialized, "1");
      const registry = this.files.resolve(config.storage.registry, "internal");
      if (!fs.existsSync(registry))
        atomicWrite(registry, serialize(emptyRegistry()));
      this.recover();
      this.db
        .prepare(
          "UPDATE outbox SET status='unknown',claimed_until=NULL,updated_at=? WHERE status='sending'",
        )
        .run(this.now());
      this.db
        .prepare("UPDATE inbox SET status='pending' WHERE status='processing'")
        .run();
    } catch (error) {
      if (this.db?.open) this.db.close();
      this.releaseLock?.();
      throw error;
    }
  }
  now() {
    return this.clock().toISOString();
  }
  exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.tail.then(() => {
      if (this.lockCompromised || this.closed)
        throw new AppError("INSTANCE_LOCKED", "服务锁已失效，暂停写入", 503);
      return fn();
    });
    this.tail = next.catch(() => {});
    return next;
  }
  registry(): Registry {
    return JSON.parse(
      fs.readFileSync(
        this.files.resolve(this.config.storage.registry, "internal"),
        "utf8",
      ),
    );
  }
  dayPath(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new AppError("INVALID_DATE", "无效日期", 400);
    return this.config.storage.day_records + "/" + date + ".json";
  }
  day(date: string): Day {
    const p = this.files.resolve(this.dayPath(date), "internal");
    return fs.existsSync(p)
      ? JSON.parse(fs.readFileSync(p, "utf8"))
      : emptyDay(date);
  }
  commit(
    key: string,
    source: string,
    inputId: string,
    mutate: (
      registry: Registry,
      loadDay: (date: string) => Day,
      operation: string,
      rememberFact: (fact: string) => void,
    ) => { ids: string[]; message: string },
  ) {
    if (this.lockCompromised || this.closed)
      throw new AppError("INSTANCE_LOCKED", "服务锁已失效，暂停写入", 503);
    this.recover();
    const prior = this.db
      .prepare("SELECT * FROM events WHERE dedupe_key=?")
      .get(key) as any;
    if (prior) {
      if (prior.status !== "applied")
        throw new AppError("OPERATION_CONFLICT", "先前操作尚未恢复", 409);
      return JSON.parse(prior.payload_json).result;
    }
    const operation = id("op"),
      registry = this.registry(),
      beforeRegistry = structuredClone(registry),
      days = new Map<string, { before: Day; value: Day }>();
    const facts: string[] = [];
    const result = mutate(
      registry,
      (date) => {
        let d = days.get(date);
        if (!d) {
          const value = this.day(date);
          d = { before: structuredClone(value), value };
          days.set(date, d);
        }
        return d.value;
      },
      operation,
      (fact) => {
        if (typeof fact !== "string" || !fact.trim() || fact.length > 500)
          throw new AppError("INVALID_FACT", "偏好记录应简短明确");
        facts.push(fact.replace(/[\r\n]+/g, " ").trim());
      },
    );
    const changes: Change[] = [];
    const capture = (relative: string, before: any, after: any) => {
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      after.revision++;
      after.last_operation_id = operation;
      after.updated_at = this.now();
      const p = this.files.resolve(relative, "internal");
      changes.push({
        path: relative,
        base_hash: fs.existsSync(p) ? hash(fs.readFileSync(p)) : null,
        target_hash: hash(serialize(after)),
        patch: diff(fs.existsSync(p) ? before : null, after),
      });
    };
    capture(this.config.storage.registry, beforeRegistry, registry);
    for (const [date, d] of days)
      capture(this.dayPath(date), d.before, d.value);
    if (facts.length) {
      const relative = ".agent/context/user.md",
        file = this.files.resolve(relative, "internal"),
        before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      const append =
        (before === null ? "# 用户明确偏好\n\n" : "\n") +
        facts
          .map(
            (fact) =>
              "- " +
              fact +
              "（确认于 " +
              this.now() +
              "；输入 " +
              inputId +
              "）",
          )
          .join("\n") +
        "\n";
      changes.push({
        path: relative,
        base_hash: before === null ? null : hash(before),
        target_hash: hash((before ?? "") + append),
        append,
      });
    }
    const payload = {
      changes,
      result: {
        status: "accepted",
        operation_id: operation,
        updated_ids: result.ids,
        message: result.message,
      },
    };
    this.db
      .prepare(
        "INSERT INTO events(id,dedupe_key,input_id,source,kind,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        operation,
        key,
        inputId,
        source,
        "business",
        JSON.stringify(payload),
        this.now(),
      );
    this.fault?.("prepared");
    this.applyChanges(changes);
    this.fault?.("files_applied");
    this.db
      .prepare("UPDATE events SET status='applied',completed_at=? WHERE id=?")
      .run(this.now(), operation);
    return payload.result;
  }
  private applyChanges(changes: Change[]) {
    for (const c of changes) {
      const p = this.files.resolve(c.path, "internal");
      if (!(
        c.path.startsWith(".agent/state/") ||
        (c.path === ".agent/context/user.md" && typeof c.append === "string")
      ))
        throw new AppError("RECOVERY_PATH", "恢复操作越界", 500);
      const raw = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
      if (raw !== null && hash(raw) === c.target_hash) continue;
      if ((raw === null ? null : hash(raw)) !== c.base_hash)
        throw new AppError(
          "RECOVERY_CONFLICT",
          "业务文件发生外部改动，已暂停执行",
          409,
          { path: c.path },
        );
      const updated =
        typeof c.append === "string"
          ? (raw ?? "") + c.append
          : serialize(apply(raw === null ? null : JSON.parse(raw), c.patch!));
      if (hash(updated) !== c.target_hash)
        throw new Error("Recovery hash mismatch");
      atomicWrite(p, updated);
      this.fault?.("file:" + c.path);
    }
  }
  recover() {
    const pending = this.db
      .prepare(
        "SELECT * FROM events WHERE status='prepared' AND kind='business' ORDER BY rowid",
      )
      .all() as any[];
    for (const e of pending) {
      const payload = JSON.parse(e.payload_json);
      this.applyChanges(payload.changes);
      this.db
        .prepare("UPDATE events SET status='applied',completed_at=? WHERE id=?")
        .run(this.now(), e.id);
    }
  }
  document(relative: string) {
    const content = this.files.read(relative),
      contentHash = hash(content);
    try {
      let row = this.db
        .prepare("SELECT * FROM documents WHERE path=?")
        .get(relative) as any;
      if (!row || row.content_hash !== contentHash) {
        this.db
          .prepare(
            "INSERT INTO documents(path,content_hash,version,updated_at) VALUES(?,?,1,?) ON CONFLICT(path) DO UPDATE SET content_hash=excluded.content_hash,version=version+1,updated_at=excluded.updated_at",
          )
          .run(relative, contentHash, this.now());
        row = this.db
          .prepare("SELECT * FROM documents WHERE path=?")
          .get(relative);
      }
      return {
        path: relative,
        content,
        hash: contentHash,
        version: row.version,
        updated_at: row.updated_at,
      };
    } catch {
      return {
        path: relative,
        content,
        hash: contentHash,
        version: 0,
        updated_at: fs
          .statSync(this.files.resolve(relative))
          .mtime.toISOString(),
      };
    }
  }
  index(relative: string) {
    return this.document(relative);
  }
  async close() {
    await this.tail;
    if (this.closed) return;
    this.closed = true;
    if (this.db.open) this.db.close();
    this.releaseLock?.();
  }
}
