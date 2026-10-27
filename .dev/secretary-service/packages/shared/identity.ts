import crypto from "node:crypto";

// Stable technical values only: no filesystem, application or channel dependency.
export const hash = (content: string | Buffer) =>
  "sha256:" + crypto.createHash("sha256").update(content).digest("hex");
export const id = (prefix: string) => prefix + "_" + crypto.randomUUID();
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object")
    return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
