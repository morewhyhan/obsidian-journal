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
import { FACTS_PATH, appendFactTo, readFacts } from "./facts.js";
import {
  emptyFactFile,
  validateFactFile,
  type FactFile,
} from "../../packages/contracts/facts.js";
import type { RevocationRecord } from "./facts.js";
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
      // A process killed outright cannot release its lock. Wait out one stale
      // window (and take over only a lock nobody is refreshing) instead of
      // refusing to start until someone deletes it by hand.
      this.releaseLock = acquireVaultLock(data, this.lockPath, () => {
        this.lockCompromised = true;
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
      // Revocation markers live only in SQLite: an older Markdown/JSON snapshot
      // can restore content, never the fact that it was forgotten.
      this.db.exec(`CREATE TABLE IF NOT EXISTS fact_usage (
      fact_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      at TEXT NOT NULL,
      applied INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(fact_id,event_id)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS revocations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_version INTEGER NOT NULL,
        scope_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(scope_json)),
        reason_code TEXT NOT NULL,
        revoked_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS revocations_target_idx ON revocations(kind, target_id);`);
      // Cleanup obligation for a revocation: "done" only after the original chat
      // fragment is cleared, so a receipt can never claim an unverified erase.
      if(!(this.db.pragma("table_info(revocations)") as {name:string}[]).some(c=>c.name==="cleanup_state"))
        this.db.exec("ALTER TABLE revocations ADD COLUMN cleanup_state TEXT NOT NULL DEFAULT 'pending'");
      if(!(this.db.pragma("table_info(revocations)") as {name:string}[]).some(c=>c.name==="legacy_line_hash"))
        this.db.exec("ALTER TABLE revocations ADD COLUMN legacy_line_hash TEXT");
      if(!(this.db.pragma("table_info(revocations)") as {name:string}[]).some(c=>c.name==="cleaned_at"))
        this.db.exec("ALTER TABLE revocations ADD COLUMN cleaned_at TEXT");
      if(!(this.db.pragma("table_info(inbox)") as {name:string}[]).some(c=>c.name==="seq"))
        this.db.exec("ALTER TABLE inbox ADD COLUMN seq INTEGER NOT NULL DEFAULT 0");
      // Understanding is recorded separately from authorization and survives restarts:
      // an unclassified newer message holds older writes, a classified unrelated one does not.
      if(!(this.db.pragma("table_info(inbox)") as {name:string}[]).some(c=>c.name==="classification"))
        this.db.exec("ALTER TABLE inbox ADD COLUMN classification TEXT NOT NULL DEFAULT 'unclassified'");
      if(!(this.db.pragma("table_info(inbox)") as {name:string}[]).some(c=>c.name==="interpretation_json"))
        this.db.exec("ALTER TABLE inbox ADD COLUMN interpretation_json TEXT CHECK(interpretation_json IS NULL OR json_valid(interpretation_json))");
      if(!(this.db.pragma("table_info(outbox)") as {name:string}[]).some(c=>c.name==="metadata_json"))
        this.db.exec("ALTER TABLE outbox ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json))");
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
      // A model job belongs to the process that started it. One that outlived
      // its process blocks the startup self-test forever: the job looks active,
      // so nothing runs, so nothing ever finishes it. Drop it with the restart.
      this.updateRuntimeMeta(meta=>{
        const job=meta.model_job as {generation?:string;deadline_at?:string}|null|undefined;
        const stale=!!job && (job.generation!==this.generation ||
          !job.deadline_at || Date.parse(job.deadline_at)<=Date.parse(this.now()));
        return {...meta,generation:this.generation,...(stale?{model_job:null}:{})};
      });
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
  /** An unreadable truth file is a typed outage, not a raw filesystem error. */
  #readTruth(relative: string): string {
    try {
      return fs.readFileSync(this.files.resolve(relative, "internal"), "utf8");
    } catch (error: any) {
      throw new AppError(
        "STORAGE_UNAVAILABLE",
        "业务文件暂不可读，本次操作没有保存",
        503,
        { code: error?.code ?? null },
      );
    }
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
      this.#readTruth(this.config.storage.registry),
    );
  }
  /** Monotonic business view number, published after files reach their target hashes. */
  private recordRevocations(rows: RevocationRecord[]) {
    for (const row of rows) {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO revocations(id,kind,target_id,target_version,scope_json,reason_code,revoked_at,cleanup_state,legacy_line_hash) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(id("rev"), row.kind, row.target_id, row.target_version, JSON.stringify(row.scope),
          row.reason_code, row.revoked_at, row.cleanup_state ?? "pending", row.legacy_line_hash ?? null);
    }
    if (rows.length)
      this.updateRuntimeMeta((meta) => ({
        ...meta,
        revocation_revision: Math.max(0, Number(meta.revocation_revision ?? 0)) + rows.length,
      }));
  }
  revocationRevision() {
    const value = Number(this.runtimeMeta().revocation_revision ?? 0);
    return Number.isInteger(value) && value >= 0 ? value : 0;
  }
  /**
   * Offline maintenance only: adopts a newer revocation list exported by the
   * instance that was live after the backup. Markers are opaque (no bodies), so
   * importing them can only suppress content, never reveal it.
   */
  importRevocations(payload: unknown) {
    const data = payload as { revision?: unknown; entries?: unknown };
    const entries = Array.isArray(data?.entries) ? data.entries : null;
    if (!entries || !Number.isInteger(data?.revision) || (data!.revision as number) < entries.length || entries.length > 20000)
      throw new AppError("EXPORT_INVALID", "撤销清单格式不兼容");
    const rows = entries.map((raw) => {
      const e = raw as Record<string, unknown>;
      if (!e || e.kind !== "fact" || typeof e.target_id !== "string" || !e.target_id ||
        !Number.isInteger(e.target_version) || (e.target_version as number) < 1 ||
        !Array.isArray(e.scope) || e.scope.some((x) => typeof x !== "string") ||
        typeof e.reason_code !== "string" || typeof e.revoked_at !== "string")
        throw new AppError("EXPORT_INVALID", "撤销清单条目无效");
      return {
        kind: "fact" as const,
        target_id: e.target_id,
        target_version: e.target_version as number,
        scope: e.scope as string[],
        reason_code: e.reason_code,
        revoked_at: e.revoked_at,
        cleanup_state: e.cleanup_state === "done" ? ("done" as const) : ("pending" as const),
      };
    });
    let imported = 0;
    this.db.transaction(() => {
      for (const row of rows) {
        const result = this.db
          .prepare(
            "INSERT OR IGNORE INTO revocations(id,kind,target_id,target_version,scope_json,reason_code,revoked_at,cleanup_state) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(id("rev"), row.kind, row.target_id, row.target_version, JSON.stringify(row.scope),
            row.reason_code, row.revoked_at, row.cleanup_state);
        imported += result.changes ? 1 : 0;
      }
      this.updateRuntimeMeta((meta) => ({
        ...meta,
        revocation_revision: Math.max(Number(meta.revocation_revision ?? 0), data!.revision as number),
        revocation_history: { source: "imported", revision: data!.revision, complete: true, checked_at: this.now() },
      }));
    })();
    return { imported, revision: data!.revision as number, complete: true as const };
  }
  snapshotRevision() {
    const value = Number(this.runtimeMeta().snapshot_revision ?? 0);
    return Number.isInteger(value) && value >= 0 ? value : 0;
  }
  private publishRevision() {
    this.updateRuntimeMeta((meta) => ({
      ...meta,
      snapshot_revision: Math.max(0, Number(meta.snapshot_revision ?? 0)) + 1,
    }));
  }
  /**
   * One consistent business view: registry, requested days and requested files
   * read after the recovery barrier, tagged with the revision they belong to.
   * Callers must not keep using it after a later commit; compare the revision.
   */
  readSnapshot(scope: { days?: string[]; files?: string[] } = {}) {
    this.readBarrier();
    const registry = this.registry();
    const days: Record<string, Day> = {};
    for (const date of scope.days ?? []) days[date] = this.day(date);
    const files: Record<string, { path: string; content: string; hash: string; version: number }> = {};
    for (const relative of scope.files ?? []) {
      const content = this.files.read(relative);
      const row = this.db
        .prepare("SELECT version FROM documents WHERE path=?")
        .get(relative) as { version: number } | undefined;
      files[relative] = { path: relative, content, hash: hash(content), version: row?.version ?? 0 };
    }
    return { registry, days, files, snapshot_revision: this.snapshotRevision(), read_at: this.now() };
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
    walk(".agent/context", (p) => p.endsWith(".md") || p === FACTS_PATH);
    // Prompt overrides are part of the effective runtime combination; a restore
    // that dropped them would silently swap the persona back to the defaults.
    walk(".agent/prompts", (p) => p.endsWith(".md"));
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
      // The marker list is part of a backup's evidence, never its content: a
      // restore that dropped it would resurrect content the user forgot.
      revocations: {
        revision: this.revocationRevision(),
        entries: (
          this.db
            .prepare(
              "SELECT kind,target_id,target_version,scope_json,reason_code,revoked_at,cleanup_state,legacy_line_hash FROM revocations ORDER BY rowid",
            )
            .all() as any[]
        ).map((row) => ({
          kind: row.kind,
          target_id: row.target_id,
          target_version: row.target_version,
          scope: JSON.parse(row.scope_json),
          reason_code: row.reason_code,
          revoked_at: row.revoked_at,
          cleanup_state: row.cleanup_state,
          legacy_line_hash: row.legacy_line_hash ?? undefined,
        })),
      },
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
    ) => { ids: string[]; message: string; effects?: unknown; facts?: FactFile; revocations?: RevocationRecord[] },
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
    if (result.facts) {
      // One structured write path: new facts go to facts.json, never to user.md.
      // The prepared patch stays a diff so old facts are not copied into events.
      const file = this.files.resolve(FACTS_PATH, "internal"),
        before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      const baseValue: FactFile | null = before
        ? validateFactFile(JSON.parse(before))
        : null;
      const next = validateFactFile(result.facts);
      if (serialize(baseValue ?? emptyFactFile()) !== serialize(next))
        changes.push({
          path: FACTS_PATH,
          base_hash: before === null ? null : hash(before),
          target_hash: hash(serialize(next)),
          patch: diff(baseValue, JSON.parse(serialize(next))),
        });
    }
    const origin=this.db.prepare("SELECT metadata_json FROM inbox WHERE id=?").get(inputId) as {metadata_json:string}|undefined;
    const grant=origin?JSON.parse(origin.metadata_json).background_grant:null;
    const revocations = result.revocations ?? [];
    const payload = {
      ...(grant?{work_binding:{work_id:grant.work_id,step_id:grant.step_id,grant_id:grant.id}}:{}),
      ...(logicalGroups.length ? {logical_groups:logicalGroups} : {}),
      ...(revocations.length ? {revocations} : {}),
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
    // The view number publishes with the applied marker, never before the files.
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE events SET status='applied',completed_at=? WHERE id=?")
        .run(this.now(), operation);
      this.publishRevision();
      this.recordRevocations(revocations);
    })();
    this.unresolvedBusiness = false;
    return payload.result;
  }
  private applyChanges(changes: Change[]) {
    for (const c of changes) {
      const p = this.files.resolve(c.path, "internal");
      if (!(
        c.path.startsWith(".agent/state/") ||
        (c.path === ".agent/context/user.md" && typeof c.append === "string") ||
        (c.path === FACTS_PATH && Array.isArray(c.patch))
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
      try {
        this.applyChanges(payload.changes);
      } catch (error) {
        // A file changed by someone else is a conflict to review, not a rollback:
        // the user's edit stays, the operation is recorded and reads stay blocked.
        if (error instanceof AppError && error.code === "RECOVERY_CONFLICT") {
          this.db
            .prepare(
              "UPDATE events SET status='conflict',error_code='RECOVERY_CONFLICT',payload_json=? WHERE id=?",
            )
            .run(
              JSON.stringify({
                ...payload,
                recovery_conflict: { path: (error.details as any)?.path ?? null, at: this.now() },
              }),
              e.id,
            );
          continue;
        }
        throw error;
      }
      this.db.transaction(() => {
        this.db
          .prepare("UPDATE events SET status='applied',completed_at=? WHERE id=?")
          .run(this.now(), e.id);
        this.publishRevision();
        this.recordRevocations(payload.revocations ?? []);
      })();
    }
    this.unresolvedBusiness =
      this.db
        .prepare("SELECT 1 FROM events WHERE status IN ('prepared','conflict') AND kind='business' LIMIT 1")
        .get() !== undefined;
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
            p === FACTS_PATH ||
            /^\.agent\/prompts\/[^/]+\.md$/.test(p) ||
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
    // Long-lived facts are validated before the backup replaces a live vault.
    const factsFile=path.join(stage,FACTS_PATH);
    if(fs.existsSync(factsFile))validateFactFile(JSON.parse(fs.readFileSync(factsFile,"utf8")));
    const dir=path.join(stage,".agent/data"),restoredConfig=loadConfig(stage),database=path.join(stage,restoredConfig.storage.database);
    fs.mkdirSync(path.dirname(database),{recursive:true,mode:0o700});
    const db=new Database(database);
    try {
      db.exec(fs.readFileSync(resource("schema.sql"),"utf8"));
      db.pragma("journal_mode=WAL");db.pragma("synchronous=FULL");
      const now=new Date().toISOString();
      // Import the backup's marker list before the runtime becomes usable, so a
      // restored older body can never outrank a revocation the backup knew about.
      const carried=(payload as any).revocations, entries=Array.isArray(carried?.entries)?carried.entries:[];
      if(carried!==undefined && (!carried || typeof carried!=="object" || !Number.isInteger(carried.revision) || carried.revision<entries.length ||
        entries.length>20000 || entries.some((e:any)=>!e || e.kind!=="fact" || typeof e.target_id!=="string" || !e.target_id ||
          !Number.isInteger(e.target_version) || e.target_version<1 || !Array.isArray(e.scope) || e.scope.some((x:any)=>typeof x!=="string") ||
          typeof e.reason_code!=="string" || typeof e.revoked_at!=="string")))
        throw new AppError("EXPORT_INVALID","备份的撤销清单格式不兼容");
      const insertMarker=db.prepare("INSERT OR IGNORE INTO revocations(id,kind,target_id,target_version,scope_json,reason_code,revoked_at,cleanup_state) VALUES(?,?,?,?,?,?,?,?)");
      for(const e of entries as any[])
        insertMarker.run(id("rev"),e.kind,e.target_id,e.target_version,JSON.stringify(e.scope),e.reason_code,e.revoked_at,
          e.cleanup_state==="done"?"done":"pending");
      const carriedRevision=Number.isInteger(carried?.revision)?carried.revision:entries.length;
      db.prepare("UPDATE schema_meta SET runtime_json=? WHERE version=1").run(JSON.stringify({generation:id("restore"),restore_boundary:now,
        recovery_guard:{active:true,reason:"BACKUP_RESTORED",created_at:now},budget_guard:true,
        budget_guard_day:DateTime.fromISO(now,{zone:data.timezone}).toISODate(),
        revocation_revision:carriedRevision,
        // Deletions after this backup cannot be known from the backup itself.
        revocation_history:{source:carried===undefined?"absent":"backup",revision:carriedRevision,complete:false,checked_at:now}}));
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

function sleepSync(ms: number) {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

function acquireVaultLock(data: string, lockPath: string, onCompromised: () => void): () => void {
  const stale = 8000;
  const ownerPath = lockPath + ".owner.json";
  const deadline = Date.now() + 30000;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (;;) {
    try {
      const release = lockSync(data, {
        lockfilePath: lockPath,
        stale,
        update: 2000,
        realpath: true,
        onCompromised,
      });
      try {
        fs.writeFileSync(
          ownerPath,
          JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
          { mode: 0o600 },
        );
      } catch {
        /* the owner record is an optimisation, not a requirement */
      }
      return () => {
        try {
          fs.rmSync(ownerPath, { force: true });
        } catch {
          /* already gone */
        }
        release();
      };
    } catch (error) {
      let owner: { pid?: number } | null = null;
      try {
        owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
      } catch {
        owner = null;
      }
      // This process already owns the vault: a second Core must fail at once,
      // never wait for a takeover of its own lock.
      if (owner?.pid === process.pid) throw error;
      // The recorded writer is gone: its lock may be taken over at once.
      const ownerDead = !!owner?.pid && !alive(owner.pid);
      if (ownerDead || !owner) {
        const age = (() => {
          try {
            return Date.now() - fs.statSync(lockPath).mtimeMs;
          } catch {
            return Number.POSITIVE_INFINITY;
          }
        })();
        if (ownerDead || age > stale) {
          try {
            fs.rmSync(lockPath, { recursive: true, force: true });
          } catch {
            /* someone else removed it */
          }
          try {
            fs.rmSync(ownerPath, { force: true });
          } catch {
            /* nothing to clean */
          }
          continue;
        }
      }
      // A live writer keeps refreshing its lock: refuse promptly.
      if (owner?.pid && owner.pid !== process.pid && alive(owner.pid)) throw error;
      if (Date.now() > deadline) throw error;
      sleepSync(500);
    }
  }
}
