import fs from "node:fs";
import path from "node:path";
import { AppError } from "../../packages/contracts/types.js";
import {
  markdownLinks,
  replaceLinkTargets,
} from "../../packages/contracts/markdown.js";
import { atomicWrite, hash, id } from "./files.js";
import type { Store } from "./store.js";
type Rename = {
  old: string;
  next: string;
  content_hash: string;
  warnings: string[];
};
export class DocumentOperations {
  constructor(private store: Store) {
    this.recover();
  }
  private applyRename(event: any) {
    const data = JSON.parse(event.payload_json) as Rename,
      s = this.store,
      old = s.files.resolve(data.old),
      next = s.files.resolve(data.next);
    if (fs.existsSync(old) && !fs.existsSync(next)) {
      if (hash(fs.readFileSync(old)) !== data.content_hash)
        throw new AppError("RENAME_CONFLICT", "原文件在恢复前已变化", 409);
      fs.mkdirSync(path.dirname(next), { recursive: true });
      fs.renameSync(old, next);
      s.fault?.("document_renamed");
    } else if (
      fs.existsSync(old) ||
      !fs.existsSync(next) ||
      hash(fs.readFileSync(next)) !== data.content_hash
    )
      throw new AppError(
        "RENAME_CONFLICT",
        "重命名存在冲突，未覆盖任何文件",
        409,
      );
    s.commit(
      event.id + ":bindings",
      "web",
      event.input_id,
      (registry, _, operation) => {
        for (const link of registry.diary_links)
          if (link.path === data.old) {
            link.business_date ??= data.old.match(
              /(\d{4}-\d{2}-\d{2})\.md$/,
            )?.[1];
            link.path = data.next;
            link.version++;
            link.updated_at = s.now();
            link.last_operation_id = operation;
          }
        for (const target of [...registry.habits, ...registry.tasks])
          for (const ref of target.note_refs)
            if (ref.path === data.old) {
              ref.path = data.next;
              target.version++;
              target.updated_at = s.now();
              target.last_operation_id = operation;
            }
        return { ids: [], message: "明确关联已更新" };
      },
    );
    s.db.prepare("DELETE FROM documents WHERE path=?").run(data.old);
    s.index(data.next);
    s.db
      .prepare("UPDATE events SET status='applied',completed_at=? WHERE id=?")
      .run(s.now(), event.id);
  }
  private applyLinks(event: any) {
    const data = JSON.parse(event.payload_json),
      relative = event.document_path,
      content = this.store.files.read(relative),
      current = hash(content);
    if (current !== data.target_hash) {
      if (current !== data.base_hash)
        throw new AppError(
          "BACKLINK_CONFLICT",
          "引用笔记已变化，保留当前内容",
          409,
        );
      const next = replaceLinkTargets(content, data.edits);
      if (hash(next) !== data.target_hash)
        throw new Error("Recovery hash mismatch");
      atomicWrite(this.store.files.resolve(relative), next);
      this.store.fault?.("backlink_written");
    }
    this.store.index(relative);
    this.store.db
      .prepare("UPDATE events SET status='applied',completed_at=? WHERE id=?")
      .run(this.store.now(), event.id);
  }
  recover() {
    const s = this.store;
    for (const event of s.db
      .prepare(
        "SELECT * FROM events WHERE kind='document_rename' AND status='prepared' ORDER BY rowid",
      )
      .all() as any[])
      this.applyRename(event);
    for (const event of s.db
      .prepare(
        "SELECT * FROM events WHERE kind='backlink_edit' AND status='prepared' ORDER BY rowid",
      )
      .all() as any[]) {
      try {
        this.applyLinks(event);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        s.db
          .prepare(
            "UPDATE events SET status='conflict',error_code=? WHERE id=?",
          )
          .run(error.code, event.id);
      }
    }
    for (const event of s.db
      .prepare(
        "SELECT * FROM events WHERE kind IN ('document_delete','document_recover') AND status='prepared' ORDER BY rowid",
      )
      .all() as any[])
      this.applyTrash(event);
  }
  rename(old: string, next: string, baseHash: string, request: string) {
    const s = this.store,
      key = "rename:" + request,
      prior = s.db
        .prepare("SELECT * FROM events WHERE dedupe_key=?")
        .get(key) as any;
    if (prior) {
      const data = JSON.parse(prior.payload_json);
      if (data.old !== old || data.next !== next)
        throw new AppError("IDEMPOTENCY_REUSED", "请求标识已被使用", 409);
      this.recover();
      return { ...s.document(next), warnings: data.warnings };
    }
    const document = s.document(old),
      file = s.files.resolve(next);
    if (document.hash !== baseHash)
      throw new AppError("DOCUMENT_CONFLICT", "文件已变化", 409);
    if (fs.existsSync(file))
      throw new AppError("PATH_EXISTS", "目标已存在", 409);
    const paths = s.files.list(),
      warnings: string[] = [],
      editsByFile: { path: string; payload: string }[] = [];
    for (const relative of paths) {
      const content = s.files.read(relative),
        edits: { start: number; end: number; before: string; after: string }[] =
          [];
      for (const token of markdownLinks(content)) {
        if (/^(?:[a-z]+:|\/|#)/i.test(token.target)) continue;
        let target: string;
        try {
          target = decodeURIComponent(token.target);
        } catch {
          continue;
        }
        const normalized = target.endsWith(".md") ? target : target + ".md";
        let resolved: string | undefined;
        if (token.wiki) {
          if (paths.includes(normalized)) resolved = normalized;
          else {
            const matches = paths.filter((p) => p.endsWith("/" + normalized));
            if (matches.length === 1) resolved = matches[0];
            else if (matches.includes(old)) warnings.push(relative);
          }
        } else
          resolved = path.posix.normalize(
            path.posix.join(path.posix.dirname(relative), normalized),
          );
        if (resolved !== old) {
          if (
            relative === old &&
            !token.wiki &&
            resolved &&
            paths.includes(resolved)
          ) {
            const replacement = encodeURI(
              path.posix.relative(path.posix.dirname(next), resolved),
            );
            if (replacement !== token.target)
              edits.push({
                start: token.start,
                end: token.end,
                before: token.target,
                after: replacement,
              });
          }
          continue;
        }
        const replacement = token.wiki
          ? next.replace(/\.md$/, "")
          : encodeURI(
              path.posix.relative(
                path.posix.dirname(relative === old ? next : relative),
                next,
              ),
            );
        edits.push({
          start: token.start,
          end: token.end,
          before: token.target,
          after: replacement,
        });
      }
      if (edits.length) {
        const changed = replaceLinkTargets(content, edits),
          payload = JSON.stringify({
            base_hash: hash(content),
            target_hash: hash(changed),
            edits,
          });
        if (Buffer.byteLength(payload) > 60000) {
          warnings.push(relative);
          continue;
        }
        editsByFile.push({ path: relative === old ? next : relative, payload });
      }
    }
    const eventId = id("rename"),
      data: Rename = {
        old,
        next,
        content_hash: document.hash,
        warnings: [...new Set(warnings)],
      };
    s.db.transaction(() => {
      s.db
        .prepare(
          "INSERT INTO events(id,dedupe_key,input_id,source,kind,payload_json,created_at) VALUES(?,?,?,'web','document_rename',?,?)",
        )
        .run(eventId, key, request, JSON.stringify(data), s.now());
      for (const edit of editsByFile) {
        const child = id("backlink");
        s.db
          .prepare(
            "INSERT INTO events(id,dedupe_key,input_id,parent_id,source,kind,document_path,payload_json,created_at) VALUES(?,?,?,?,'web','backlink_edit',?,?,?)",
          )
          .run(
            child,
            child,
            request,
            eventId,
            edit.path,
            edit.payload,
            s.now(),
          );
      }
    })();
    s.fault?.("rename_prepared");
    this.recover();
    const conflicts = s.db
      .prepare(
        "SELECT document_path FROM events WHERE parent_id=? AND status='conflict'",
      )
      .all(eventId) as any[];
    return {
      ...s.document(next),
      warnings: [...data.warnings, ...conflicts.map((x) => x.document_path)],
    };
  }
  listTrash() {
    const root = this.store.files.resolve(".agent/data/trash", "internal");
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root)
      .filter((name) => /^trash_[a-f0-9-]+\.md\.json$/.test(name))
      .flatMap((name) => {
        try {
          const meta = JSON.parse(
            fs.readFileSync(
              this.store.files.resolve(".agent/data/trash/" + name, "internal"),
              "utf8",
            ),
          );
          const file = name.replace(/\.json$/, "");
          if (
            !fs.existsSync(
              this.store.files.resolve(".agent/data/trash/" + file, "internal"),
            )
          )
            return [];
          return [
            {
              id: file.replace(/\.md$/, ""),
              path: meta.path,
              deleted_at: meta.deleted_at,
            },
          ];
        } catch {
          return [];
        }
      });
  }
  private applyTrash(event: any) {
    const data = JSON.parse(event.payload_json),
      s = this.store,
      file = s.files.resolve(data.path),
      trash = s.files.resolve(
        ".agent/data/trash/" + data.recovery_id + ".md",
        "internal",
      ),
      recover = event.kind === "document_recover",
      from = recover ? trash : file,
      to = recover ? file : trash;
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      if (hash(fs.readFileSync(from)) !== data.content_hash)
        throw new AppError("DOCUMENT_CONFLICT", "恢复项内容已变化", 409);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (!recover)
        atomicWrite(
          trash + ".json",
          JSON.stringify({ path: data.path, deleted_at: data.deleted_at }),
        );
      fs.renameSync(from, to);
      s.fault?.(recover ? "trash_recovered" : "document_trashed");
    } else if (
      fs.existsSync(from) ||
      !fs.existsSync(to) ||
      hash(fs.readFileSync(to)) !== data.content_hash
    )
      throw new AppError(
        "RECOVERY_CONFLICT",
        "恢复存在冲突，没有覆盖文件",
        409,
      );
    if (recover) {
      if (fs.existsSync(trash + ".json")) fs.unlinkSync(trash + ".json");
      s.index(data.path);
    } else s.db.prepare("DELETE FROM documents WHERE path=?").run(data.path);
    s.db
      .prepare("UPDATE events SET status='applied',completed_at=? WHERE id=?")
      .run(s.now(), event.id);
  }
  delete(relative: string, baseHash: string, request: string) {
    const s = this.store,
      key = "delete:" + request,
      prior = s.db
        .prepare("SELECT * FROM events WHERE dedupe_key=?")
        .get(key) as any;
    if (prior) {
      const data = JSON.parse(prior.payload_json);
      if (data.path !== relative)
        throw new AppError("IDEMPOTENCY_REUSED", "请求标识已被使用", 409);
      this.recover();
      return { deleted: true, recovery_id: data.recovery_id };
    }
    const document = s.document(relative);
    if (document.hash !== baseHash)
      throw new AppError("DOCUMENT_CONFLICT", "文件已变化", 409);
    const data = {
        path: relative,
        content_hash: document.hash,
        recovery_id: id("trash"),
        deleted_at: s.now(),
      },
      eventId = id("delete");
    s.db
      .prepare(
        "INSERT INTO events(id,dedupe_key,input_id,source,kind,payload_json,created_at) VALUES(?,?,?,'web','document_delete',?,?)",
      )
      .run(eventId, key, request, JSON.stringify(data), s.now());
    this.recover();
    return { deleted: true, recovery_id: data.recovery_id };
  }
  restoreTrash(recoveryId: string, request: string) {
    if (!/^trash_[a-f0-9-]+$/.test(recoveryId))
      throw new AppError("INVALID_RECOVERY", "恢复项无效");
    const s = this.store,
      key = "trash-restore:" + request,
      prior = s.db
        .prepare("SELECT * FROM events WHERE dedupe_key=?")
        .get(key) as any;
    if (prior) {
      const data = JSON.parse(prior.payload_json);
      if (data.recovery_id !== recoveryId)
        throw new AppError("IDEMPOTENCY_REUSED", "请求标识已被使用", 409);
      this.recover();
      return s.document(data.path);
    }
    const entry = this.listTrash().find((item) => item.id === recoveryId);
    if (!entry) throw new AppError("NOT_FOUND", "恢复项不存在或已过期", 404);
    if (fs.existsSync(s.files.resolve(entry.path)))
      throw new AppError("PATH_EXISTS", "原路径已有笔记，未覆盖", 409);
    const data = {
        path: entry.path,
        recovery_id: recoveryId,
        content_hash: hash(
          fs.readFileSync(
            s.files.resolve(
              ".agent/data/trash/" + recoveryId + ".md",
              "internal",
            ),
          ),
        ),
      },
      eventId = id("restore");
    s.db
      .prepare(
        "INSERT INTO events(id,dedupe_key,input_id,source,kind,payload_json,created_at) VALUES(?,?,?,'web','document_recover',?,?)",
      )
      .run(eventId, key, request, JSON.stringify(data), s.now());
    this.recover();
    return s.document(entry.path);
  }
}
