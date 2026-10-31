import type { Registry, Source } from "../../packages/contracts/types.js";
import { transitionWork, referencedObject } from "../../packages/domain/work.js";
import type { Store } from "./store.js";
import { hash } from "./files.js";

/**
 * matching_feedback wakes declared work when the user reports on that reference.
 * Only an action that names the reference counts; nearby chatter does not.
 */
export function wakeOnFeedback(r:Registry,actions:{type:string;target_id?:string}[],now:string,operation:string) {
  const touched=new Set(actions.filter(a=>a.target_id).map(a=>a.target_id!));
  const ids:string[]=[];
  if(!touched.size)return ids;
  for(const f of r.followups??[]) {
    const w=f.work;
    if(!w?.wake_on?.length || f.status==="resolved" || f.status==="paused")continue;
    const hit=w.wake_on.filter(wake=>wake.kind==="matching_feedback" && wake.ref.id && touched.has(wake.ref.id));
    if(!hit.length)continue;
    f.version++;f.updated_at=now;f.last_operation_id=operation;f.next_check_at=now;
    f.work={...w,last_wake:{at:now,evidence:hit.map(wake=>"feedback:"+wake.ref.id)}};
    ids.push(f.id);
  }
  return ids;
}

/** Read actual effects. This never marks the user's Task complete. */
export function reconcileWork(store:Store,r:Registry,operation:string,source:Source,workId?:string) {
  const ids:string[]=[];
  // Declared wake conditions are checked in the same place as completion: a changed
  // reference makes the waiting work due again instead of waiting forever.
  for(const f of r.followups??[]) {
    const w=f.work;
    if(!w?.wake_on?.length || !w.wake_versions || f.status==="resolved" || f.status==="paused")continue;
    const now:string[]=[];
    const next={...(w.wake_versions)};
    for(const wake of w.wake_on) {
      // Only ref_changed compares versions; matching_feedback waits for a report.
      if(wake.kind!=="ref_changed")continue;
      const item=referencedObject(r,wake.ref) as {id?:string;version?:number}|undefined;
      const key=wake.ref.id ?? wake.ref.path;
      if(!key)continue;
      if(!item) { if(next[key]!==undefined){delete next[key];now.push("gone:"+key);} continue; }
      if(next[key]!==item.version) { next[key]=item.version as number; now.push("changed:"+key+"@"+item.version); }
    }
    w.wake_versions=next;
    if(now.length) {
      f.version++;f.updated_at=store.now();f.last_operation_id=operation;
      f.next_check_at=store.now();
      f.work={...w,last_wake:{at:store.now(),evidence:now.slice(0,8)}};
      ids.push(f.id);
    }
  }
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
    // A finished project closes the preparation it owned: leaving it open would
    // keep chasing work for something the user has already closed out.
    if(!evidence.length) {
      const finished=(w.refs??[]).filter(ref=>ref.kind==="task" && ref.role!=="input")
        .map(ref=>referencedObject(r,ref) as {id?:string;status?:string;version?:number}|undefined)
        .filter((item):item is {id:string;status:string;version:number}=>!!item && ["done","cancelled"].includes(String(item.status)));
      if(finished.length) {
        transitionWork(f,f.version,w.step_id,finished.map(item=>"task_finished:"+item.id),{now:store.now(),
          zone:store.config.timezone,source,operation,userAuthorized:true},"cancelled");
        ids.push(f.id);
        continue;
      }
    }
    // user_confirmed needs a later, explicit accepted preparation decision; no inference from silence or analysis.
    if(evidence.length) {transitionWork(f,f.version,w.step_id,evidence,{now:store.now(),zone:store.config.timezone,
      source,operation,userAuthorized:true});ids.push(f.id);}
  }
  return ids;
}
