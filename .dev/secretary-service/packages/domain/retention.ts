import type { Registry } from "../contracts/types.js";
/** Typed references, not recursive string matching or permanent transcript retention. */
export function extractRetentionRefs(r:Registry) {
  const entityIds=new Set<string>(),eventIds=new Set<string>();
  for(const f of r.followups??[]) {
    if(f.status==="resolved")continue;
    if(f.issue.task_id)entityIds.add(f.issue.task_id);
    if(f.issue.habit_id)entityIds.add(f.issue.habit_id);
    for(const ref of f.work?.refs??[])if(ref.id)entityIds.add(ref.id);
    const d=f.work?.done_when;
    if(d?.kind==="business_applied")eventIds.add(d.intent_ref);
    if(d?.kind==="decision_recorded")entityIds.add(d.proposal_id);
    for(const id of f.work?.delegation?.object_ids??[])entityIds.add(id);
  }
  for(const t of r.tasks) {
    if(["done","cancelled"].includes(t.status))continue;
    if(t.parent_task_id)entityIds.add(t.parent_task_id);
    for(const id of t.planning?.depends_on??[])entityIds.add(id);
    for(const id of t.supporting_habit_ids??[])entityIds.add(id);
  }
  return {entityIds,eventIds};
}
