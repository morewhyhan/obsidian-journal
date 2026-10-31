import { AppError, type Registry } from "../../packages/contracts/types.js";
import { id } from "./files.js";
import { workRefSchema, workDoneSchema,DELEGATION_CAPABILITIES } from "../../packages/contracts/work.js";

/** Pure and idempotent. Called only after old prepared operations are recovered. */
export function migrateRegistry(value:unknown,now:string):Registry {
  const r=structuredClone(value) as Registry;
  if(!r || ![1,2].includes(r.schema_version)) throw new AppError("SCHEMA_UNSUPPORTED","未知业务版本，未修改原文件",503);
  if(r.schema_version===1) {
    for(const f of r.followups??[]) {
      if(!f.work) continue;
      if(f.status==="waiting_condition" && f.asked_keys.length===1 && f.asked_keys[0]==="paused") {
        f.status="paused";f.work.paused_from=f.work.owner==="user"?"waiting_user":f.work.owner==="condition"?"waiting_condition":"open";
        f.asked_keys=[];
      }
      f.work.step_id ??= id("step");
      f.work.refs ??= [];
      f.work.wake_on ??= [];
      // Legacy prose has no provable delegation or completion condition.
      if(f.status==="resolved" && !f.work.resolution) f.work.resolution={kind:"legacy_unspecified",at:f.resolved_at??now,source:f.work.source};
    }
    r.schema_version=2;
  }
  validateRegistry(r);return r;
}
export function validateRegistry(r:Registry) {
  if(!r || typeof r!=="object" || ![1,2].includes(r.schema_version))throw new AppError("STATE_INVALID","业务真源或版本无效",503);
  const keys=["schema_version","revision","last_operation_id","updated_at","habits","tasks","plans","controls",
    "diary_links","proposals","followups","rules_revision","user_rules","automations","focus_date","planning_version",
    "planning_preferences","operational_blocks"];
  if(Object.keys(r).some(k=>!keys.includes(k)) || !Number.isSafeInteger(r.revision) || r.revision<0 ||
    !["habits","tasks","plans","controls","diary_links","proposals"].every(k=>Array.isArray((r as any)[k])))
    throw new AppError("STATE_INVALID","业务真源结构无效",503);
  const walk=(v:any,key="")=>{
    if(typeof v==="number" && (!Number.isFinite(v) || ((key==="version" || key.endsWith("_version") || key==="revision") && !Number.isSafeInteger(v))))
      throw new AppError("STATE_INVALID","业务数值或版本无效",503);
    if(v && typeof v==="object")for(const [k,x] of Object.entries(v))walk(x,k);
  };walk(r);
  const invalid=()=>{throw new AppError("STATE_INVALID","业务字段、来源或单位无效",503);};
  const shape=(value:any,allowed:string[])=>{if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k)))invalid();};
  const instant=(value:any)=>typeof value==="string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  const source=(value:any)=>{shape(value,["input_id","channel","external_id","accepted_at","summary"]);
    if(!["input_id","channel","external_id","summary"].every(k=>typeof value[k]==="string" && value[k].length<=2000) || !instant(value.accepted_at))invalid();};
  const base=["id","version","created_at","updated_at","last_operation_id"];
  const fields:Record<string,string[]>={
    habits:["reminder_mode","definition_history","title","min_behavior","minimum_quantity","optional_target","status","approval","note_refs","recurrence","anchor"],
    tasks:["planning","title","outcome","acceptance","due_at","verification","status","done_at","completion_time","parent_task_id","supporting_habit_ids","approval","note_refs","progress"],
    plans:["overdue_recovery","origin","execution","execution_at","needs_replan","target_ref","kind","window_start","window_end","duration_minutes","next_action","status","approval"],
    controls:["scope","target_id","starts_at","ends_at","reason_source"],
    diary_links:["managed_label","status","allow_append","business_date","target_ref","path","heading","line_fingerprint","position_hint","last_hash","last_item_version"],
    proposals:["decisions","issue_key","summary","actions","expires_at","status","source"],
    followups:["work","business_date","issue","fingerprint","status","resolved_at","next_check_at","asked_keys","contact","analysis","attempts"],
    user_rules:["key","value","starts_at","ends_at","enabled","source"],
    automations:["last_attempted_at","title","kind","status","timezone","due_at","schedule","body","to_diary","strict","quiet_exception","paused_until","skip_dates","approval"],
  };
  for(const [key,allowed] of Object.entries(fields)) {
    const rows=(r as any)[key];if(rows===undefined)continue;
    if(!Array.isArray(rows)||rows.length>100000)invalid();const ids=new Set<string>();
    for(const row of rows) {
      shape(row,[...base,...allowed]);
      if(typeof row.id!=="string" || !row.id || ids.has(row.id) || !Number.isSafeInteger(row.version) || row.version<1 ||
        !instant(row.created_at)||!instant(row.updated_at)||typeof row.last_operation_id!=="string")invalid();
      ids.add(row.id);
      for(const k of ["source","approval","reason_source","overdue_recovery"])if(row[k])source(row[k]);
      if(key==="tasks" && (!Array.isArray(row.acceptance) || !row.acceptance.length || !["draft","ready","in_progress","blocked","done","cancelled"].includes(row.status)))invalid();
      if(key==="habits" && !["draft","active","paused","retired"].includes(row.status))invalid();
      if(key==="plans" && (!instant(row.window_start)||!instant(row.window_end)||Date.parse(row.window_start)>=Date.parse(row.window_end) ||
        !Number.isSafeInteger(row.duration_minutes)||row.duration_minutes<1))invalid();
      for(const k of ["minimum_quantity","optional_target"])if(row[k]) {
        shape(row[k],["value","unit"]);if(typeof row[k].value!=="number"||row[k].value<0||typeof row[k].unit!=="string"||!row[k].unit.trim())invalid();
      }
    }
  }
  if(r.operational_blocks) {
    if(!Array.isArray(r.operational_blocks)||r.operational_blocks.length>128)invalid();
    for(const b of r.operational_blocks) {
      shape(b,["capability","reason_code","source_ref","created_at","cleared_at"]);
      if(!["background_write","contact","model","business_write"].includes(b.capability) || !/^[A-Z0-9_]{1,80}$/.test(b.reason_code) ||
        typeof b.source_ref!=="string" || !instant(b.created_at) || b.cleared_at && !instant(b.cleared_at))invalid();
    }
  }
  for(const f of r.followups??[]) {
    if(!["open","waiting_user","waiting_condition","paused","resolved"].includes(f.status)) throw new AppError("STATE_INVALID","责任状态无效",503);
    if(f.work) {
      shape(f.work,["key","summary","owner","next_action","condition","source","refs","step_id","done_when","wake_on","wake_versions","last_wake","delegation","resolution","paused_from","prior_steps"]);
      source(f.work.source);
      if(!["assistant","user","condition"].includes(f.work.owner) || (f.work.prior_steps?.length??0)>8 || (f.work.wake_on?.length??0)>8)invalid();
      if(f.work.delegation) {
        const d=f.work.delegation;shape(d,["source","capabilities","object_ids","paths","write_paths","rules_revision","expires_at"]);source(d.source);
        if(!Array.isArray(d.capabilities)||d.capabilities.length>6||d.capabilities.some(x=>!DELEGATION_CAPABILITIES.includes(x)) ||
          !Array.isArray(d.object_ids)||d.object_ids.length>8||!Array.isArray(d.paths)||d.paths.length>8 ||
          !Number.isSafeInteger(d.rules_revision)||d.rules_revision<0 || d.expires_at && !instant(d.expires_at) ||
          d.write_paths?.some(p=>!d.paths.includes(p)))invalid();
      }
      if(f.work.resolution) {source(f.work.resolution.source);if(!["completed","cancelled","superseded","legacy_unspecified"].includes(f.work.resolution.kind)||!instant(f.work.resolution.at))invalid();}
      if((f.work.refs?.length??0)>8 || f.work.refs?.some(x=>!workRefSchema.safeParse(x).success) ||
        (f.work.done_when && !workDoneSchema.safeParse(f.work.done_when).success)) throw new AppError("STATE_INVALID","工作引用或检查条件无效",503);
      if(r.schema_version===2 && (!f.work.step_id || f.status==="resolved" && !f.work.resolution))
        throw new AppError("STATE_INVALID","步骤或终态依据缺失",503);
    }
  }
}
