import { AppError } from "../../packages/contracts/types.js";
import { hash, serialize } from "./files.js";
import type { Store } from "./store.js";

/**
 * C2 input understanding. Publishing an interpretation records what the assistant
 * believes a message means. It authorizes nothing: actions still go through C1.
 */
export const ACT_KINDS = ["query", "report", "discuss", "instruct", "decide", "correct", "stop", "unknown"] as const;
export const ACT_RELATIONS = ["unrelated", "continue", "replace", "cancel", "unknown"] as const;
export const ACT_AFFECTS = ["business", "contact", "context"] as const;

export type Interpretation = {
  acts: {
    kind: (typeof ACT_KINDS)[number];
    relation: (typeof ACT_RELATIONS)[number];
    affects: (typeof ACT_AFFECTS)[number][];
    target_scope: "explicit" | "conversation" | "unknown";
    evidence_span: { start: number; end: number };
    unresolved_question?: string;
  }[];
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Strict shape check; a fabricated or malformed interpretation is refused outright. */
export function validateInterpretation(input: unknown, text: string): Interpretation {
  if (!isObject(input) || Object.keys(input).some((key) => key !== "acts") || !Array.isArray(input.acts))
    throw new AppError("INVALID_COMMAND", "理解结果需要 acts 列表");
  // An empty act list cannot advance the watermark; neighbouring small talk still
  // has to name what it did (query/discuss).
  if (!input.acts.length || input.acts.length > 8)
    throw new AppError("INVALID_COMMAND", "一轮理解需要1到8条明确行为");
  const length = [...text].length;
  const acts = input.acts.map((raw) => {
    if (!isObject(raw) ||
      Object.keys(raw).some((key) => !["kind", "relation", "affects", "target_scope", "evidence_span", "unresolved_question"].includes(key)) ||
      !ACT_KINDS.includes(raw.kind as any) || !ACT_RELATIONS.includes(raw.relation as any) ||
      !Array.isArray(raw.affects) || raw.affects.some((a) => !ACT_AFFECTS.includes(a as any)) ||
      !["explicit", "conversation", "unknown"].includes(raw.target_scope as string))
      throw new AppError("INVALID_COMMAND", "理解行为包含未知字段或取值");
    const span = raw.evidence_span;
    if (!isObject(span) || Object.keys(span).some((key) => !["start", "end"].includes(key)) ||
      !Number.isInteger(span.start) || !Number.isInteger(span.end) ||
      (span.start as number) < 0 || (span.end as number) <= (span.start as number) || (span.end as number) > length)
      throw new AppError("INVALID_COMMAND", "证据范围必须是原文内的非空区间");
    return {
      kind: raw.kind as Interpretation["acts"][number]["kind"],
      relation: raw.relation as Interpretation["acts"][number]["relation"],
      affects: [...new Set(raw.affects as Interpretation["acts"][number]["affects"])],
      target_scope: raw.target_scope as Interpretation["acts"][number]["target_scope"],
      evidence_span: { start: span.start as number, end: span.end as number },
      ...(typeof raw.unresolved_question === "string" && raw.unresolved_question.trim()
        ? { unresolved_question: raw.unresolved_question.slice(0, 500) }
        : {}),
    };
  });
  return { acts };
}

/** Publishes understanding for one accepted input; the source text must be unchanged. */
export function publishInterpretation(store: Store, inputId: string, interpretation: Interpretation, sourceHash: string) {
  const row = store.db.prepare("SELECT body,classification,metadata_json,interpretation_json FROM inbox WHERE id=?").get(inputId) as
    | { body: string | null; classification: string; metadata_json: string; interpretation_json: string | null }
    | undefined;
  if (!row) throw new AppError("APPLICATION_SESSION_EXPIRED", "这条输入不存在或已处理完", 403);
  if (row.body === null) throw new AppError("APPLICATION_SESSION_EXPIRED", "这条输入正文已不可用", 403);
  const stored = JSON.parse(row.metadata_json).payload_hash;
  const actual = stored ?? hash(serialize([row.body]));
  if (sourceHash !== actual) throw new AppError("VERSION_CONFLICT", "原文已变化，不能据此发布理解", 409);
  const version = (JSON.parse(row.interpretation_json ?? "{}").version ?? 0) + 1;
  const payload = { ...interpretation, version, interpreted_at: store.now() };
  store.db.prepare("UPDATE inbox SET classification='classified',interpretation_json=? WHERE id=?").run(JSON.stringify(payload), inputId);
  return { input_id: inputId, classification: "classified" as const, version, understood_seq: advanceUnderstood(store) };
}

/** Contiguous classified prefix only: one pending or unclear message stops it. */
export function advanceUnderstood(store: Store) {
  const rows = store.db
    .prepare("SELECT seq,classification FROM inbox WHERE channel<>'coordinator' AND seq>0 ORDER BY seq")
    .all() as { seq: number; classification: string }[];
  // Maintenance deletes old rows, so the lowest surviving seq need not be 1.
  // Start from the persisted watermark when the missing rows are exactly the
  // ones already cleaned below it; otherwise stay at 0 and let contiguity decide.
  const persisted = understoodSeq(store);
  const lowest = rows[0]?.seq ?? 0;
  let watermark = lowest > 1 && persisted >= lowest - 1 ? lowest - 1 : 0;
  for (const row of rows) {
    if (row.seq !== watermark + 1) break;
    if (row.classification !== "classified") break;
    watermark = row.seq;
  }
  store.updateRuntimeMeta((meta) => ({ ...meta, understood_seq: watermark }));
  return watermark;
}

export function understoodSeq(store: Store) {
  const value = Number(store.runtimeMeta().understood_seq ?? 0);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * A newer message only holds an older write when it can still change what that
 * work should do. A classified, definitely unrelated message never starves it.
 */
export function newerInputBlocks(store: Store, inputId: string, channel: string, actorRef: string) {
  const newer = store.db
    .prepare(
      `SELECT classification,interpretation_json FROM inbox
       WHERE (seq>(SELECT seq FROM inbox WHERE id=?) OR (seq=0 AND rowid>(SELECT rowid FROM inbox WHERE id=?)))
         AND channel=? AND actor_ref=? AND status IN ('pending','processing')`,
    )
    .all(inputId, inputId, channel, actorRef) as { classification: string; interpretation_json: string | null }[];
  return newer.some((row) => {
    if (row.classification !== "classified") return true;
    try {
      const acts = JSON.parse(row.interpretation_json ?? "{}").acts as Interpretation["acts"];
      if (!Array.isArray(acts) || !acts.length) return true;
      return acts.some((act) => act.relation !== "unrelated" || act.affects.includes("business") || act.kind !== "discuss" && act.kind !== "query");
    } catch {
      return true;
    }
  });
}
