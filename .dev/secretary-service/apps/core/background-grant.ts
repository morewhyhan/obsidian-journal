import { AppError, type Action, type Followup } from "../../packages/contracts/types.js";
import type { Store } from "./store.js";
import { effectivePolicy } from "./policy.js";
import { id,canonicalJson } from "./files.js";
import { referencedObject } from "../../packages/domain/work.js";

export type BackgroundGrant={id:string;work_id:string;step_id:string;generation:string;policy_stamp:string;
  expires_at:string;object_ids:string[];paths:string[];write_paths:string[];capabilities:string[];
  observed_versions:{id:string;version:number}[]};
export function deriveGrant(s:Store,f:Followup):BackgroundGrant {
  const w=f.work,now=s.now(),r=s.registry(),p=effectivePolicy(s,r);
  if(!w?.step_id || !w.delegation || f.status!=="open" || w.owner!=="assistant" || !p.capabilities.background_write ||
    w.delegation.expires_at && w.delegation.expires_at<=now)
    throw new AppError("BACKGROUND_AUTHORITY_REQUIRED","没有当前有效的责任委托",403);
  return {id:id("grant"),work_id:f.id,step_id:w.step_id,generation:s.generation,policy_stamp:p.policy_stamp,
    expires_at:new Date(Math.min(Date.parse(now)+60000,w.delegation.expires_at?Date.parse(w.delegation.expires_at):Infinity)).toISOString(),object_ids:[...w.delegation.object_ids],paths:[...w.delegation.paths],
    write_paths:[...w.delegation.write_paths??[]],
    capabilities:[...w.delegation.capabilities],observed_versions:(w.refs??[]).flatMap(ref=>{
      const item=referencedObject(r,ref);return item?[{id:item.id,version:item.version}]:[];
    })};
}
export function checkGrant(s:Store,inputId:string) {
  const row=s.db.prepare("SELECT channel,status,metadata_json FROM inbox WHERE id=?").get(inputId) as any;
  const g:BackgroundGrant|undefined=row?JSON.parse(row.metadata_json).background_grant:undefined;
  const p=effectivePolicy(s),f=g?s.registry().followups?.find(f=>f.id===g.work_id):null;
  const meta=row?JSON.parse(row.metadata_json):{};
  if(row?.channel!=="coordinator" || row.status!=="processing" || !g || !p.capabilities.background_write ||
    g.generation!==s.generation || g.expires_at<=s.now() || g.policy_stamp!==p.policy_stamp ||
    meta.model_job_id && s.runtimeMeta().model_job?.id!==meta.model_job_id ||
    f?.status!=="open" || f.work?.step_id!==g.step_id || !f.work.delegation ||
    f.work.delegation.expires_at && f.work.delegation.expires_at<=s.now() ||
    g.capabilities.some(cap=>!f.work!.delegation!.capabilities.includes(cap as any)) ||
    g.paths.some(path=>!f.work!.delegation!.paths.includes(path)) ||
    g.write_paths.some(path=>!f.work!.delegation!.write_paths?.includes(path)) ||
    g.object_ids.some(x=>!f.work!.delegation!.object_ids.includes(x)))
    throw new AppError("BACKGROUND_GRANT_EXPIRED","后台委托缺失、已撤销或已变化",403);
  for(const ref of g.observed_versions) {
    const item=[...s.registry().tasks,...s.registry().habits,...s.registry().plans,...s.registry().proposals,...s.registry().user_rules??[]].find(x=>x.id===ref.id);
    if(!item || item.version!==ref.version)throw new AppError("VERSION_CONFLICT","后台相关对象已变化",409);
  }
  return g;
}
export function checkBackgroundActions(s:Store,inputId:string,actions:Action[]) {
  const g=checkGrant(s,inputId),f=s.registry().followups!.find(f=>f.id===g.work_id)!;
  for(const a of actions) {
    if(a.type==="save_work" && g.capabilities.includes("manage_work") && a.target_id===g.work_id) {
      const w=a.work as any;
      if(!w || w.key!==f.work!.key || w.refs?.some((r:any)=>r.id?!g.object_ids.includes(r.id):!g.paths.includes(r.path)))
        throw new AppError("BACKGROUND_SCOPE","不能通过工作更新扩大委托",403);
      if(w.done_when && canonicalJson(w.done_when)!==canonicalJson(f.work!.done_when))
        throw new AppError("BACKGROUND_SCOPE","后台交接不能自行降低或替换已接受的完成条件",403);
    } else if(a.type==="configure_task" && g.capabilities.includes("prepare_next_action") && g.object_ids.includes(String(a.target_id)) &&
      a.planning && Object.keys(a.planning as object).every(k=>k==="next_action")) {
      // A draft next action does not change the accepted outcome, estimate, deadline or schedule.
    } else throw new AppError("BACKGROUND_SCOPE","此动作超出当前步骤的能力范围",403);
  }
  return g;
}
export function checkBackgroundFile(s:Store,inputId:string,operation:string,path?:string) {
  const g=checkGrant(s,inputId);
  if(!path || !g.paths.includes(path) ||
    (operation==="read" ? !g.capabilities.includes("read_related") :
      !["write","edit"].includes(operation) || !g.capabilities.includes("write_named_artifact") || !g.write_paths.includes(path)))
    throw new AppError("BACKGROUND_SCOPE","后台文件访问不在明确路径与操作范围内",403);
  return g;
}
/** Called in the writer after a successful commit validated against this same grant. */
export function advanceOwnGrant(s:Store,inputId:string,ids:string[]) {
  const row=s.db.prepare("SELECT metadata_json FROM inbox WHERE id=?").get(inputId) as any;
  const g:BackgroundGrant|undefined=row?JSON.parse(row.metadata_json).background_grant:undefined;
  if(!g)return;
  const r=s.registry(),items=[...r.tasks,...r.habits,...r.plans,...r.proposals,...r.user_rules??[]];
  g.observed_versions=g.observed_versions.map(ref=>ids.includes(ref.id)?{...ref,version:items.find(x=>x.id===ref.id)?.version??ref.version}:ref);
  s.db.prepare("UPDATE inbox SET metadata_json=json_set(metadata_json,'$.background_grant',json(?)) WHERE id=?").run(JSON.stringify(g),inputId);
}
