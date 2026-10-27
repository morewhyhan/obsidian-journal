import type { Core } from "./core.js";
import { AppError } from "../../packages/contracts/types.js";
import { canonicalJson, hash, id } from "./files.js";
import { discussionOnly, documentMutationRequested } from "./conversation.js";
import type { Store } from "./store.js";
import { effectivePolicy } from "./policy.js";
import { checkBackgroundFile } from "./background-grant.js";
import { recordNote,checkReads } from "./read-stamps.js";
import { requireRuntimeCombination } from "./compatibility-runtime.js";
import {modelDeadline} from "./model-job.js";

export function policyStamp(store: Store) {
  return effectivePolicy(store).policy_stamp;
}

/** Recheck at the actual writer boundary, not only before awaiting its lock. */
export function assertToolSession(s:Store,args:{input_id:string;operation:string;path?:unknown}) {
  requireRuntimeCombination(s);
  const row=s.db.prepare("SELECT status,channel,actor_ref,metadata_json FROM inbox WHERE id=?").get(args.input_id) as any;
  const meta=row?JSON.parse(row.metadata_json):{};
  if(row?.status!=="processing" || meta.runtime_generation && meta.runtime_generation!==s.generation ||
    meta.deadline_at && meta.deadline_at<=s.now() || meta.model_job_id && s.runtimeMeta().model_job?.id!==meta.model_job_id)
    throw new AppError("APPLICATION_SESSION_EXPIRED","文件操作的执行回合已失效",403);
  if(meta.model_job_id)modelDeadline(s,true);
  if(meta.policy_stamp && meta.policy_stamp!==policyStamp(s))throw new AppError("VERSION_CONFLICT","策略已变化，请重读再修改文件",409);
  if(args.operation!=="create_period")checkReads(s,args.input_id);
  if(row.channel==="coordinator")checkBackgroundFile(s,args.input_id,args.operation,args.path as string|undefined);
  if(meta.agent_execution==="tools-v2" && row.channel!=="coordinator" && s.db.prepare(
    "SELECT 1 FROM inbox WHERE rowid>(SELECT rowid FROM inbox WHERE id=?) AND channel=? AND actor_ref=? AND status IN ('pending','processing') LIMIT 1"
  ).get(args.input_id,row.channel,row.actor_ref))throw new AppError("NEWER_INPUT_PENDING","已有新交代，旧文件操作等待核对",409);
}

/** Journal before invoking a mutating tool: a crashed model turn must never replay its side effects. */
export async function toolMutation<T>(
  core: Core,
  args: {
    input_id: string;
    call_id: string;
    operation: string;
    [key: string]: unknown;
  },
  invoke: () => Promise<T>,
): Promise<T> {
  const s = core.store;
  assertToolSession(s,args);
  const row = s.db
    .prepare("SELECT status,channel,body,metadata_json FROM inbox WHERE id=?")
    .get(args.input_id) as any;
  if (!row || row.status !== "processing")
    throw new AppError(
      ["create_period", "restore_note", "restore_version"].includes(
        args.operation,
      )
        ? "APPLICATION_SESSION_EXPIRED"
        : "WORKSPACE_SESSION_EXPIRED",
      "请求已结束，未执行变更",
      403,
    );
  if (row.channel === "coordinator") checkBackgroundFile(s,args.input_id,args.operation,args.path as string|undefined);
  const metadata = JSON.parse(row.metadata_json);
  // Idempotent period creation preserves existing content and does not depend on its old body.
  if(args.operation!=="create_period")checkReads(s,args.input_id);
  if(metadata.model_job_id && s.runtimeMeta().model_job?.id!==metadata.model_job_id)
    throw new AppError("APPLICATION_SESSION_EXPIRED","模型作业已经结束",403);
  if (metadata.policy_stamp && metadata.policy_stamp !== policyStamp(s))
    throw new AppError(
      "VERSION_CONFLICT",
      "个人规则或可用时间已变化，旧回合不能修改文件",
      409,
    );
  const autonomous = metadata.agent_execution === "tools-v2";
  if (metadata.read_only || (!autonomous && discussionOnly(row.body ?? "")))
    throw new AppError("DISCUSSION_ONLY", "本轮只讨论或查询，不执行变更", 403);
  if (!autonomous && !documentMutationRequested(row.body ?? ""))
    throw new AppError(
      "DOCUMENT_AUTHORIZATION_REQUIRED",
      "当前交代没有授权修改笔记；可以继续查询或提交业务提案",
      403,
    );

  const key = "tool:" + args.input_id + ":" + args.call_id;
  const signature = hash(canonicalJson(args));
  const {call_id:label,input_id:inputId,...meaning}=args;
  const semantic=hash(canonicalJson(meaning));
  const prior = s.db
    .prepare("SELECT * FROM events WHERE dedupe_key=?")
    .get(key) as any;
  if (prior) {
    const payload = JSON.parse(prior.payload_json);
    if (payload.signature !== signature)
      throw new AppError("IDEMPOTENCY_REUSED", "调用标识已用于其他操作", 409);
    if (prior.status === "applied" && payload.result)
      return payload.result as T;
    // Do not replay even if a crash happened after the actual write but before its receipt.
    throw new AppError(
      "TOOL_ALREADY_ATTEMPTED",
      "该操作已有执行记录，请查询当前文件，不能重放",
      409,
    );
  }
  // ensure-period is itself an idempotent query/create operation: re-reading it must
  // report today's existing files, and a corrected template must be retryable.
  const same=args.operation==="create_period"?undefined:s.db.prepare("SELECT status,payload_json FROM events WHERE input_id=? AND kind='tool_effect' AND json_extract(payload_json,'$.semantic')=? ORDER BY rowid DESC LIMIT 1")
    .get(args.input_id,semantic) as {status:string;payload_json:string}|undefined;
  if(same) {
    const payload=JSON.parse(same.payload_json);
    if(same.status==="applied" && payload.result)return payload.result as T;
    throw new AppError("TOOL_ALREADY_ATTEMPTED","同一文件意图已尝试，先核对文件和回执，不能换调用名重放",409);
  }
  const operation = id("tool"),
    payload = {
      signature,
      semantic,
      operation: args.operation,
      path: typeof args.path === "string" ? args.path : null,
      date: typeof args.date === "string" ? args.date : null,
    };
  s.db
    .prepare(
      "INSERT INTO events(id,dedupe_key,input_id,source,kind,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      operation,
      key,
      args.input_id,
      row.channel,
      "tool_effect",
      JSON.stringify(payload),
      s.now(),
    );
  try {
    const result = await invoke();
    s.fault?.("tool_effect_written");
    const output = result as any;
    if(output?.path && output?.hash)recordNote(s,args.input_id,output.path,output.hash);
    if(["rename","delete"].includes(args.operation) && typeof args.path==="string")recordNote(s,args.input_id,args.path,"missing");
    // Mutating receipts need paths and hashes, never a second copy of the note body.
    const receipt = Object.fromEntries(
      Object.entries(output ?? {}).filter(([key]) =>
        [
          "path",
          "hash",
          "written",
          "created",
          "existing",
          "template_applied",
          "warnings",
          "version",
          "updated_at",
          "recovery_id",
          "runtime_degraded",
          "pending_verifications",
        ].includes(key),
      ),
    );
    s.db
      .prepare(
        "UPDATE events SET status='applied',payload_json=?,completed_at=? WHERE id=?",
      )
      .run(
        JSON.stringify({
          ...payload,
          path: output?.path ?? payload.path,
          result: receipt,
        }),
        s.now(),
        operation,
      );
    return receipt as T;
  } catch (error) {
    s.db
      .prepare(
        "UPDATE events SET status=?,error_code=?,completed_at=? WHERE id=?",
      )
      .run(
        error instanceof AppError ? "cancelled" : "failed",
        error instanceof AppError ? error.code : "TOOL_EFFECT_UNCERTAIN",
        s.now(),
        operation,
      );
    throw error;
  }
}
