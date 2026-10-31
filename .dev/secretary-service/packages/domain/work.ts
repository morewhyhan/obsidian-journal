import { DateTime } from "luxon";
import { AppError, type Action, type Registry, type Source, type Followup } from "../contracts/types.js";
import { workInputSchema, type WorkRef } from "../contracts/work.js";
import { canonicalJson, hash, id } from "../shared/identity.js";

type Context={now:string;zone:string;source:Source;operation:string;userAuthorized:boolean;verified?:Map<string,Source>};
export function referencedObject(r:Registry,ref:WorkRef) {
  return ({task:r.tasks,habit:r.habits,plan:r.plans,proposal:r.proposals,rule:r.user_rules??[],note:[]})[ref.kind]
    .find(x=>x.id===ref.id);
}
export function resumeWorkStatus(f:Followup):"open"|"waiting_user"|"waiting_condition" {
  return f.work?.owner==="user" ? "waiting_user" : f.work?.owner==="condition" ? "waiting_condition" : "open";
}
/** Only application checkers supply completion evidence; analysis and delivery are not completion. */
export function transitionWork(f:Followup,expectedVersion:number,step:string,evidence:string[],c:Context,
  close:"completed"|"cancelled"|"superseded"="completed") {
  if(!f.work || f.version!==expectedVersion || f.work.step_id!==step || f.status==="resolved")
    throw new AppError("VERSION_CONFLICT","工作步骤已变化",409);
  if(close==="completed" && !evidence.length) throw new AppError("WORK_EVIDENCE_REQUIRED","步骤完成需要实际证据");
  f.status="resolved"; f.resolved_at=c.now; f.next_check_at=null;
  f.work.resolution={kind:close,at:c.now,source:c.source,evidence:evidence.slice(0,8)};
  f.version++; f.updated_at=c.now; f.last_operation_id=c.operation;
}
export function workAction(r:Registry,a:Action,c:Context):string[]|null {
  if (!["save_work","control_work"].includes(a.type)) return null;
  if(!c.userAuthorized) throw new AppError("NEEDS_CONFIRMATION","工作记录需要当前协作来源");
  const all=r.followups ??= [];
  const existing=all.find(f=>f.id===a.target_id && f.work);
  const check=(f:Followup)=>{
    if(a.expected_version!==f.version) throw new AppError("VERSION_CONFLICT","工作记录已变化，请查询followups",409);
  };
  if(a.type==="control_work") {
    if(!existing) throw new AppError("ITEM_NOT_FOUND","工作记录不存在",404);
    check(existing);
    if(!["pause","resume","stop","complete"].includes(String(a.control))) throw new AppError("INVALID_TRANSITION","工作记录控制类型无效");
    if(a.control==="complete") {
      const proof=c.verified?.get("work:"+existing.id+":"+existing.work!.step_id);
      if(!proof || existing.work!.done_when?.kind!=="user_confirmed")throw new AppError("WORK_EVIDENCE_REQUIRED","需要本人接受当前具体结果及有效文件证据");
      transitionWork(existing,existing.version,existing.work!.step_id!,["accepted-result:"+proof.external_id],c);
      return [existing.id];
    }
    if(a.control==="stop") {
      if(existing.status!=="resolved") transitionWork(existing,existing.version,existing.work!.step_id!,[],c,"cancelled");
      return [existing.id];
    }
    if(existing.status==="resolved") throw new AppError("INVALID_TRANSITION","已结束责任不能由恢复操作复活");
    if(a.control==="resume") {
      if(existing.status!=="paused") throw new AppError("INVALID_TRANSITION","仅暂停的责任可以恢复");
      existing.status=resumeWorkStatus(existing);delete existing.work!.paused_from;
      existing.asked_keys=[];delete existing.analysis;
    } else {
      existing.work!.paused_from=existing.status==="paused" ? existing.work!.paused_from : existing.status;
      existing.status="paused";
    }
    existing.version++;existing.updated_at=c.now;existing.last_operation_id=c.operation;
    return [existing.id];
  }
  const parsed=workInputSchema.safeParse(a.work);
  if(!parsed.success) throw new AppError("INVALID_WORK","工作字段或完成条件无效");
  const w=parsed.data;
  const found=existing ?? all.find(f=>f.work?.key===w.key);
  if(found) check(found);
  if(found?.status==="resolved") throw new AppError("INVALID_TRANSITION","已结束责任请使用新的工作key");
  if(!found && all.filter(f=>f.work && f.status!=="resolved").length>=64) throw new AppError("WORK_LIMIT","活动工作记录已达上限，先收尾旧事项");
  const refs=w.refs ?? found?.work?.refs ?? [];
  for(const ref of refs) {
    if(ref.kind!=="note") {
      const item=referencedObject(r,ref);
      if(!item || (ref.observed_version!==undefined && ref.observed_version!==item.version))
        throw new AppError("VERSION_CONFLICT","工作关联不存在或已变化",409);
    }
  }
  const done=w.done_when ?? found?.work?.done_when;
  if(done && (((done.kind==="material_verified" || done.kind==="user_confirmed") &&
      !refs.some(ref=>ref.kind==="note" && ref.path===done.path)) ||
    (done.kind==="condition_observed" && !refs.some(ref=>ref.kind===done.ref.kind && (ref.id??ref.path)===(done.ref.id??done.ref.path))) ||
    (done.kind==="decision_recorded" && !refs.some(ref=>ref.kind==="proposal" && ref.id===done.proposal_id))))
    throw new AppError("INVALID_WORK","完成条件只能使用本步骤的正式引用");
  let at:string|null=null;
  if(w.check_at!=null) {
    const instant=DateTime.fromISO(w.check_at,{setZone:true});
    if(!instant.isValid || instant.toMillis()<=Date.parse(c.now)) throw new AppError("INVALID_WORK","下次检查须为未来时刻");
    at=instant.toUTC().toISO();
  }
  const prior=found?.work;
  const changed=!!prior && canonicalJson([prior.owner,prior.next_action,prior.condition,prior.done_when,prior.refs])!==
    canonicalJson([w.owner,w.next_action,w.condition??null,done,refs]);
  // A fresh explicit instruction can replace the scope. A background handoff cannot authorize itself.
  const renewDelegation=!prior?.delegation || c.source.channel!=="coordinator";
  const step_id=!prior?.step_id || changed ? id("step") : prior.step_id;
  const work:NonNullable<Followup["work"]>={key:w.key,summary:w.summary,owner:w.owner,next_action:w.next_action,
    condition:w.condition??null,source:prior?.source??c.source,refs,step_id,
    ...(done ? {done_when:done}:{}),wake_on:w.wake_on??prior?.wake_on??[],
    // Baselines for declared wake conditions: without them "changed" is a guess.
    wake_versions:Object.fromEntries((w.wake_on??prior?.wake_on??[]).flatMap(wake=>{
      const key=wake.ref.id??wake.ref.path;
      const item=key?referencedObject(r,wake.ref) as {version?:number}|undefined:undefined;
      return key&&typeof item?.version==="number" ? [[key,item.version]] : [];
    })),
    delegation:!renewDelegation ? prior!.delegation : {source:c.source,capabilities:["read_related","prepare_next_action","manage_work"],
      object_ids:refs.flatMap(ref=>ref.id?[ref.id]:[]),paths:refs.flatMap(ref=>ref.path?[ref.path]:[]),
      write_paths:refs.flatMap(ref=>ref.role==="output" && ref.path?[ref.path]:[]),
      rules_revision:r.rules_revision??0,expires_at:null},
    prior_steps:[...(prior?.prior_steps??[]),...(changed && prior?.step_id ? [{step_id:prior.step_id,at:c.now,
      kind:"superseded" as const,evidence:["input:"+c.source.input_id]}]:[])].slice(-8)};
  if(renewDelegation && refs.some(ref=>ref.kind==="note" && ref.role==="output") &&
    (done?.kind==="material_verified" || done?.kind==="user_confirmed"))
    work.delegation!.capabilities.push("write_named_artifact");
  const fingerprint=hash(canonicalJson([work.refs,work.step_id,work.done_when,w.owner,w.condition,at]));
  const f:Followup={id:found?.id ?? "work:"+w.key,version:(found?.version??0)+1,created_at:found?.created_at??c.now,
    updated_at:c.now,last_operation_id:c.operation,business_date:DateTime.fromISO(c.now,{zone:c.zone}).toISODate()!,
    issue:{id:"work:"+w.key,kind:"work",severity:"info",message:w.summary,recommendation:w.next_action,
      question:w.owner==="user" ? w.next_action : null},fingerprint,
    status:w.owner==="user" ? "waiting_user" : w.owner==="condition" ? "waiting_condition" : "open",
    next_check_at:at,asked_keys:[],attempts:found?.attempts??[],work};
  if(found?.status==="paused") {f.status="paused";work.paused_from=prior?.paused_from;}
  if(w.owner!=="assistant" && !at && c.source.channel!=="coordinator") f.asked_keys=[f.id+"@"+f.fingerprint];
  if(found) all[all.indexOf(found)]=f;else all.push(f);
  return [f.id];
}
