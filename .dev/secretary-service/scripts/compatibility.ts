import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { VaultFiles } from "../apps/core/files.js";
import { renderTemplate } from "../apps/core/journal.js";
import { projectRoot } from "../apps/core/config.js";
import type { Period } from "../packages/calendar/index.js";
const root = process.env.SECRETARY_AUDIT_VAULT;
if (!root || !path.isAbsolute(root) || !fs.existsSync(root))
  throw new Error("Set the explicitly authorized audit vault");
// No Store, model, channel, filesystem watcher or writer is initialized here.
const vault = new VaultFiles(root),
  paths = vault.list(),
  signature = () => {
    const digest = crypto.createHash("sha256");
    for (const relative of paths) {
      const file = vault.resolve(relative);
      digest.update(relative + "\0");
      digest.update(fs.readFileSync(file));
      digest.update("\0");
    }
    return digest.digest("hex");
  };
const before = signature(),
  templates: Record<string, string> = {},
  kinds: Record<string, Period> = {
    日记模版: "daily",
    周记模版: "weekly",
    月度反思模版: "monthly",
    季度计划模版: "quarterly",
    年度反思模版: "yearly",
  };
for (const [name, kind] of Object.entries(kinds)) {
  const file = vault.resolve("Template/" + name + ".md");
  if (!fs.existsSync(file)) {
    templates[kind] = "uses_service_default";
    continue;
  }
  try {
    renderTemplate(fs.readFileSync(file, "utf8"), kind, "2026-10-23");
    templates[kind] = "supported_without_eval";
  } catch {
    templates[kind] = "unsupported_expression";
  }
}
const after = signature(),
  stats = paths.map((relative) => fs.statSync(vault.resolve(relative)));
const report = {
  at: new Date().toISOString(),
  scope:
    "read-only path mapping, inventory hashes and bounded template rendering; no diary text sent to a model",
  status:
    before === after &&
    !Object.values(templates).includes("unsupported_expression")
      ? "passed"
      : "needs_attention",
  markdown_count: paths.length,
  total_markdown_bytes: stats.reduce((sum, stat) => sum + stat.size, 0),
  notes_over_2mib: stats.filter((stat) => stat.size > 2097152).length,
  legacy_files_registered: vault.legacy.size,
  legacy_routes_registered: vault.legacyRoutes.size,
  legacy_routes_resolved: [...vault.legacyRoutes].filter(
    ([canonical, actual]) => vault.actualPath(canonical) === actual,
  ).length,
  templates,
  inventory_sha256_before: before,
  inventory_sha256_after: after,
  notes_changed: before !== after,
};
const directory = path.join(projectRoot, "docs/evidence");
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(
  path.join(directory, "existing-vault-compatibility.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (report.status !== "passed") process.exitCode = 1;
