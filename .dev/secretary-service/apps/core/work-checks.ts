import type { Registry, Source } from "../../packages/contracts/types.js";
import { transitionWork, referencedObject } from "../../packages/domain/work.js";
import type { Store } from "./store.js";
import { hash } from "./files.js";

/** Read actual effects. This never marks the user's Task complete. */
export function reconcileWork(store:Store,r:Registry,operation:string,source:Source,workId?:string) {
  const ids:string[]=[];
  for(const f of r.followups??[]) {
    if(workId && f.id!==workId)continue;
    const w=f.work,d=w?.done_when;
    if(!w?.step_id || !d || f.status==="resolved" || f.status==="paused")continue;
    let evidence:string[]=[];
    if(d.kind==="material_verified" || d.kind==="condition_observed" && d.checker==="note_available") {
      const p=d.kind==="material_verified"?d.path:d.ref.path;
      const ref=w.refs?.find(ref=>ref.kind==="note" && ref.path===p);
      if(ref && p)try {
        const text=store.files.read(p),actual=hash(text);
        if(text.length && (!ref.hash || ref.hash===actual) &&
          (d.kind!=="material_verified" || d.check.kind==="exists_nonempty" || d.check.terms.every(t=>text.includes(t))))
          evidence=["note:"+p+"@"+actual];
      }catch{/* Missing, changed or inaccessible material remains an unresolved gap. */}
    } else if(d.kind==="condition_observed") {
      const item=referencedObject(r,d.ref);
      if(d.ref.kind==="task" && item && "status" in item &&
        (d.checker==="dependency_done" ? item.status==="done" : ["done","cancelled"].includes(item.status)))
        evidence=["task:"+item.id+"@"+item.version];
    } else if(d.kind==="decision_recorded") {
      const p=r.proposals.find(p=>p.id===d.proposal_id);
      const decision=p?.decisions?.find(x=>x.proposal_version===d.proposal_version && x.decision!=="defer" &&
        d.action_indices.every(i=>x.action_indices.includes(i)));
      if(decision)evidence=["decision:"+p!.id+"@"+decision.proposal_version+":"+decision.operation_id];
    } else if(d.kind==="business_applied") {
      const row=store.db.prepare("SELECT payload_json FROM events WHERE id=? AND kind='business' AND status='applied'")
        .get(d.intent_ref) as {payload_json:string}|undefined;
      const data=row?JSON.parse(row.payload_json):null;
      if(data?.work_binding?.work_id===f.id && data.work_binding.step_id===w.step_id)
        evidence=["intent:"+d.intent_ref];
    }
    // user_confirmed needs a later, explicit accepted preparation decision; no inference from silence or analysis.
    if(evidence.length) {transitionWork(f,f.version,w.step_id,evidence,{now:store.now(),zone:store.config.timezone,
      source,operation,userAuthorized:true});ids.push(f.id);}
  }
  return ids;
}
