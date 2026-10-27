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
import { resource,loadConfig, type Config } from "./config.js";
import { migrateRegistry, validateRegistry } from "./compatibility.js";
import { Clock } from "./clock.js";
import { Lifecycle, type LifecycleState } from "./lifecycle.js";
import { spawnSync } from "node:child_process";
type Patch = { keys: (string | number)[]; value?: unknown; remove?: boolean };
type Change = {
  path: string;
  base_hash: string | null;
  target_hash: string;
  patch?: Patch[];
  append?: string;
};
const emptyRegistry = (): Registry => ({
  schema_version: 2,
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
  readonly generation=id("run");
  compatibility?:{fingerprint:string;manifest:unknown;verify:()=>boolean};
  readonly time:Clock;
  /** Validated runtime state machine; see apps/core/lifecycle.ts. */
  readonly state = new Lifecycle();
  get lifecycle(): LifecycleState {
    return this.state.current;
  }
  set lifecycle(next: LifecycleState) {
    this.state.set(next);
  }
  readonly realtime: boolean;
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
    this.realtime = arguments[2] === undefined;
    this.time=new Clock(this.clock,()=>performance.now(),!this.realtime || process.env.NODE_ENV!=="production" || process.env.SECRETARY_TIME_SYNCHRONIZED==="1",this.realtime);
    this.clock=()=>this.time.read().wallNow;
    this.files = new VaultFiles(root);
    this.files.maxDocumentBytes = config.web.max_document_bytes;
    const data = this.files.resolve(".agent/data", "internal");
    fs.mkdirSync(data, { recursive: true });
    this.lockPath = path.join(data, "core.lock");
    try {
      if(process.platform==="linux") {
        // flock is tied to the shared open-file description, not a wall-clock lease.
        const fd=fs.openSync(path.join(data,"core.process.lock"),"a+",0o600);
        const locked=spawnSync("flock",["-n","3"],{stdio:["ignore","ignore","pipe",fd],timeout:2000});
        if(locked.status!==0) {fs.closeSync(fd);throw new Error("OS_LOCK_UNAVAILABLE");}
        this.releaseLock=()=>fs.closeSync(fd);
      } else {
      this.releaseLock = lockSync(data, {
        lockfilePath: this.lockPath,
        stale: 15000,
        update: 5000,
        realpath: true,
        onCompromised: () => {
          this.lockCompromised = true;
        },
      });
      }
    } catch {
      throw new AppError(
        "INSTANCE_LOCKED",
        "无法取得独占写锁；已有 Core 写者或操作系统锁不可用",
        503,
      );
    }
    // Residual parent-directory TOCTOU: resolveChecked validates every path
    // component with lstat, then opens the leaf with O_NOFOLLOW and fstat. A
    // host-level actor could still swap a parent directory in between. That is
    // out of scope because the vault has exactly one trusted writer, and this
    // guard makes the precondition explicit: if the writer lock is lost, file
    // access stops instead of silently continuing.
    this.files.writerGuard = () => !!this.releaseLock && !this.lockCompromised && !this.closed;
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
      if(!(this.db.pragma("table_info(schema_meta)") as {name:string}[]).some(c=>c.name==="runtime_json"))
        this.db.exec("ALTER TABLE schema_meta ADD COLUMN runtime_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(runtime_json))");
      this.db.pragma("journal_mode=WAL");
      this.db.pragma("foreign_keys=ON");
      this.db.pragma("synchronous=FULL");
      this.db.pragma("busy_timeout=5000");
      const suppression = path.join(data, "recovery-until");
      if (rebuilt || (!existed && wasInitialized)) {
        this.updateRuntimeMeta(meta=>({...meta,recovery_guard:{active:true,reason:"RUNTIME_REBUILT",created_at:this.now()},
          restore_boundary:this.now(),budget_guard:true,budget_guard_day:DateTime.fromJSDate(this.clock(),{zone:config.timezone}).toISODate()}));
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
      this.lifecycle="recovering";
      this.recover();
      const beforeMigration = JSON.parse(fs.readFileSync(registry,"utf8"));
      if(beforeMigration.schema_version===1) {
        this.lifecycle="migrating";
        const migrated=migrateRegistry(beforeMigration,this.now());
        this.commit("registry-migration:v2","maintenance","registry-migration",r=>{
          Object.assign(r,migrated);return {ids:[],message:"业务真源已升级为v2；未推断历史授权"};
        });
      } else validateRegistry(beforeMigration);
      this.db
        .prepare(
          "UPDATE outbox SET status='unknown',claimed_until=NULL,updated_at=? WHERE status='sending'",
        )
        .run(this.now());
      this.db
        .prepare("UPDATE inbox SET status='pending',metadata_json=json_set(metadata_json,'$.interrupted',1) WHERE status='processing'")
        .run();
      this.updateRuntimeMeta(meta=>({...meta,generation:this.generation}));
      this.enterServing();
    } catch (error) {
      if (this.db?.open) this.db.close();
      this.releaseLock?.();
      throw error;
    }
  }
  /**
   * Startup decides the serving mode from persisted recovery state rather than
   * assuming success: a restored or rebuilt runtime serves business writes as
   * degraded until the recovery guard is explicitly reviewed.
   */
  private enterServing() {
    this.lifecycle = "ready";
    const reasons: string[] = [];
    try {
      if (this.runtimeMeta().recovery_guard?.active) reasons.push("RECOVERY_GUARD_ACTIVE");
    } catch {
      reasons.push("RECOVERY_STATE_UNREADABLE");
    }
    if (this.recoveryUntil && Date.parse(this.recoveryUntil) > Date.parse(this.now()))
      reasons.push("REPLAY_WINDOW_OPEN");
    if (reasons.length) this.state.degrade(...reasons);
  }
  now() {
    return this.clock().toISOString();
  }
  runtimeMeta():Record<string,any> {
    return JSON.parse((this.db.prepare("SELECT runtime_json FROM schema_meta WHERE version=1").get() as {runtime_json:string}).runtime_json);
  }
  updateRuntimeMeta(change:(meta:Record<string,any>)=>Record<string,any>) {
    return this.db.transaction(()=>{
      const next=change(this.runtimeMeta());
      this.db.prepare("UPDATE schema_meta SET runtime_json=? WHERE version=1").run(JSON.stringify(next));
      return next;
    })();
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
  private unresolvedBusiness = false;
  private readBarrier() {
    if (this.db.open) this.recover();
    else if (this.unresolvedBusiness)
      throw new AppError("RUNTIME_UNAVAILABLE", "未完成提交无法核对，暂不读取业务状态", 503);
  }
  registry(): Registry {
    this.readBarrier();
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
    this.readBarrier();
    const p = this.files.resolve(this.dayPath(date), "internal");
    return fs.existsSync(p)
      ? JSON.parse(fs.readFileSync(p, "utf8"))
      : emptyDay(date);
  }
  exportData() {
    this.recover();
    const paths = new Set(this.files.list()),
      walk = (relative: string, accept: (p: string) => boolean) => {
        const dir = this.files.resolve(relative, "internal");
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = relative + "/" + entry.name;
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory() && relative.startsWith(".agent/state"))
            walk(p, accept);
          else if (entry.isFile() && accept(p)) paths.add(p);
        }
      };
    walk("Attachment", (p) => !path.posix.basename(p).startsWith("."));
    walk(".agent/state", (p) => p.endsWith(".json"));
    walk(".agent/context", (p) => p.endsWith(".md"));
    let bytes = 0;
    const files = [...paths].sort().map((p) => {
      const file = this.files.resolve(p, "internal"),
        size = fs.statSync(file).size;
      bytes += size;
      if (paths.size > 10000 || bytes > 48 * 1024 * 1024)
        throw new AppError(
          "EXPORT_TOO_LARGE",
          "当前库超过在线导出上限，请使用维护说明中的离线数据备份",
          413,
        );
      const content = this.files.readBytes(p,"internal",48*1024*1024);
      return {
        path: p,
        encoding: p.startsWith("Attachment/") ? "base64" : "utf8",
        content: content.toString(
          p.startsWith("Attachment/") ? "base64" : "utf8",
        ),
        hash: hash(content),
      };
    });
    return {
      format: "secretary-export",
      version: 1,
      exported_at: this.now(),
      timezone: this.config.timezone,
      configuration:structuredClone(this.config),
      storage: {
        registry: this.config.storage.registry,
        day_records: this.config.storage.day_records,
      },
      files,
    };
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
    ) => { ids: string[]; message: string; effects?: unknown },
    logicalGroups: {identity:string;fingerprint:string}[] = [],
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
    validateRegistry(registry);
    const changes: Change[] = [];
    const capture = (relative: string, before: any, after: any) => {
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      after.revision++;
      after.last_operation_id = operation;
      after.updated_at = this.now();
      const p = this.files.resolve(relative, "internal");
      // JSON object order is not business state. Hash the actual patch result so
      // replacing an object with reordered keys remains recoverable after a crash.
      const base = fs.existsSync(p) ? before : null,
        patch = diff(base, JSON.parse(serialize(after))),
        persisted = serialize(
          apply(structuredClone(base), structuredClone(patch)),
        );
      changes.push({
        path: relative,
        base_hash: fs.existsSync(p) ? hash(fs.readFileSync(p)) : null,
        target_hash: hash(persisted),
        patch,
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
    const origin=this.db.prepare("SELECT metadata_json FROM inbox WHERE id=?").get(inputId) as {metadata_json:string}|undefined;
    const grant=origin?JSON.parse(origin.metadata_json).background_grant:null;
    const payload = {
      ...(grant?{work_binding:{work_id:grant.work_id,step_id:grant.step_id,grant_id:grant.id}}:{}),
      ...(logicalGroups.length ? {logical_groups:logicalGroups} : {}),
      changes,
      result: {
        status: "accepted",
        operation_id: operation,
        updated_ids: result.ids,
        message: result.message,
        ...(result.effects ? { effects: result.effects } : {}),
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
    this.unresolvedBusiness = true;
    this.fault?.("prepared");
    this.applyChanges(changes);
    this.fault?.("files_applied");
    this.db
      .prepare("UPDATE events SET status='applied',completed_at=? WHERE id=?")
      .run(this.now(), operation);
    this.unresolvedBusiness = false;
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
    if (pending.length) this.unresolvedBusiness = true;
    for (const e of pending) {
      const payload = JSON.parse(e.payload_json);
      this.applyChanges(payload.changes);
      this.db
        .prepare("UPDATE events SET status='applied',completed_at=? WHERE id=?")
        .run(this.now(), e.id);
    }
    this.unresolvedBusiness = false;
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
    this.lifecycle="stopped";
    if (this.db.open) this.db.close();
    this.releaseLock?.();
  }
}

/** Offline restore only: no merge, no executable files, and no imported delivery queue. */
function restoreDataIntoStage(root: string, payload: unknown) {
  const data = payload as any;
  if (
    !data ||
    data.format !== "secretary-export" ||
    data.version !== 1 ||
    !Array.isArray(data.files) ||
    data.files.length > 10000 ||
    typeof data.timezone !== "string" ||
    !DateTime.now().setZone(data.timezone).isValid ||
    !/^\.agent\/state\/[^/]+\.json$/.test(data.storage?.registry ?? "") ||
    !/^\.agent\/state\/(?:[^/.][^/]*\/)*[^/.][^/]*$/.test(
      data.storage?.day_records ?? "",
    )
  )
    throw new AppError("EXPORT_INVALID", "导出文件格式或时区无效");
  const files = new VaultFiles(root);
  if (fs.readdirSync(files.root).length)
    throw new AppError("RESTORE_NOT_EMPTY", "仅允许恢复到新的空数据目录", 409);
  const seen = new Set<string>();
  let bytes = 0;
  const decoded = data.files.map((entry: any) => {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      typeof entry.content !== "string" ||
      !["utf8", "base64"].includes(entry.encoding) ||
      seen.has(entry.path)
    )
      throw new AppError("EXPORT_INVALID", "文件记录无效或重复");
    const p = entry.path;
    if (
      !(p.startsWith("Attachment/")
        ? /^Attachment\/[^/.][^/]*$/.test(p) && entry.encoding === "base64"
        : entry.encoding === "utf8" &&
          ((p.endsWith(".md") &&
            !p.split("/").some((x: string) => x.startsWith("."))) ||
            /^\.agent\/context\/[^/]+\.md$/.test(p) ||
            /^\.agent\/state\/(?:[^/]+\/)*[^/]+\.json$/.test(p)))
    )
      throw new AppError("EXPORT_INVALID", "导出含有不允许恢复的文件");
    const file = files.resolve(p, "internal"),
      content = Buffer.from(entry.content, entry.encoding);
    seen.add(p);
    bytes += content.length;
    if (bytes > 48 * 1024 * 1024 || hash(content) !== entry.hash)
      throw new AppError("EXPORT_INVALID", "导出校验失败或超出大小上限");
    if (p.startsWith(".agent/state/")) {
      const state = JSON.parse(content.toString("utf8"));
      // The registry and daily records are versioned business documents.
      // Older auxiliary metadata (for example an inert channel binding) has
      // schema_version but no revision; preserve its bytes without treating it
      // as routing authority or silently dropping it from an export.
      const versioned =
        p === data.storage.registry ||
        p.startsWith(data.storage.day_records + "/");
      if (
        !state ||
        typeof state !== "object" ||
        Array.isArray(state) ||
        !(p===data.storage.registry ? [1,2].includes(state.schema_version) : state.schema_version===1) ||
        (versioned && !Number.isInteger(state.revision)) ||
        (state.revision !== undefined && !Number.isInteger(state.revision))
      )
        throw new AppError("EXPORT_INVALID", "状态格式不兼容");
    }
    return { file, content };
  });
  if (!seen.has(data.storage.registry))
    throw new AppError("EXPORT_INVALID", "缺少长期状态文件");
  const registry = JSON.parse(
    decoded
      .find(
        (x: any) => x.file === files.resolve(data.storage.registry, "internal"),
      )!
      .content.toString("utf8"),
  );
  if (
    !["tasks", "habits", "plans", "controls", "diary_links", "proposals"].every(
      (k) => Array.isArray(registry[k]),
    )
  )
    throw new AppError("EXPORT_INVALID", "长期状态格式无效");
  for (const item of decoded) atomicWrite(item.file, item.content);
  atomicWrite(
    files.resolve(".agent/config.json", "internal"),
    serialize(data.configuration??{ timezone: data.timezone, storage: data.storage }),
  );
  const configuration=loadConfig(root);
  if(configuration.timezone!==data.timezone || configuration.storage.registry!==data.storage.registry || configuration.storage.day_records!==data.storage.day_records)
    throw new AppError("EXPORT_INVALID","备份配置与清单不一致");
  // A newly reconstructed runtime must suppress old reminders before accepting new work.
  atomicWrite(files.resolve(".agent/data/.initialized", "internal"), "1");
  return { restored_files: decoded.length, active_delivery_restored: false };
}

/** Validate and initialize everything off to the side, then publish one complete directory. */
export function restoreData(root:string,payload:unknown) {
  const target=path.resolve(root),parent=path.dirname(target);
  if(target===parent || fs.existsSync(target) && (fs.lstatSync(target).isSymbolicLink() || !fs.statSync(target).isDirectory() || fs.readdirSync(target).length))
    throw new AppError("RESTORE_NOT_EMPTY","仅允许恢复到非挂载的新空数据目录",409);
  if(fs.existsSync(target) && fs.statSync(target).dev!==fs.statSync(parent).dev)
    throw new AppError("RESTORE_MOUNT_TARGET","不能替换挂载目录",409);
  if(process.platform==="linux" && fs.readFileSync("/proc/self/mountinfo","utf8").split("\n").some(line=>
    line.split(" ")[4]?.replace(/\\040/g," ")===target))throw new AppError("RESTORE_MOUNT_TARGET","不能替换挂载目录",409);
  const stage=fs.mkdtempSync(path.join(parent,".secretary-restore-"));
  try {
    const result=restoreDataIntoStage(stage,payload);
    const data=payload as any,reg=JSON.parse(fs.readFileSync(path.join(stage,data.storage.registry),"utf8"));
    validateRegistry(migrateRegistry(reg,new Date().toISOString()));
    const dir=path.join(stage,".agent/data"),restoredConfig=loadConfig(stage),database=path.join(stage,restoredConfig.storage.database);
    fs.mkdirSync(path.dirname(database),{recursive:true,mode:0o700});
    const db=new Database(database);
    try {
      db.exec(fs.readFileSync(resource("schema.sql"),"utf8"));
      db.pragma("journal_mode=WAL");db.pragma("synchronous=FULL");
      const now=new Date().toISOString();
      db.prepare("UPDATE schema_meta SET runtime_json=? WHERE version=1").run(JSON.stringify({generation:id("restore"),restore_boundary:now,
        recovery_guard:{active:true,reason:"BACKUP_RESTORED",created_at:now},budget_guard:true,
        budget_guard_day:DateTime.fromISO(now,{zone:data.timezone}).toISODate()}));
      db.pragma("wal_checkpoint(TRUNCATE)");
    }finally{db.close();}
    atomicWrite(path.join(dir,"recovery-since"),new Date().toISOString());
    atomicWrite(path.join(dir,"recovery-until"),DateTime.now().setZone(data.timezone).plus({days:1}).startOf("day").toUTC().toISO()!);
    if(process.platform!=="win32") {
      const syncTree=(directory:string)=>{
        for(const entry of fs.readdirSync(directory,{withFileTypes:true}))if(entry.isDirectory())syncTree(path.join(directory,entry.name));
        const fd=fs.openSync(directory,"r");try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      };syncTree(stage);
    }
    // No user file was touched before complete validation. The final target is still required to be empty.
    // Windows refuses to rename a directory into a path whose directory entry was just removed
    // (EBUSY), so an empty target is moved aside first and only discarded after publish succeeds.
    const sleepSync=(ms:number)=>{const until=Date.now()+ms;while(Date.now()<until){/* bounded spin */}};
    const retryRename=(from:string,to:string)=>{
      let last:unknown;
      for(let attempt=0;attempt<8;attempt++){
        try{fs.renameSync(from,to);return;}catch(error){
          last=error;const code=(error as NodeJS.ErrnoException).code;
          if(!["EBUSY","EPERM","EACCES","ENOTEMPTY"].includes(code??""))throw error;
          sleepSync(25*(attempt+1));
        }
      }
      throw last;
    };
    const aside=fs.existsSync(target)?path.join(parent,`.secretary-replaced-${id("restore").replace(/[^a-zA-Z0-9]/g,"").slice(0,12)}`):null;
    if(aside)retryRename(target,aside);
    try{retryRename(stage,target);}
    catch(error){
      if(aside){try{retryRename(aside,target);}catch{/* keep the aside copy for manual recovery */}}
      throw error;
    }
    if(aside){try{fs.rmSync(aside,{recursive:true,force:true});}catch{/* harmless leftover of an empty directory */}}
    if(process.platform!=="win32") {const fd=fs.openSync(parent,"r");try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
    return {...result,recovery_guard:true};
  } catch(error) {
    const verified=path.resolve(stage);
    if(path.dirname(verified)!==parent || !path.basename(verified).startsWith(".secretary-restore-"))throw new Error("UNSAFE_RESTORE_CLEANUP");
    fs.rmSync(verified,{recursive:true,force:true});
    throw error;
  }
}
