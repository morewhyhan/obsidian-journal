import { AppError } from "./types.js";

/** Long-lived background facts. Rules and tasks stay in their own canonical objects. */
export const FACT_KINDS = [
  "user_reported",
  "tool_observed",
  "hypothesis",
  "imported_unverified",
] as const;
export type FactKind = (typeof FACT_KINDS)[number];
export type FactSource = {
  kind: "input" | "note" | "tool" | "import";
  id?: string;
  channel?: string;
  external_id?: string;
  at: string;
  excerpt?: string;
};
export type Fact = {
  id: string;
  version: number;
  kind: FactKind;
  subject: string;
  scope: string[];
  content: string;
  source: FactSource;
  valid_from: string;
  valid_until: string | null;
  status: "active" | "superseded" | "revoked" | "expired";
  supersedes: string[];
  superseded_by: string | null;
  retention_reason: string;
  last_used_at: string | null;
  used_event_ids: string[];
  created_at: string;
  updated_at: string;
};
export type FactFile = {
  schema_version: 1;
  revision: number;
  updated_at: string | null;
  facts: Fact[];
};
export type FactDraft = {
  content: string;
  kind: FactKind;
  subject?: string;
  scope?: string[];
  valid_until?: string | null;
  supersedes?: string | null;
};
export const emptyFactFile = (): FactFile => ({
  schema_version: 1,
  revision: 0,
  updated_at: null,
  facts: [],
});
export const FACT_FILE_MAX_BYTES = 256 * 1024;
export function validateFactFile(value: unknown): FactFile {
  const invalid = (why: string): never => {
    throw new AppError("FACT_FILE_INVALID", "长期事实文件格式不正确：" + why, 500);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("根对象");
  const file = value as FactFile;
  if (file.schema_version !== 1) invalid("schema_version");
  if (!Number.isInteger(file.revision) || file.revision < 0) invalid("revision");
  if (!Array.isArray(file.facts)) invalid("facts");
  for (const [index, fact] of file.facts.entries()) {
    const at = "facts[" + index + "]";
    if (!fact || typeof fact !== "object") invalid(at);
    if (typeof fact.id !== "string" || !fact.id.trim() || fact.id.length > 120) invalid(at + ".id");
    if (!Number.isInteger(fact.version) || fact.version < 1) invalid(at + ".version");
    if (!FACT_KINDS.includes(fact.kind)) invalid(at + ".kind");
    if (typeof fact.subject !== "string" || !fact.subject || fact.subject.length > 200) invalid(at + ".subject");
    if (!Array.isArray(fact.scope) || !fact.scope.length || fact.scope.length > 8 ||
      fact.scope.some((s) => typeof s !== "string" || !s || s.length > 60)) invalid(at + ".scope");
    // A revoked fact keeps only an opaque marker: empty content is correct there.
    if (typeof fact.content !== "string" || fact.content.length > 2000) invalid(at + ".content");
    if (!fact.content.trim() && fact.status !== "revoked") invalid(at + ".content");
    const source = fact.source;
    if (!source || !["input", "note", "tool", "import"].includes(source.kind) ||
      typeof source.at !== "string" || !source.at) invalid(at + ".source");
    if (typeof fact.valid_from !== "string" || !fact.valid_from) invalid(at + ".valid_from");
    if (fact.valid_until !== null && typeof fact.valid_until !== "string") invalid(at + ".valid_until");
    if (!["active", "superseded", "revoked", "expired"].includes(fact.status)) invalid(at + ".status");
    if (!Array.isArray(fact.supersedes) || fact.supersedes.some((s) => typeof s !== "string")) invalid(at + ".supersedes");
    if (fact.superseded_by !== null && typeof fact.superseded_by !== "string") invalid(at + ".superseded_by");
    if (typeof fact.retention_reason !== "string") invalid(at + ".retention_reason");
    if (fact.last_used_at !== null && typeof fact.last_used_at !== "string") invalid(at + ".last_used_at");
    if (!Array.isArray(fact.used_event_ids) || fact.used_event_ids.some((s) => typeof s !== "string")) invalid(at + ".used_event_ids");
    if (typeof fact.created_at !== "string" || typeof fact.updated_at !== "string") invalid(at + ".timestamps");
  }
  return file;
}
