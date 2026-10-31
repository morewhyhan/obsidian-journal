import fs from "node:fs";
import { AppError } from "../../packages/contracts/types.js";
import {
  type Fact,
  type FactDraft,
  type FactFile,
  type FactSource,
  FACT_FILE_MAX_BYTES,
  emptyFactFile,
  validateFactFile,
} from "../../packages/contracts/facts.js";
import { atomicWrite, canonicalJson, hash, id, serialize } from "./files.js";
import type { Store } from "./store.js";

/** Structured long-lived background. Rules and tasks never live here. */
export const FACTS_PATH = ".agent/context/facts.json";

export function readFacts(store: Store): FactFile {
  const file = store.files.resolve(FACTS_PATH, "internal");
  if (!fs.existsSync(file)) return emptyFactFile();
  const raw = fs.readFileSync(file, "utf8");
  if (Buffer.byteLength(raw) > FACT_FILE_MAX_BYTES)
    throw new AppError("FACT_FILE_TOO_LARGE", "长期事实文件超过上限，需先整理", 500);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError("FACT_FILE_INVALID", "长期事实文件不是有效 JSON", 500);
  }
  return validateFactFile(parsed);
}

export type RevocationRecord = {
  kind: "fact";
  target_id: string;
  target_version: number;
  scope: string[];
  reason_code: string;
  revoked_at: string;
  /** "pending" until the affected original chat fragment is gone; never carries the body. */
  cleanup_state?: "pending" | "done";
  /**
   * Hash of the exact legacy preference line that repeated this fact. A hash is
   * not the body, so recovery can still find the line after a crash without
   * keeping anything readable on disk.
   */
  legacy_line_hash?: string;
};

/** Statuses where an input body is no longer recovery material and may be cleared. */
const CLEARABLE_INBOX_STATUS = ["processed", "failed", "cancelled", "abandoned", "expired"];

/** Opaque revoked ids survive an older snapshot: only the marker, never the body. */
export function revokedFactIds(store: Store) {
  const rows = store.db
    .prepare("SELECT target_id FROM revocations WHERE kind='fact'")
    .all() as { target_id: string }[];
  return new Set(rows.map((row) => row.target_id));
}

/**
 * Removes the exact legacy preference line that repeated a forgotten fact.
 * Only an exact "- <content>" match is removed: this is not a similarity search,
 * and the caller never persists the removed text.
 */
export function scrubLegacyUserNotes(store: Store, content: string) {
  const wanted = content.trim();
  if (!wanted) return 0;
  const file = store.files.resolve(".agent/context/user.md", "internal");
  if (!fs.existsSync(file)) return 0;
  const before = fs.readFileSync(file, "utf8");
  const trailing = before.endsWith("\n");
  const lines = before.split(/\r?\n/);
  if (trailing) lines.pop();
  const kept = lines.filter((line) => !(line.startsWith("- ") && line.slice(2).trim() === wanted));
  const removed = lines.length - kept.length;
  if (!removed) return 0;
  atomicWrite(file, kept.join("\n") + (trailing ? "\n" : ""));
  return removed;
}

/** Stable identity of a legacy note line, without persisting the line itself. */
export function legacyLineHash(content: string) {
  const wanted = content.trim();
  return wanted ? hash(serialize([wanted])) : undefined;
}

/** Removes every legacy line whose hash matches, so recovery needs no body. */
export function scrubLegacyByHash(store: Store, lineHash?: string) {
  if (!lineHash) return 0;
  const file = store.files.resolve(".agent/context/user.md", "internal");
  if (!fs.existsSync(file)) return 0;
  const before = fs.readFileSync(file, "utf8");
  const trailing = before.endsWith("\n");
  const lines = before.split(/\r?\n/);
  if (trailing) lines.pop();
  const kept = lines.filter((line) => {
    if (!line.startsWith("- ")) return true;
    return legacyLineHash(line.slice(2)) !== lineHash;
  });
  const removed = lines.length - kept.length;
  if (!removed) return 0;
  atomicWrite(file, kept.join("\n") + (trailing ? "\n" : ""));
  return removed;
}

/** Tombstones the fact in place and returns the marker written to the runtime list. */
export function forgetFactTo(
  store: Store,
  file: FactFile,
  targetId: string,
  expectedVersion: number,
  now: string,
  reason = "user_forgot",
): { file: FactFile; revocation: RevocationRecord; legacy_content: string } {
  const target = file.facts.find((fact) => fact.id === targetId);
  if (!target) throw new AppError("FACT_NOT_FOUND", "要撤销的事实不存在", 404);
  if (target.version !== expectedVersion)
    throw new AppError("VERSION_CONFLICT", "事实已经变化，请重新读取", 409);
  if (target.status === "revoked") {
    const existing = store.db
      .prepare("SELECT target_id FROM revocations WHERE kind='fact' AND target_id=?")
      .get(targetId);
    if (!existing) throw new AppError("RECOVERY_CONFLICT", "撤销标记不完整，需先核对", 409);
    return {
      file,
      revocation: { kind: "fact", target_id: targetId, target_version: target.version,
        scope: target.scope, reason_code: reason, revoked_at: target.updated_at },
      legacy_content: "",
    };
  }
  const tombstone = {
    ...target,
    version: target.version + 1,
    content: "",
    status: "revoked" as const,
    superseded_by: null,
    valid_until: now,
    updated_at: now,
  };
  return {
    file: {
      schema_version: 1,
      revision: file.revision + 1,
      updated_at: now,
      facts: file.facts.map((fact) => (fact.id === targetId ? tombstone : fact)),
    },
    revocation: {
      kind: "fact",
      target_id: targetId,
      target_version: target.version + 1,
      scope: target.scope,
      reason_code: reason,
      revoked_at: now,
      legacy_line_hash: legacyLineHash(target.content),
    },
    // In memory only: the caller scrubs the legacy note right after the commit.
    legacy_content: target.content,
  };
}

/**
 * Finishes revocation cleanup: clears the original chat fragment that produced a
 * forgotten fact. The tombstone keeps only the opaque source id, so no content is
 * matched or copied. A source still in flight stays pending and the caller must
 * report "已停用，清理待完成" instead of claiming a full erase.
 */
export function cleanupRevokedFragments(store: Store, now: string, targetIds?: string[]) {
  const rows = (targetIds && targetIds.length
    ? store.db
        .prepare(
          `SELECT id,target_id,legacy_line_hash FROM revocations WHERE kind='fact' AND cleanup_state='pending' AND target_id IN (${targetIds.map(() => "?").join(",")})`,
        )
        .all(...targetIds)
    : store.db
        .prepare("SELECT id,target_id,legacy_line_hash FROM revocations WHERE kind='fact' AND cleanup_state='pending'")
        .all()) as { id: string; target_id: string; legacy_line_hash: string | null }[];
  let file: FactFile | null = null;
  try {
    file = readFacts(store);
  } catch {
    file = null;
  }
  const cleared: string[] = [];
  const pending: string[] = [];
  let legacyCleared = 0;
  const mark = store.db.prepare(
    "UPDATE revocations SET cleanup_state='done',cleaned_at=? WHERE id=?",
  );
  for (const row of rows) {
    // The legacy note is scrubbable from its hash alone, so it never has to wait
    // for the chat fragment: after a crash the original line must still be
    // removable without keeping the forgotten text anywhere.
    const removed = scrubLegacyByHash(store, row.legacy_line_hash ?? undefined);
    legacyCleared += removed;
    const fact = file?.facts.find((f) => f.id === row.target_id);
    const sourceId = fact && fact.source.kind === "input" ? fact.source.id : null;
    const inbox = sourceId
      ? (store.db.prepare("SELECT body,status FROM inbox WHERE id=?").get(sourceId) as
          | { body: string | null; status: string }
          | undefined)
      : undefined;
    if (sourceId && inbox && !CLEARABLE_INBOX_STATUS.includes(inbox.status)) {
      pending.push(sourceId);
      continue;
    }
    if (sourceId && inbox && inbox.body !== null) {
      store.db
        .prepare(
          "UPDATE inbox SET body=NULL,metadata_json=json_set(metadata_json,'$.body_cleared','revocation') WHERE id=?",
        )
        .run(sourceId);
      cleared.push(sourceId);
    }
    if (sourceId) {
      // Copies of the same content must not survive in the stored reply or in the
      // delivered receipt: the model reads both back as recent history.
      store.db
        .prepare(
          "UPDATE inbox SET metadata_json=json_remove(metadata_json,'$.reply','$.reply_next_offset') WHERE id=?",
        )
        .run(sourceId);
      store.db
        .prepare(
          "UPDATE outbox SET body='' WHERE dedupe_key LIKE ? AND status IN ('sent','unknown','expired','abandoned')",
        )
        .run(sourceId + ":reply%");
    }
    mark.run(now, row.id);
  }
  return { state: pending.length ? ("pending" as const) : ("done" as const), cleared, pending, legacy_user_md_cleared: legacyCleared };
}

export function factsDigest(store: Store) {
  try {
    return hash(serialize(readFacts(store)));
  } catch {
    return "invalid";
  }
}

/** Active facts applicable at the given instant, newest first. */
export function activeFacts(store: Store, now: string) {
  const revoked = revokedFactIds(store);
  return readFacts(store)
    .facts.filter(
      (fact) => fact.status === "active" && !revoked.has(fact.id) &&
        fact.valid_from <= now &&
        (!fact.valid_until || fact.valid_until > now),
    )
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/**
 * Adds one confirmed fact, or supersedes the named older one. Same content with
 * the same subject and scope is idempotent instead of creating a duplicate.
 */
export function appendFact(store: Store, draft: FactDraft, source: FactSource, now: string) {
  return appendFactTo(readFacts(store), draft, source, now);
}

/** Pure append/supersede used inside one commit so several drafts compose. */
export function appendFactTo(
  current: FactFile,
  draft: FactDraft,
  source: FactSource,
  now: string,
): FactFile {
  const content = draft.content.replace(/[\u000d\u000a]+/g, " ").trim();
  if (!content || content.length > 500)
    throw new AppError("INVALID_FACT", "偏好记录应简短明确");
  const kind = draft.kind;
  if (kind === "hypothesis")
    throw new AppError("FACT_NOT_CONFIRMED", "推测不能写成已确认事实");
  const subject = (draft.subject ?? "preference").trim() || "preference";
  const scope = (draft.scope?.length ? draft.scope : ["global"]).map((x) => x.trim()).filter(Boolean);
  if (subject.length > 200 || scope.length > 8 || scope.some((x) => x.length > 60))
    throw new AppError("INVALID_FACT", "事实主体或范围过长");
  const target = draft.supersedes
    ? current.facts.find((fact) => fact.id === draft.supersedes)
    : undefined;
  if (draft.supersedes && !target)
    throw new AppError("FACT_NOT_FOUND", "要更正的事实不存在", 404);
  const duplicate = current.facts.find(
    (fact) => fact.status === "active" && fact.kind === kind && fact.subject === subject &&
      canonicalJson(fact.scope) === canonicalJson(scope) && fact.content === content,
  );
  if (duplicate && !target) return current;

  const created: Fact = {
    id: id("fact"),
    version: 1,
    kind,
    subject,
    scope,
    content,
    source: { ...source, excerpt: source.excerpt?.slice(0, 120) },
    valid_from: now,
    valid_until: draft.valid_until ?? null,
    status: "active",
    supersedes: target ? [target.id] : [],
    superseded_by: null,
    retention_reason: kind === "imported_unverified" ? "imported_material" : "explicit_user_statement",
    last_used_at: null,
    used_event_ids: [],
    created_at: now,
    updated_at: now,
  };
  const facts = current.facts.map((fact) =>
    target && fact.id === target.id
      ? {
          ...fact,
          status: "superseded" as const,
          superseded_by: created.id,
          valid_until: now,
          version: fact.version + 1,
          updated_at: now,
        }
      : fact,
  );
  facts.push(created);
  return { schema_version: 1, revision: current.revision + 1, updated_at: now, facts };
}

export type { Fact, FactDraft, FactFile, FactSource };
export type FactHit = {
  id: string;
  version: number;
  kind: string;
  subject: string;
  scope: string[];
  content: string;
  source: FactSource;
  valid_from: string;
  valid_until: string | null;
};

/** Keyword search only narrows candidates; the model still reads and judges them. */
/** While a restored runtime awaits review, stored facts are not auto-loaded. */
export function factsRestricted(store: Store) {
  try {
    return !!store.runtimeMeta().recovery_guard?.active;
  } catch {
    return true;
  }
}
export function searchFacts(
  store: Store,
  query: string,
  now: string,
  limit = 8,
  offset = 0,
  /**
   * Imported material is not a confirmed user statement: normal context search
   * leaves it out so the model cannot present a guess as the user's own rule.
   */
  includeUnverified = false,
) {
  if (factsRestricted(store))
    return { items: [] as FactHit[], total: 0, offset: 0, next_offset: null as number | null, matched: false, restricted: true };
  const terms = [
    ...new Set((query.toLowerCase().match(/[a-z0-9_-]{2,}|[\u4e00-\u9fff]{2}/g) ?? [])),
  ];
  // Match first, page second: paging a truncated array silently hides the tail.
  const matchedFacts = activeFacts(store, now).filter(
    (fact) =>
      (includeUnverified || fact.kind !== "imported_unverified") &&
      (!terms.length ||
      terms.some(
        (term) =>
          fact.content.toLowerCase().includes(term) ||
          fact.subject.toLowerCase().includes(term))),
  );
  const page = matchedFacts.slice(offset, offset + limit).map((fact) => ({
    id: fact.id,
    version: fact.version,
    kind: fact.kind,
    subject: fact.subject,
    scope: fact.scope,
    content: fact.content,
    source: fact.source,
    valid_from: fact.valid_from,
    valid_until: fact.valid_until,
  }));
  const next = offset + page.length;
  return {
    items: page,
    total: matchedFacts.length,
    offset,
    next_offset: next < matchedFacts.length ? next : null,
    matched: !!terms.length,
    restricted: false,
  };
}

/**
 * Records that these facts were actually handed to the model for this event.
 * Deduplicated per event id so a retry of the same turn does not inflate usage.
 */
export function markFactsUsed(store: Store, factIds: string[], eventId: string, now: string) {
  // Deprecated direct writer; the safe path is recordFactUsage + applyFactUsage.

  if (!factIds.length || !eventId) return 0;
  let file: FactFile;
  try {
    file = readFacts(store);
  } catch {
    return 0;
  }
  let touched = 0;
  for (const fact of file.facts) {
    if (!factIds.includes(fact.id)) continue;
    const used = fact.used_event_ids ?? [];
    if (used.includes(eventId)) continue;
    fact.used_event_ids = [...used, eventId].slice(-50);
    fact.last_used_at = now;
    touched++;
  }
  if (!touched) return 0;
  file.revision++;
  file.updated_at = now;
  atomicWrite(store.files.resolve(FACTS_PATH, "internal"), serialize(validateFactFile(file)));
  return touched;
}
