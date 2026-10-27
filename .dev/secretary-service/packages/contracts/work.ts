import { z } from "zod";

const text = (n: number) => z.string().trim().min(1).max(n);
const instant = z.iso.datetime({ offset: true });
export const workRefSchema = z.strictObject({
  kind: z.enum(["task", "habit", "plan", "proposal", "rule", "note"]),
  id: text(200).optional(), path: text(1024).optional(),
  role: z.enum(["subject", "input", "output", "decision"]),
  observed_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
}).refine(r => r.kind === "note" ? !!r.path && !r.id : !!r.id && !r.path,
  "note uses path; business references use id");
export type WorkRef = z.infer<typeof workRefSchema>;
export const workDoneSchema = z.discriminatedUnion("kind", [
  z.strictObject({kind:z.literal("business_applied"),intent_ref:text(200)}),
  z.strictObject({kind:z.literal("material_verified"),path:text(1024),
    check:z.discriminatedUnion("kind",[
      z.strictObject({kind:z.literal("exists_nonempty")}),
      z.strictObject({kind:z.literal("contains_all"),terms:z.array(text(500)).min(1).max(20)}),
    ])}),
  z.strictObject({kind:z.literal("decision_recorded"),proposal_id:text(200),
    proposal_version:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    action_indices:z.array(z.number().int().nonnegative().max(19)).min(1).max(20)}),
  z.strictObject({kind:z.literal("condition_observed"),ref:workRefSchema,
    checker:z.enum(["dependency_done","task_terminal","note_available"])}),
  z.strictObject({kind:z.literal("user_confirmed"),path:text(1024)}),
]);
export type WorkDone = z.infer<typeof workDoneSchema>;
export const workWakeSchema = z.strictObject({kind:z.enum(["ref_changed","matching_feedback"]),ref:workRefSchema});
export const workInputSchema = z.strictObject({
  key: z.string().regex(/^[a-z0-9_-]{1,60}$/), summary:text(600),
  owner:z.enum(["assistant","user","condition"]),next_action:text(600),
  condition:text(600).nullable().optional(),check_at:instant.nullable().optional(),
  refs:z.array(workRefSchema).max(8).optional(),done_when:workDoneSchema.optional(),
  wake_on:z.array(workWakeSchema).max(8).optional(),
}).refine(w=>w.owner!=="condition" || !!w.condition,"waiting requires a condition");
// The same runtime contract is exported to HTTP, Python and the model catalog.
export const workInputJsonSchema = z.toJSONSchema(workInputSchema, {unrepresentable:"any"});
export const DELEGATION_CAPABILITIES = ["read_related","prepare_next_action","manage_work",
  "create_period","write_named_artifact","reflow_flexible"] as const;
export type DelegationCapability = typeof DELEGATION_CAPABILITIES[number];
export type WorkDelegation = {
  source: import("./types.js").Source;
  capabilities: DelegationCapability[];
  object_ids: string[];
  paths: string[];
  write_paths?:string[];
  rules_revision: number;
  expires_at: string|null;
};
export type WorkResolution = {kind:"completed"|"cancelled"|"superseded"|"legacy_unspecified";
  at:string;source:import("./types.js").Source; evidence?:string[]};
