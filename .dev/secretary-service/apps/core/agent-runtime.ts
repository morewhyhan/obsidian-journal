import { DateTime } from "luxon";
import type { Core } from "./core.js";
import { AppError, type Action, type Input, type Registry } from "../../packages/contracts/types.js";
import { canonicalJson, hash, id } from "./files.js";
import { policyStamp } from "./tool-effects.js";
import { selectedProposalActions } from "../../packages/domain/decisions.js";
import { validateActionFields } from "../../packages/contracts/action-fields.js";
import { checkGrant,checkBackgroundActions } from "./background-grant.js";
import { checkReads,advanceOwnReads,recordQuery,recordNote } from "./read-stamps.js";
import { requireCapability } from "./policy.js";
import { requireRuntimeCombination } from "./compatibility-runtime.js";
import { newerInputBlocks } from "./classification.js";
import {modelDeadline} from "./model-job.js";

export const CALL_OPERATIONS = ["apply_changes","save_proposals","resolve_proposals"] as const;
export type BusinessCall = {
  input_id: string;
  call_id: string;
  contract_version?: 1;
  operation: "apply_changes" | "save_proposals" | "resolve_proposals";
  commit_mode?: "independent_groups" | "all_or_nothing";
  action_groups?: { action_identity: string; actions: Action[]; proposal_id?:string;expected_version?:number;
    basis_refs?:{kind:"current_input"|"proposal_decision"|"rule"|"delegation";id:string;version?:number}[] }[];
  summary?: string;
  decisions?: {
    target_id: string;
    expected_version: number;
    decision: "accept" | "reject" | "defer";
    action_indices?: number[];
    replacements?: Action[];
  }[];
};

type BasisRef = { kind: "current_input" | "proposal_decision" | "rule" | "delegation"; id: string; version?: number };
type ExecutionGroup = {
  action_identity: string;
  actions: Action[];
  proposal_id?: string;
  expected_version?: number;
  decision?: "accept" | "reject" | "defer";
  basis_refs?: BasisRef[];
};

function validateBusinessCall(args: BusinessCall) {
  if (Object.keys(args).some(k=>!["input_id","call_id","contract_version","operation","commit_mode","action_groups","summary","decisions"].includes(k)) ||
    (args.commit_mode !== undefined && !["independent_groups","all_or_nothing"].includes(args.commit_mode)) ||
    !CALL_OPERATIONS.includes(args.operation) ||
    (args.contract_version !== undefined && args.contract_version !== 1))
    throw new AppError("INVALID_COMMAND", "业务命令包含不支持的字段、操作或提交方式");
  const deciding=args.operation === "resolve_proposals", values=deciding ? args.decisions : args.action_groups;
  if (!Array.isArray(values) || !values.length || values.length>20 ||
    (deciding ? args.action_groups !== undefined : args.decisions !== undefined))
    throw new AppError("INVALID_COMMAND", "需要1到20组明确操作或决定，不能混用");
  const identities=new Set<string>();
  for (const item of values) {
    const group=item as ExecutionGroup;
    const decision=item as NonNullable<BusinessCall["decisions"]>[number];
    const identity=deciding ? decision?.target_id : group?.action_identity;
    if (typeof identity !== "string" || !identity.trim() || identity.length>200)
      throw new AppError("INVALID_COMMAND", "操作需要稳定、非空的标识");
    if (identities.has(identity)) throw new AppError("DUPLICATE_GROUP", "同一批不能重复操作标识或提案对象");
    identities.add(identity);
    if (!deciding && (Object.keys(group).some(k=>!["action_identity","actions","proposal_id","expected_version","basis_refs"].includes(k)) ||
      !Array.isArray(group.actions) || !group.actions.length || group.actions.length>20 ||
      group.actions.some(a=>!a || typeof a!=="object" || typeof a.type!=="string")))
      throw new AppError("INVALID_COMMAND", "每组需要1到20个类型明确的动作");
    if (deciding && (Object.keys(decision).some(k=>!["target_id","expected_version","decision","action_indices","replacements"].includes(k)) ||
      !Number.isInteger(decision.expected_version) || decision.expected_version<1 ||
      !["accept","reject","defer"].includes(decision.decision) ||
      (decision.replacements!==undefined && decision.decision!=="accept")))
      throw new AppError("INVALID_DECISION", "决定类型、版本或修订范围不合法；仅接受可附修订");
  }
}

function validateBasis(core: Core, input: Input, group: ExecutionGroup) {
  const { row } = nativeSession(core, input.id);
  const refs = group.basis_refs ?? [{ kind: "current_input" as const, id: input.id }];
  if (!Array.isArray(refs) || !refs.length || refs.length > 8)
    throw new AppError("BASIS_INVALID", "执行依据数量无效", 403);
  for (const ref of refs) {
    if (Object.keys(ref).some(k=>!["kind","id","version"].includes(k)))
      throw new AppError("BASIS_INVALID", "执行依据不能附带自签来源", 403);
    if (row.channel === "coordinator") {
      const g = checkGrant(core.store, input.id);
      if (ref.kind !== "delegation" || ref.id !== g.id)
        throw new AppError("BASIS_INVALID", "后台只能引用本次Core委托", 403);
    } else if (ref.kind === "current_input") {
      if (ref.id !== input.id) throw new AppError("BASIS_INVALID", "当前指令只能引用本次真实入件", 403);
    } else if (ref.kind === "proposal_decision") {
      const proposal = core.store.registry().proposals.find(p=>p.id===ref.id);
      if (!proposal?.decisions?.some(d=>d.proposal_version===ref.version && d.decision==="accept"))
        throw new AppError("BASIS_INVALID", "原案决定没有可核对的接受依据", 403);
    } else if (ref.kind === "rule") {
      const rule = core.store.registry().user_rules?.find(r=>r.id===ref.id);
      if (!rule || rule.version !== ref.version || !rule.enabled || rule.starts_at > core.store.now() ||
        rule.ends_at && rule.ends_at <= core.store.now() || rule.key.startsWith("working."))
        throw new AppError("BASIS_INVALID", "规则不是当前有效的执行依据", 403);
    } else throw new AppError("BASIS_INVALID", "不能自行签发委托", 403);
  }
}

function groupRef(group: ExecutionGroup) {
  const semantic = group.actions.map(({ expected_version, expected_rules_revision, expected_planning_version, ...intent }) => intent);
  const fingerprint = hash(canonicalJson(semantic));
  return { identity: group.decision ? "decision:" + group.action_identity : "apply:" + fingerprint,
    fingerprint, compatibility_identity: group.action_identity };
}

function previousGroup(core: Core, input: Input, group: ExecutionGroup) {
  const ref = groupRef(group);
  const prior = core.store.db.prepare("SELECT e.status,e.payload_json FROM events e,json_each(e.payload_json,'$.logical_groups') g WHERE e.kind='business' AND e.input_id=? AND (json_extract(g.value,'$.identity')=? OR json_extract(g.value,'$.compatibility_identity')=?) ORDER BY e.rowid DESC LIMIT 1")
    .get(input.id, ref.identity, ref.compatibility_identity) as any;
  if (!prior) return null;
  const data = JSON.parse(prior.payload_json), bound = data.logical_groups.find((x: any) => x.identity === ref.identity || x.compatibility_identity === ref.compatibility_identity);
  if (bound.fingerprint !== ref.fingerprint) throw new AppError("IDEMPOTENCY_REUSED", "此业务标识已有不同的已提交内容，请核对实际结果", 409);
  if (prior.status !== "applied") return { identity: group.action_identity, status: "uncertain" as const,
    error: { code: "OPERATION_UNCERTAIN", effect: "unknown" as const, retry_policy: "reconcile_only" as const, message: "原提交尚未核对，不能重复执行" } };
  const result = data.result;
  return { identity: group.action_identity, status: group.decision === "defer" ? "pending_decision" as const : "applied" as const,
    ...(group.proposal_id ? { ids: [group.proposal_id] } : {}), operation_id: result.operation_id, updated_ids: result.updated_ids,
    effects: result.message, already_applied: true, updated_ids_scope: "commit_set" as const,
    projection: { status: "pending" as const, warnings: ["原业务已经提交；日记同步状态请查询实际记录"] } };
}

// Shared mutable roots publish together from the same observed baseline. Disjoint
// groups keep separate receipts and failure boundaries; no generic workflow engine.
function executionUnits(core: Core, groups: ExecutionGroup[], atomic?: boolean) {
  const r = core.store.registry();
  const keys = (group: ExecutionGroup) => new Set(group.actions.flatMap(action => {
    const proposal = action.type === "accept_proposal" ? r.proposals.find(p=>p.id===action.target_id) : undefined;
    return [action, ...(proposal ? selectedProposalActions(action, proposal).selected : [])].flatMap(a => [
      ...(a.target_id ? [a.target_id] : []),
      ...(a.target_id && r.plans.some(plan=>plan.id===a.target_id) ? [r.plans.find(plan=>plan.id===a.target_id)!.target_ref.id] : []),
      ...(["schedule","reschedule"].includes(a.type) || a.initial_plan ? ["$schedule"] : []),
      ...(["set_personal_rule","control_rule","undo_rule","set_planning"].includes(a.type) ? ["$policy"] : []),
    ]);
  }));
  const units: { members: ExecutionGroup[]; keys: Set<string> }[] = [];
  for (const group of groups) {
    const own = keys(group), overlaps = units.filter(u => atomic || [...own].some(k=>u.keys.has(k)));
    const unit = { members: [group], keys: own };
    for (const old of overlaps) {
      unit.members.push(...old.members);
      for (const key of old.keys) unit.keys.add(key);
      units.splice(units.indexOf(old),1);
    }
    unit.members.sort((a,b)=>groups.indexOf(a)-groups.indexOf(b));units.push(unit);
  }
  return units.sort((a,b)=>groups.indexOf(a.members[0])-groups.indexOf(b.members[0]));
}

export function nativeSession(core: Core, inputId: string, mutate = false) {
  if(mutate)requireRuntimeCombination(core.store);
  const row = core.store.db.prepare("SELECT * FROM inbox WHERE id=?").get(inputId) as any;
  if (!row || row.status !== "processing" || JSON.parse(row.metadata_json).agent_execution !== "tools-v2")
    throw new AppError("APPLICATION_SESSION_EXPIRED", "工具调用不属于有效的自主执行回合", 403);
  const meta = JSON.parse(row.metadata_json);
  if(meta.runtime_generation && meta.runtime_generation!==core.store.generation || meta.deadline_at && meta.deadline_at<=core.store.now() ||
    meta.model_job_id && core.store.runtimeMeta().model_job?.id!==meta.model_job_id)
    throw new AppError("APPLICATION_SESSION_EXPIRED","作业期限或执行权已失效",403);
  if(meta.model_job_id)modelDeadline(core.store,true);
  if(mutate)checkReads(core.store,inputId);
  if (mutate && row.channel === "coordinator") checkGrant(core.store,inputId);
  if (mutate && meta.policy_stamp !== policyStamp(core.store))
    throw new AppError("VERSION_CONFLICT", "规则或时间边界已经变化，请先查询最新状态", 409);
  // Only a newer input that can still change this work holds it: unclassified or
  // unclear input blocks (fail closed), a classified unrelated one does not.
  if (mutate && newerInputBlocks(core.store, inputId, row.channel, row.actor_ref))
    throw new AppError("NEWER_INPUT_PENDING", "用户有新交代，暂停尚未执行的旧操作，下一回合接续", 409);
  return { row, meta, input: {
    id: row.id, channel: row.channel, actor_ref: row.actor_ref, external_id: row.external_id,
    text: row.body, occurred_at: row.occurred_at, reply_to: meta.reply_to ?? undefined,
  } as Input };
}

function assertActions(core: Core, inputId: string, actions: Action[]) {
  if (!actions.length || actions.length > 20) throw new AppError("BATCH_TOO_LARGE", "每组需要1到20个动作");
  const { meta } = nativeSession(core, inputId, true);
  if(nativeSession(core,inputId).row.channel==="coordinator")checkBackgroundActions(core.store,inputId,actions);
  const known = meta.observed_refs ?? meta.authorized_objects ?? [];
  for (const action of actions) {
    if (["accept_proposal", "reject_proposal", "defer_proposal", "link_diary", "project_diary", "pending_diary_binding"].includes(action.type))
      throw new AppError("INTERNAL_ACTION", "原建议请用resolve_proposals，日记绑定由业务操作自动维护");
    validateActionFields(action);
    if (action.target_id && !["pause_contact", "resume_contact", "forget_fact"].includes(action.type) &&
      !known.some((x: any) => x.id === action.target_id && x.version === action.expected_version))
      throw new AppError("VERSION_CONFLICT", "请先查询操作对象及其实际版本", 409);
  }
}

/** Executes in the live model loop. Each independent group has its own result. */
export async function businessCall(core: Core, args: BusinessCall) {
  const s = core.store;
  const { input } = nativeSession(core, args.input_id);
  validateBusinessCall(args);
  if(nativeSession(core,args.input_id).row.channel==="coordinator" && args.operation!=="apply_changes")
    throw new AppError("BACKGROUND_SCOPE","后台不能自行创建或批准新的执行承诺；用本责任的save_work保留待决事项",403);
  const signature = hash(canonicalJson(args));
  const key = "business-tool:" + args.input_id + ":" + args.call_id;
  const prior = s.db.prepare("SELECT * FROM events WHERE dedupe_key=?").get(key) as any;
  if (prior) {
    const data = JSON.parse(prior.payload_json);
    if (data.signature !== signature) throw new AppError("IDEMPOTENCY_REUSED", "调用标识已用于其他内容", 409);
    if (prior.status === "applied") return data.result;
    throw new AppError("TOOL_ALREADY_ATTEMPTED", "该调用曾中断，请查询事实和操作记录，不能重放", 409);
  }
  nativeSession(core, args.input_id, args.operation !== "save_proposals");
  s.db.prepare("INSERT INTO events(id,dedupe_key,input_id,source,kind,payload_json,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(id("tool"), key, input.id, input.channel, "business_tool", JSON.stringify({ signature, operation: args.operation }), s.now());
  const results: any[] = [];
  try {
  const record = (result: any) => {
    if(result.operation_id)result.intent_ref=result.operation_id;
    results.push(normalizeReceipt(core, result));
    // Receipts survive a crash between independent groups; never replay successful groups.
    s.db.prepare("UPDATE events SET payload_json=? WHERE dedupe_key=?")
      .run(JSON.stringify({ signature, operation: args.operation, result: { results } }), key);
  };
  const groups = args.action_groups ?? [];
  if (groups.length > 20 || (args.decisions?.length ?? 0) > 20)
    throw new AppError("BATCH_TOO_LARGE", "一次最多20组");
  if (args.operation === "save_proposals") {
    if (!groups.length) throw new AppError("EMPTY_PROPOSAL", "具体待定建议不能为空");
    const saveGroup = (registry: Registry, group: ExecutionGroup, op: string) => {
      requireCapability(s,"business_write");nativeSession(core,input.id,true);
      if (!group.actions.length || group.actions.length > 20) throw new AppError("BATCH_TOO_LARGE", "每份建议需要1到20个动作");
      if (group.actions.some(a => ["accept_proposal", "reject_proposal", "link_diary", "project_diary"].includes(a.type)))
        throw new AppError("INTERNAL_ACTION", "不能在建议中嵌套内部动作");
      group.actions.forEach(validateActionFields);
      if(group.proposal_id) {
        const original=registry.proposals.find(p=>p.id===group.proposal_id);
        if(!original || original.version!==group.expected_version || original.status!=="pending" || original.expires_at<=s.now())
          throw new AppError("PROPOSAL_EXPIRED","原草案已经变化或结束",409);
        if(canonicalJson(original.actions)!==canonicalJson(group.actions)) {
          original.actions=structuredClone(group.actions);original.version++;original.updated_at=s.now();original.last_operation_id=op;
          original.summary=(args.summary??original.summary).slice(0,500);
        }
        return {ids:[original.id],message:"revised_pending"};
      }
      const existing = registry.proposals.find(p => p.status === "pending" && p.expires_at > s.now() && canonicalJson(p.actions) === canonicalJson(group.actions));
      if (existing) return { ids: [existing.id], message: "existing" };
      const p = { id: id("proposal"), version: 1, created_at: s.now(), updated_at: s.now(), last_operation_id: op,
        summary: (args.summary ?? group.action_identity).slice(0, 500), actions: group.actions,
        expires_at: DateTime.fromISO(s.now()).plus({ days: 7 }).toUTC().toISO()!, status: "pending" as const, source: core.source(input) };
      registry.proposals.push(p);
      return { ids: [p.id], message: "pending" };
    };
    if (args.commit_mode === "all_or_nothing") {
      // One transaction for the whole batch: a later invalid group must not leave earlier ones saved.
      const saved: {identity:string;ids:string[]}[]=[];
      try {
        await s.exclusive(() => {
          const committed=s.commit(key, input.channel, input.id, (registry, _load, op) => {
            for(const group of groups) saved.push({identity:group.action_identity,...saveGroup(registry,group,op)});
            return {ids:saved.flatMap(x=>x.ids),message:"pending"};
          });
          advanceOwnReads(s,input.id);return committed;
        });
        for(const item of saved) record({ status: "pending_decision", identity:item.identity, ids: item.ids });
      } catch (error) {
        for(const group of groups) record(groupFailure(group.action_identity,error));
      }
    } else for (const group of groups) {
      try {
        const saved = await s.exclusive(() => { const committed=s.commit(key + ":" + group.action_identity,
          input.channel, input.id, (registry, _load, op) => saveGroup(registry,group,op));
          advanceOwnReads(s,input.id);return committed;});
        record({ status: "pending_decision", identity: group.action_identity, ids: saved.updated_ids });
      } catch (error) { record(groupFailure(group.action_identity,error)); }
    }
    const ids = results.flatMap(r => r.ids ?? []);
    s.db.prepare("UPDATE inbox SET metadata_json=json_set(metadata_json,'$.offered_proposal_ids',json(?)) WHERE id=?")
      .run(JSON.stringify(ids), input.id);
    const shown=ids.map((pid:string)=>s.registry().proposals.find(p=>p.id===pid)).filter(Boolean)
      .map((p:any)=>({proposal_id:p.id,version:p.version,hash:hash(canonicalJson({version:p.version,actions:p.actions}))}));
    s.db.prepare("UPDATE inbox SET metadata_json=json_set(metadata_json,'$.offered_proposals',json(?)) WHERE id=?")
      .run(JSON.stringify(shown),input.id);
  } else if (args.operation === "apply_changes") {
    const fresh:ExecutionGroup[]=[];
    for (const group of groups) {
      try { validateBasis(core,input,group);const prior=previousGroup(core,input,group); if(prior) record(prior); else fresh.push(group); }
      catch(error) { record(failure(core,input,[],"",error,group.action_identity)); }
    }
    if(args.commit_mode === "all_or_nothing" && results.some(r=>["rejected","uncertain"].includes(r.status))) {
      for(const group of fresh) record({identity:group.action_identity,status:"rejected",error:{code:"BATCH_ABORTED",effect:"not_applied",message:"原操作需要核对，整批新变更未执行"}});
    } else for (const unit of executionUnits(core, fresh, args.commit_mode === "all_or_nothing")) {
      const actions=unit.members.flatMap(g=>g.actions);
      const logical="native-group:"+canonicalJson(unit.members.map(g=>g.action_identity).sort());
      try {
        assertActions(core, input.id, actions);
        const result = await core.execute(input, actions, logical, true, unit.members.map(groupRef),()=>{for(const group of unit.members)validateBasis(core,input,group);});
        const cleanup=(result as any).revocation_cleanup;
        const projection=cleanup?.state==="pending"
          ? {...result.projection,warnings:[...(result.projection?.warnings??[]),"已停用，清理待完成"]}
          : result.projection;
        for (const group of unit.members) record({ identity:group.action_identity,status: "applied", operation_id: result.operation_id,
          updated_ids: result.updated_ids,updated_ids_scope:"commit_set", effects: result.message, projection,
          ...(cleanup ? {revocation_cleanup: cleanup} : {}) });
        // A legitimate rule change performed by this run is now its own current policy.
        s.db.prepare("UPDATE inbox SET metadata_json=json_set(metadata_json,'$.policy_stamp',?) WHERE id=?")
          .run(policyStamp(s), input.id);
      } catch (error) { for (const group of unit.members) record(failure(core,input,actions,logical,error,group.action_identity)); }
    }
  } else {
    if (!args.decisions?.length) throw new AppError("EMPTY_DECISION", "需要具体提案引用及决定");
    const accepted:ExecutionGroup[]=[];
    for (const decision of args.decisions) {
      try {
        nativeSession(core, input.id, true);
        const action:Action={ type:decision.decision === "accept" ? "accept_proposal" : decision.decision === "reject" ? "reject_proposal" : "defer_proposal",
          target_id:decision.target_id,expected_version:decision.expected_version,...(decision.action_indices ? {action_indices:decision.action_indices} : {}),
          ...(decision.replacements ? {amended_actions:decision.replacements} : {}) };
        const group:ExecutionGroup={action_identity:decision.target_id+"@"+decision.expected_version,proposal_id:decision.target_id,decision:decision.decision,actions:[action]};
        const previous=previousGroup(core,input,group);
        if(previous) {record(previous);continue;}
        const p = s.registry().proposals.find(p => p.id === decision.target_id);
        const known = nativeSession(core, input.id).meta.observed_refs ?? nativeSession(core, input.id).meta.authorized_objects ?? [];
        if (!p || p.version !== decision.expected_version || p.status !== "pending" || p.expires_at <= s.now() ||
          !known.some((x: any) => x.id === p.id && x.version === p.version))
          throw new AppError("PROPOSAL_EXPIRED", "建议已经变化或不在已读对象中，请查询当前版本", 409);
        const selected=selectedProposalActions(action,p);
        if (decision.decision === "accept") selected.selected.forEach(validateActionFields);
        if (decision.replacements) assertActions(core, input.id, decision.replacements);
        accepted.push(group);
      } catch (error) { record(failure(core,input,[],"",error,decision.target_id)); }
    }
    if (args.commit_mode === "all_or_nothing" && results.some(r=>r.status === "rejected" || r.status === "uncertain")) {
      for (const group of accepted) record({status:"rejected",identity:group.action_identity,error:{code:"BATCH_ABORTED",effect:"not_applied",message:"同批已有无效决定，整批未执行"}});
    } else for (const unit of executionUnits(core, accepted, args.commit_mode === "all_or_nothing")) {
      const actions=unit.members.flatMap(g=>g.actions);
      const logical="native-group:"+canonicalJson(unit.members.map(g=>g.action_identity).sort());
      try {
        const outcome=await core.execute(input,actions,logical,true,unit.members.map(groupRef));
        for (const group of unit.members) record({status:group.decision === "defer" ? "pending_decision" : "applied",identity:group.action_identity,ids:[group.proposal_id],
          updated_ids:outcome.updated_ids,operation_id:outcome.operation_id,effects:outcome.message,projection:outcome.projection});
        s.db.prepare("UPDATE inbox SET metadata_json=json_set(metadata_json,'$.policy_stamp',?) WHERE id=?").run(policyStamp(s),input.id);
      } catch (error) { for (const group of unit.members) record(failure(core,input,actions,logical,error,group.action_identity)); }
    }
  }
  const changed = new Set(results.flatMap(r => [...(r.updated_ids ?? []), ...(r.ids ?? [])]));
  const access = nativeSession(core, input.id).meta.observed_refs ?? nativeSession(core, input.id).meta.authorized_objects ?? [];
  const registry = s.registry();
  const refs = [...registry.habits, ...registry.tasks, ...registry.plans, ...registry.proposals, ...(registry.followups??[]), ...core.assistant.view().objects]
    .filter(x => changed.has(x.id)).map(x => ({ id: x.id, version: x.version }));
  const result = { results, updated_refs: refs };
  s.db.prepare("UPDATE inbox SET metadata_json=json_set(metadata_json,'$.observed_refs',json(?)) WHERE id=?")
    .run(JSON.stringify([...new Map([...access, ...refs].map(x => [x.id, x])).values()]), input.id);
  s.db.prepare("UPDATE events SET status='applied',payload_json=?,completed_at=? WHERE dedupe_key=?")
    .run(JSON.stringify({ signature, operation: args.operation, result }), s.now(), key);
  return result;
  } catch (error) {
    s.db.prepare("UPDATE events SET status=?,error_code=?,payload_json=?,completed_at=? WHERE dedupe_key=?")
      .run(error instanceof AppError ? "cancelled" : "failed", error instanceof AppError ? error.code : "EXECUTION_UNCERTAIN",
        JSON.stringify({signature,operation:args.operation,result:{results}}),s.now(),key);
    throw error;
  }
}

function registeredKind(r:Registry,id:string) {
  for(const [kind,list] of [["task",r.tasks],["habit",r.habits],["plan",r.plans],["proposal",r.proposals],
    ["rule",r.user_rules??[]],["work",r.followups??[]]] as [string,{id:string;version:number}[]][])
    if(list.some(x=>x.id===id))return {kind,version:list.find(x=>x.id===id)!.version};
  return {kind:"object",version:1};
}
function groupFailure(identity:string,error:unknown,stage:"validation"|"prepare"|"apply"|"projection"="validation") {
  const uncertain=!(error instanceof AppError);
  return {status:"rejected" as const,identity,changed_refs:[],already_applied:false,
    error:{code:error instanceof AppError ? error.code : "EXECUTION_UNCERTAIN",
      message:error instanceof AppError ? error.message : "操作结果未知，先查询事实，不要重放",
      stage:uncertain ? "apply" as const : stage,effect:uncertain ? "unknown" as const : "not_applied" as const,
      retry:uncertain ? "reconcile_only" as const : error instanceof AppError && error.status===409 ? "reread" as const : "none" as const}};
}
/** Adds the shared C1 receipt fields without discarding the legacy fields tests and clients read. */
function normalizeReceipt(core:Core,receipt:any) {
  const registry=core.store.registry(),ids=[...(receipt.updated_ids??[]),...(receipt.ids??[])];
  const changed_refs=receipt.changed_refs ?? [...new Set(ids)].map(id=>{
    const {kind,version}=registeredKind(registry,id);return {kind,id,version};
  });
  const projection=receipt.projection && typeof receipt.projection==="object"
    ? {status:receipt.projection.status??"pending",warnings:receipt.projection.warnings??[]}
    : {status:receipt.status==="applied" ? "applied" : "not_needed",warnings:[]};
  let error=receipt.error;
  if(error) {
    const retry=error.retry ?? (error.retry_policy==="reread" ? "reread" : error.retry_policy==="reconcile_only" ? "reconcile_only" :
      error.retry_policy==="backoff" ? "resume" : "none");
    error={...error,stage:error.stage ?? (receipt.status==="uncertain" ? "apply" : "validation"),retry};
  }
  return {...receipt,status:receipt.status,changed_refs,already_applied:receipt.already_applied??false,projection,
    ...(error ? {error} : {})};
}
function failure(core:Core,input:Input,actions:Action[],logical:string,error: unknown, identity: string) {
  const attempt=actions.length ? core.store.db.prepare("SELECT status,payload_json FROM events WHERE dedupe_key=?")
    .get(core.operationKey(input,actions,logical)) as {status:string;payload_json:string}|undefined : undefined;
  if (attempt?.status === "applied") {
    const saved=JSON.parse(attempt.payload_json).result;
    return {status:"applied",identity,operation_id:saved.operation_id,updated_ids:saved.updated_ids,effects:saved.message,
      projection:{status:"pending",warnings:["业务已保存，后续同步中断，需核对"]}};
  }
  const uncertain=!!attempt || !(error instanceof AppError);
  return { status: uncertain ? "uncertain" : "rejected", identity, error: {
    code: error instanceof AppError ? error.code : "EXECUTION_UNCERTAIN",
    message: error instanceof AppError ? error.message : "操作结果未知，先查询事实，不要重放",
    effect: uncertain ? "unknown" : "not_applied",
    retry_policy:uncertain ? "reconcile_only" : error instanceof AppError && error.status === 409 ? "reread" : "none",
  } };
}

/** Native adapters return the model's actual answer after all tool results. */
export async function processNativeInput(core: Core, input: Input) {
  const s = core.store;
  const previous = JSON.parse((s.db.prepare("SELECT metadata_json FROM inbox WHERE id=?").get(input.id) as any).metadata_json);
  if (previous.interrupted) {
    if (!core.agent?.compose) throw new AppError("RECOVERY_LANGUAGE_UNAVAILABLE", "中断结果等待模型说明，未重放操作");
    const {text} = await core.agent.compose({purpose:"interrupted_run",request:input.text,effects:core.inputEffects(input.id),
      constraint:"上次执行中断；说明真实已保存和未知部分，不重新执行，不假装全部未做或全部成功。"});
    s.db.prepare("UPDATE inbox SET metadata_json=json_set(metadata_json,'$.reply_origin','llm','$.recovered_without_replay',json('true')) WHERE id=?").run(input.id);
    core.finishInput(input,text);return;
  }
  const bundle = core.context(input);
  const objects = [...bundle.items, ...bundle.plans, ...bundle.proposals, ...bundle.work, ...bundle.assistant.objects]
    .map(x => ({ id: x.id, version: x.version }));
  s.db.prepare("UPDATE inbox SET metadata_json=json_set(metadata_json,'$.agent_execution','tools-v2','$.read_only',json('false'),'$.policy_stamp',?,'$.observed_refs',json(?),'$.turn_started_at',?) WHERE id=?")
    .run(policyStamp(s), JSON.stringify(objects), s.now(), input.id);
  // Preloaded facts are reads too. An empty/truncated bundle is never write authority.
  const registry=s.registry();
  recordQuery(s,input.id,{operation:"state",ids:[...bundle.items,...bundle.plans,...bundle.proposals].map(x=>x.id)},registry);
  recordQuery(s,input.id,{operation:"state",scope:"controls"},registry);
  for(const doc of bundle.documents)recordNote(s,input.id,doc.path,doc.hash);
  const result = await core.agent!.interpret(input, bundle);
  if (result.action_groups.some(g => g.actions.length))
    throw new AppError("NATIVE_TOOLS_REQUIRED", "业务操作必须在模型循环内完成，不能结束后再执行候选");
  const text = (result.discussion || result.clarification || result.summary || "").trim();
  if (!text) throw new AppError("EMPTY_ANSWER", "模型未给出有效回答");
  const groups = (s.db.prepare("SELECT payload_json FROM events WHERE input_id=? AND kind='business_tool' AND status='applied' ORDER BY rowid").all(input.id) as any[])
    .flatMap(row => JSON.parse(row.payload_json).result?.results ?? []).map((r: any) => ({
      status: r.status === "applied" ? "accepted" : r.status === "pending_decision" ? "needs_confirmation" : r.status === "uncertain" ? "uncertain" : "rejected",
      ...(r.operation_id ? { operation_id: r.operation_id } : {}), ...(r.error?.code ? { reason: r.error.code } : {}),
    }));
  s.db.prepare("UPDATE inbox SET metadata_json=json_set(metadata_json,'$.groups',json(?)) WHERE id=?").run(JSON.stringify(groups), input.id);
  const pendingNew = s.db.prepare("SELECT 1 FROM inbox WHERE rowid>(SELECT rowid FROM inbox WHERE id=?) AND channel=? AND actor_ref=? AND status='pending'")
    .get(input.id, input.channel, input.actor_ref);
  if (pendingNew) {
    // A newer message arrived while this answer was being produced. The answer to
    // the earlier question is still owed (S4): mark it as overtaken, never drop it.
    s.db.prepare("UPDATE inbox SET metadata_json=json_set(metadata_json,'$.superseded_while_pending',json('true')) WHERE id=?").run(input.id);
  }
  s.db.prepare("UPDATE inbox SET metadata_json=json_set(metadata_json,'$.reply_origin','llm','$.language_review',?) WHERE id=?").run(result.language_review ?? "adapter",input.id);
  core.finishInput(input, text);
}
