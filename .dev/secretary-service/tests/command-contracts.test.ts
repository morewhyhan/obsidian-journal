import fs from "node:fs";
import { afterEach, expect, it } from "vitest";
import { harness, taskAction, habitAction } from "./helpers.js";
import { businessCall, type BusinessCall } from "../apps/core/agent-runtime.js";
import { policyStamp } from "../apps/core/tool-effects.js";
import { atomicWrite } from "../apps/core/files.js";
import { AppError } from "../packages/contracts/types.js";
import { cleanup } from "../apps/core/maintenance.js";

const roots: ReturnType<typeof harness>[] = [];
afterEach(async () => {
  for (const h of roots.splice(0)) { await h.core.stop(); await h.close(); }
});
function setup() { const h = harness("2026-10-26T08:00:00Z"); roots.push(h); return h; }
function session(h: ReturnType<typeof harness>) {
  const input = h.input("按当前商定的方案办理");
  const r = h.store.registry();
  h.store.db.prepare("INSERT INTO inbox(id,channel,actor_ref,external_id,body,metadata_json,status,received_at,occurred_at) VALUES(?,?,?,?,?,?,'processing',?,?)")
    .run(input.id, input.channel, input.actor_ref, input.external_id, input.text,
      JSON.stringify({agent_execution:"tools-v2", policy_stamp:policyStamp(h.store),
        authorized_objects:[...r.tasks,...r.habits,...r.plans,...r.proposals].map(x=>({id:x.id,version:x.version}))}),
      h.store.now(), input.occurred_at);
  return input;
}
const task = (title: string) => ({...structuredClone(taskAction),title,due_at:"2026-10-29T10:00:00Z"});

it("domain modules do not depend on application or file/database/network drivers", () => {
  for (const file of fs.readdirSync("packages/domain").filter(f=>f.endsWith(".ts"))) {
    const imports = [...fs.readFileSync("packages/domain/"+file,"utf8").matchAll(/from\s+["']([^"']+)["']/g)].map(m=>m[1]);
    expect(imports.filter(p=>/apps\/|node:(fs|path|http|https)|sqlite|fastify|astrbot|napcat/.test(p)), file).toEqual([]);
  }
});

it("duplicate logical group identities are rejected before saving any proposal", async () => {
  const h=setup(), input=session(h);
  await expect(businessCall(h.core,{input_id:input.id,call_id:"duplicate",operation:"save_proposals",
    action_groups:[{action_identity:"same",actions:[task("甲")]},{action_identity:"same",actions:[task("乙")]}]}))
    .rejects.toMatchObject({code:"DUPLICATE_GROUP"});
  expect(h.store.registry().proposals).toHaveLength(0);
});

it("groups sharing a task apply from one observed version and publish together", async () => {
  const h=setup(); await h.run(task("报告"));
  const input=session(h), t=h.store.registry().tasks[0];
  const result=await businessCall(h.core,{input_id:input.id,call_id:"shared",operation:"apply_changes",action_groups:[
    {action_identity:"next",actions:[{type:"configure_task",target_id:t.id,expected_version:t.version,planning:{next_action:"打开资料"}}]},
    {action_identity:"estimate",actions:[{type:"configure_task",target_id:t.id,expected_version:t.version,planning:{remaining_minutes:35}}]},
  ]});
  expect(result.results.map((r:{status:string})=>r.status)).toEqual(["applied","applied"]);
  expect(new Set(result.results.map((r:{operation_id?:string})=>r.operation_id)).size).toBe(1);
  expect(h.store.registry().tasks[0].planning).toMatchObject({next_action:"打开资料",remaining_minutes:35});
});

it("explicit all-or-nothing leaves no task when one independent item is invalid", async () => {
  const h=setup(), input=session(h);
  const call={input_id:input.id,call_id:"atomic",operation:"apply_changes",commit_mode:"all_or_nothing",action_groups:[
    {action_identity:"good",actions:[task("甲")]},{action_identity:"bad",actions:[{...task("乙"),acceptance:[]}]},
  ]} as BusinessCall;
  const result=await businessCall(h.core,call);
  expect(result.results.every((r:{status:string})=>r.status==="rejected")).toBe(true);
  expect(h.store.registry().tasks).toHaveLength(0);
});

it("defer with replacements is an invalid decision rather than a silent success", async () => {
  const h=setup(), input=session(h);
  await expect(businessCall(h.core,{input_id:input.id,call_id:"defer",operation:"resolve_proposals",
    decisions:[{target_id:"unknown",expected_version:1,decision:"defer",replacements:[task("甲")]}]}))
    .rejects.toMatchObject({code:"INVALID_DECISION"});
  expect(h.store.registry().tasks).toHaveLength(0);
});

it("accepted amendments preserve the exact prior proposal and selected scope across restart", async () => {
  const h=setup(), input=session(h);
  const original=task("报告");
  const offered=await businessCall(h.core,{input_id:input.id,call_id:"offer",operation:"save_proposals",
    action_groups:[{action_identity:"report",actions:[original]}]});
  const p=h.store.registry().proposals.find(p=>p.id===offered.results[0].ids[0])!;
  await businessCall(h.core,{input_id:input.id,call_id:"accept",operation:"resolve_proposals",decisions:[{
    target_id:p.id,expected_version:p.version,decision:"accept",replacements:[{...original,due_at:"2026-10-28T10:00:00Z"}],
  }]});
  await h.restart();
  const decision=(h.store.registry().proposals[0] as any).decisions?.[0];
  expect(decision).toMatchObject({proposal_version:1,decision:"accept",action_indices:[0],
    original_actions:[original],applied_actions:[{...original,due_at:"2026-10-28T10:00:00Z"}]});
  expect(decision.source.input_id).toBe(input.id);
});

it("E14 a commit that cannot reach the disk is uncertain and is not duplicated on retry", async () => {
  const h=setup(), input=session(h);
  const registry=h.store.files.resolve(h.store.config.storage.registry,"internal");
  const good=fs.readFileSync(registry,"utf8");
  fs.rmSync(registry);
  fs.mkdirSync(registry); // the path is occupied: the write cannot land
  const attempt=()=>businessCall(h.core,{input_id:input.id,call_id:"disk-blocked",operation:"apply_changes",
    action_groups:[{action_identity:"report",actions:[task("报告")]}]});
  await expect(attempt()).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});
  // Nothing was reported as saved, and the file is still the blocker.
  expect(fs.statSync(registry).isDirectory()).toBe(true);
  expect(h.store.db.prepare("SELECT count(*) n FROM events WHERE kind='business'").get()).toMatchObject({n:0});
  // Restoring the path lets the same operation finish exactly once.
  fs.rmdirSync(registry);
  fs.writeFileSync(registry,good,"utf8");
  const retried=await attempt();
  expect(["applied","already_applied"]).toContain(retried.results[0].status);
  expect(h.store.registry().tasks.filter((t)=>t.title==="报告")).toHaveLength(1);
});
it("a prepared commit failure is uncertain, never reported as safely not applied", async () => {
  const h=setup(), input=session(h);
  h.store.fault=stage=>{if(stage==="prepared") throw new AppError("RECOVERY_CONFLICT","合成崩溃",409);};
  const result=await businessCall(h.core,{input_id:input.id,call_id:"crash",operation:"apply_changes",
    action_groups:[{action_identity:"report",actions:[task("报告")]}]});
  expect(result.results[0]).toMatchObject({status:"uncertain",error:{effect:"unknown"}});
  h.store.fault=undefined;h.store.recover();
  expect(h.store.registry().tasks).toHaveLength(1);
});

it("a successful task and broken diary template return independent structured outcomes", async () => {
  const h=setup(); atomicWrite(h.store.files.resolve("Template/日记模版.md"),"<% unsupported() %>");
  const input=session(h);
  const result=await businessCall(h.core,{input_id:input.id,call_id:"projection",operation:"apply_changes",action_groups:[{
    action_identity:"report",actions:[{...task("报告"),initial_plan:{kind:"fixed",window_start:"2026-10-26T08:00:00Z",
      window_end:"2026-10-26T09:00:00Z",duration_minutes:60,next_action:"先打开资料"}}],
  }]});
  expect(result.results[0]).toMatchObject({status:"applied",projection:{status:"conflict"}});
  expect(h.store.registry().tasks).toHaveLength(1);
  expect(h.store.files.list().some(p=>p.endsWith("2026-10-26.md"))).toBe(false);
});

it("different logical groups may intentionally create identical tasks and retry under a new tool call without duplication", async () => {
  const h=setup(), input=session(h);
  const action_groups=[{action_identity:"copy-a",actions:[task("同名练习")]},{action_identity:"copy-b",actions:[task("同名练习")]}];
  await businessCall(h.core,{input_id:input.id,call_id:"first",operation:"apply_changes",action_groups});
  expect(h.store.registry().tasks).toHaveLength(2);
  await businessCall(h.core,{input_id:input.id,call_id:"retry-new-id",operation:"apply_changes",action_groups});
  expect(h.store.registry().tasks).toHaveLength(2);
});

it("a batch of personal rules shares its original rules revision", async () => {
  const h=setup(), input=session(h);
  const result=await businessCall(h.core,{input_id:input.id,call_id:"rules",operation:"apply_changes",action_groups:[
    {action_identity:"style",actions:[{type:"set_personal_rule",key:"support.style",value:"direct",expected_rules_revision:0}]},
    {action_identity:"cap",actions:[{type:"set_personal_rule",key:"contact.suggestion_cap",value:2,expected_rules_revision:0}]},
  ]});
  expect(result.results.map((r:{status:string})=>r.status)).toEqual(["applied","applied"]);
  expect(h.core.assistant.view().values).toMatchObject({"support.style":"direct","contact.suggestion_cap":2});
});

it("normal reads cross the recovery barrier instead of exposing half a multi-file commit", async () => {
  const h=setup(); await h.run(habitAction);
  const date="2026-10-26";
  h.store.fault=stage=>{if(stage==="file:.agent/state/registry.json") throw new Error("power loss");};
  expect(()=>h.store.commit("two-files","fixture","fixture",(r,load)=>{
    r.habits[0].title="恢复后的标题";
    load(date).occurrences.push({id:"occurrence",habit_id:r.habits[0].id,slot_key:"default",definition_version:1,
      min_behavior_snapshot:"读一句",status:"did",quantity:null,optional_target_met:null,source:h.core.source(h.input()),
      reported_at:h.store.now(),operation_id:"fixture"});
    return {ids:[r.habits[0].id],message:"fixture"};
  })).toThrow("power loss");
  h.store.fault=undefined;
  expect(h.store.day(date).occurrences).toHaveLength(1);
  expect(h.store.registry().habits[0].title).toBe("恢复后的标题");
  expect(h.store.db.prepare("SELECT count(*) n FROM events WHERE kind='business' AND status='prepared'").get()).toEqual({n:0});
});

it("a field belonging to another action cannot be silently ignored while reporting success", async () => {
  const h=setup(), input=session(h);
  const result=await businessCall(h.core,{input_id:input.id,call_id:"wrong-field",operation:"apply_changes",action_groups:[{
    action_identity:"report",actions:[{...task("报告"),next_action:"不应被悄悄丢弃"}],
  }]});
  expect(result.results[0]).toMatchObject({status:"rejected",error:{code:"ACTION_FIELD_UNSUPPORTED",effect:"not_applied"}});
  expect(h.store.registry().tasks).toHaveLength(0);
});

it("logical retries survive splitting, merging and reordering without accepting changed intent", async () => {
  const h=setup(), input=session(h);
  const action_groups=[{action_identity:"a",actions:[task("甲")]},{action_identity:"b",actions:[task("乙")]}];
  await businessCall(h.core,{input_id:input.id,call_id:"together",operation:"apply_changes",commit_mode:"all_or_nothing",action_groups});
  await businessCall(h.core,{input_id:input.id,call_id:"split",operation:"apply_changes",action_groups:[...action_groups].reverse()});
  expect(h.store.registry().tasks.map(t=>t.title)).toEqual(["甲","乙"]);
  const changed=await businessCall(h.core,{input_id:input.id,call_id:"changed",operation:"apply_changes",action_groups:[{action_identity:"a",actions:[task("新内容")]}]});
  expect(changed.results[0]).toMatchObject({status:"rejected",error:{code:"IDEMPOTENCY_REUSED"}});
  expect(h.store.registry().tasks).toHaveLength(2);
});

it("a late task report updates the original time block rather than today's block", async () => {
  const h=setup();await h.run(task("报告"));const t=h.store.registry().tasks[0];
  await h.run({type:"schedule",target_id:t.id,window_start:"2026-10-25T08:00:00Z",window_end:"2026-10-25T09:00:00Z",duration_minutes:60,next_action:"昨日步骤"});
  await h.run({type:"schedule",target_id:t.id,window_start:"2026-10-26T08:00:00Z",window_end:"2026-10-26T09:00:00Z",duration_minutes:60,next_action:"今日步骤"});
  await h.run({type:"report_execution",target_id:t.id,execution:"started",performed_at:"2026-10-25T08:10:00Z",business_date:"2026-10-25"});
  const r=h.store.registry();
  expect(r.plans[0].execution).toBe("started");expect(r.plans[1].execution).toBe("unknown");
  expect(r.tasks[0].planning?.execution_history?.at(-1)).toMatchObject({performed_at:"2026-10-25T08:10:00.000Z",business_date:"2026-10-25",at:h.store.now()});
  expect(r.tasks[0].planning?.focus_until).toBeNull();
  await h.run({type:"complete_task",target_id:t.id,performed_at:"2026-10-25T08:30:00Z",business_date:"2026-10-25"});
  expect(h.store.registry().tasks[0].completion_time).toMatchObject({performed_at:"2026-10-25T08:30:00.000Z",business_date:"2026-10-25",reported_at:h.store.now()});
  expect(h.store.day("2026-10-25").corrections.some(x=>x.id===t.id && x.new_status==="done")).toBe(true);
});

it("unfinished work survives short-history cleanup and resumes once at its checkpoint", async () => {
  const h=setup();
  await h.run({type:"save_work",work:{key:"report-question",summary:"报告范围已谈过，等待确认素材来源",owner:"user",
    next_action:"建议先用已有案例，再确认是否需要外部素材",check_at:"2026-11-26T08:00:00Z"}});
  h.store.db.prepare("DELETE FROM inbox").run();h.store.db.prepare("DELETE FROM outbox").run();
  h.setTime("2026-11-26T07:59:00Z");cleanup(h.store);await h.restart();
  const work=h.store.registry().followups!.find(f=>f.work?.key==="report-question")!;
  expect(work.status).toBe("waiting_user");expect(work.work?.next_action).toContain("已有案例");
  let calls=0;h.core.agent={interpret:async()=>{calls++;return {action_groups:[],clarification:null,reply_intent:"discussion",discussion:"素材我建议先用已有案例，这样可以先推进。"};}};
  h.core.assistant.startPlanning();await h.core.assistant.drain();expect(calls).toBe(0);
  h.advance(61000);h.core.assistant.startPlanning();await h.core.assistant.drain();expect(calls).toBe(1);
  h.core.assistant.startPlanning();await h.core.assistant.drain();expect(calls).toBe(1);
  await h.run({type:"control_work",target_id:work.id,expected_version:h.store.registry().followups!.find(f=>f.id===work.id)!.version,control:"stop"});
  expect(h.store.registry().followups!.find(f=>f.id===work.id)!.status).toBe("resolved");
});

it("moving past a hard deadline requires explicit overdue recovery and never changes the deadline", async () => {
  const h=setup();await h.run({...task("报告"),due_at:"2026-10-27T10:00:00Z"});const t=h.store.registry().tasks[0];
  await h.run({type:"schedule",target_id:t.id,window_start:"2026-10-27T08:00:00Z",window_end:"2026-10-27T09:00:00Z",duration_minutes:60,next_action:"写报告"});
  const p=h.store.registry().plans[0], move={type:"reschedule",target_id:p.id,window_start:"2026-10-27T10:00:00Z",window_end:"2026-10-27T11:00:00Z"};
  await expect(h.run(move)).rejects.toMatchObject({code:"DEADLINE_WINDOW_CONFLICT"});
  await h.run({...move,overdue_recovery:true});
  expect(h.store.registry().tasks[0].due_at).toBe("2026-10-27T10:00:00.000Z");
  expect((h.store.registry().plans[0] as any).overdue_recovery?.input_id).toBeTruthy();
});

it("a two-block swap validates the final schedule and rolls back a genuinely overlapping batch", async () => {
  const h=setup();await h.run(task("甲"));await h.run(task("乙"));
  for (const [i,t] of h.store.registry().tasks.entries()) await h.run({type:"schedule",target_id:t.id,
    window_start:`2026-10-27T0${8+i}:00:00Z`,window_end:`2026-10-27T${i===0 ? "09":"10"}:00:00Z`,duration_minutes:60,next_action:t.title});
  const [a,b]=h.store.registry().plans,input=session(h);
  const action_groups=[{action_identity:"swap-a",actions:[{type:"reschedule",target_id:a.id,expected_version:a.version,
    window_start:b.window_start,window_end:b.window_end}]},{action_identity:"swap-b",actions:[{type:"reschedule",target_id:b.id,expected_version:b.version,
    window_start:a.window_start,window_end:a.window_end}]}];
  const receipt=await businessCall(h.core,{input_id:input.id,call_id:"swap",operation:"apply_changes",action_groups});
  expect(receipt.results.map((r:any)=>r.status)).toEqual(["applied","applied"]);
  const after=h.store.registry().plans;
  expect(after.map(p=>p.window_start)).toEqual([b.window_start,a.window_start]);
  const next=session(h), invalid=after.map((p,i)=>({action_identity:`bad-${i}`,actions:[{type:"reschedule",target_id:p.id,expected_version:p.version,
    window_start:"2026-10-27T12:00:00Z",window_end:"2026-10-27T13:00:00Z"}]}));
  const rejected=await businessCall(h.core,{input_id:next.id,call_id:"overlap",operation:"apply_changes",action_groups:invalid});
  expect(rejected.results.map((r:any)=>r.status)).toEqual(["rejected","rejected"]);
  expect(h.store.registry().plans).toEqual(after);
});
