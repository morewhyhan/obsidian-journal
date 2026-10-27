import fs from "node:fs";
import path from "node:path";
import {afterEach,expect,it} from "vitest";
import {harness,taskAction} from "./helpers.js";
import {atomicWrite,hash} from "../apps/core/files.js";
import {workspaceCall} from "../apps/core/workspace.js";
import {deriveGrant,checkGrant} from "../apps/core/background-grant.js";
import {ModelBudget} from "../apps/core/model-budget.js";
import {Scheduler} from "../apps/core/scheduler.js";
import {Clock} from "../apps/core/clock.js";
import {migrateRegistry} from "../apps/core/compatibility.js";
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
function setup(){const h=harness();cleanup.push(()=>h.close());return h;}
async function rule(h:ReturnType<typeof setup>,key:string,value:unknown){await h.run({type:"set_personal_rule",key,value,expected_rules_revision:h.store.registry().rules_revision??0});}
const draft="03. Manual/prepared.md";
const work={key:"prepare",summary:"准备指定材料",owner:"assistant",next_action:"写出包含入口的准备稿",
  refs:[{kind:"note",path:draft,role:"output"}],done_when:{kind:"material_verified",path:draft,check:{kind:"contains_all",terms:["实际入口"]}}};

it("B/v2 preserves real legacy pause and terminal evidence without inventing delegation; migration is idempotent",async()=>{
  const h=setup();await h.run({type:"save_work",work});
  const r=h.store.registry(),f=r.followups![0];r.schema_version=1;
  f.status="waiting_condition";f.asked_keys=["paused"];delete f.work!.delegation;delete f.work!.step_id;
  const beforeTasks=structuredClone(r.tasks),note=path.join(h.root,"historical.md");atomicWrite(note,"PRIVATE SENTINEL");
  atomicWrite(h.store.files.resolve(h.store.config.storage.registry,"internal"),JSON.stringify(r));
  await h.restart();const migrated=h.store.registry();
  expect(migrated.schema_version).toBe(2);expect(migrated.followups![0].status).toBe("paused");
  expect(migrated.followups![0].work!.delegation).toBeUndefined();expect(migrated.tasks).toEqual(beforeTasks);
  expect(fs.readFileSync(note,"utf8")).toBe("PRIVATE SENTINEL");
  expect(migrateRegistry(migrated,h.store.now())).toEqual(migrated);
  expect(()=>migrateRegistry({...migrated,schema_version:77},h.store.now())).toThrow("未知业务版本");
});
it("I6 pause/resume retains actual waiting owner; stop is cancellation, not successful completion",async()=>{
  const h=setup();await h.run({type:"save_work",work:{...work,owner:"condition",condition:"等指定材料"}});
  const current=()=>h.store.registry().followups![0];
  await h.run({type:"control_work",target_id:current().id,expected_version:current().version,control:"pause"});
  expect(current().status).toBe("paused");
  await h.run({type:"control_work",target_id:current().id,expected_version:current().version,control:"resume"});
  expect(current().status).toBe("waiting_condition");
  await h.run({type:"control_work",target_id:current().id,expected_version:current().version,control:"stop"});
  expect(current().work!.resolution?.kind).toBe("cancelled");
  await expect(h.run({type:"control_work",target_id:current().id,expected_version:current().version,control:"resume"})).rejects.toThrow("不能");
});
it("R3/I1/I10 quiet and contact-off allow a real authorized artifact, but never complete a user task or send",async()=>{
  const h=setup();await rule(h,"contact.enabled",false);
  await h.run({...taskAction,planning:{enabled:false}});await h.run({type:"save_work",work});
  let calls=0;
  h.core.agent={executionMode:"tools-v2",interpret:async(input)=>{
    calls++;const result=await workspaceCall(h.core,{input_id:input.id,call_id:"write",operation:"write",path:draft,content:"实际入口：词表第一组"});
    expect(result).toMatchObject({written:true});
    return {action_groups:[],clarification:null,reply_intent:"discussion",discussion:"材料已准备"};
  }};
  h.core.assistant.startPlanning();await h.core.assistant.drain();
  expect(h.store.files.read(draft)).toContain("实际入口");
  const f=h.store.registry().followups!.find(f=>f.work?.key==="prepare")!;
  expect(f.status).toBe("resolved");expect(f.work!.resolution?.kind).toBe("completed");
  expect(h.store.registry().tasks[0].status).toBe("ready");
  expect(h.store.db.prepare("SELECT count(*) n FROM outbox").get()).toEqual({n:0});
  h.core.assistant.startPlanning();await h.core.assistant.drain();expect(calls).toBe(1);
});
it("E5 a revoked grant and a changed step cannot read or write, and output scope never includes input files",async()=>{
  const h=setup();atomicWrite(path.join(h.root,"input.md"),"unchanged");
  await h.run({type:"save_work",work:{...work,refs:[...work.refs,{kind:"note",path:"input.md",role:"input"}]}});
  const f=h.store.registry().followups![0],g=deriveGrant(h.store,f),input=h.input();
  h.store.db.prepare("INSERT INTO inbox(id,channel,actor_ref,external_id,body,status,metadata_json,received_at,occurred_at) VALUES(?,'coordinator','assistant',?,'job','processing',?,?,?)")
    .run(input.id,input.id,JSON.stringify({agent_execution:"tools-v2",background_grant:g,policy_stamp:g.policy_stamp}),h.store.now(),h.store.now());
  await expect(workspaceCall(h.core,{input_id:input.id,call_id:"bad",operation:"write",path:"input.md",content:"bad",base_hash:hash("unchanged")})).rejects.toThrow("范围");
  await rule(h,"assistance.enabled",false);
  expect(()=>checkGrant(h.store,input.id)).toThrow();
  await expect(workspaceCall(h.core,{input_id:input.id,call_id:"revoked",operation:"write",path:draft,content:"bad"})).rejects.toThrow();
  expect(fs.readFileSync(path.join(h.root,"input.md"),"utf8")).toBe("unchanged");expect(fs.existsSync(path.join(h.root,draft))).toBe(false);
});
it("I1/I6 a file existing without the accepted content does not finish preparation",async()=>{
  const h=setup();atomicWrite(path.join(h.root,draft),"placeholder");await h.run({type:"save_work",work});
  expect(h.store.registry().followups![0].status).toBe("open");
  await expect(h.run({type:"save_work",work:{...work,key:"injection",done_when:{kind:"eval",script:"exit()"}}})).rejects.toThrow("完成条件");
});
it("E3 reservations survive restart, missing usage consumes full allowance, and settlement is idempotent",async()=>{
  const h=setup();h.store.config.agent.budget.daily_requests=2;
  let budget=new ModelBudget(h.store);const first=budget.reserve({messages:[{content:"small"}]},100);
  const reserved=budget.status().tokens;budget.settle(first,null);budget.settle(first,{prompt_tokens:0,completion_tokens:0});
  expect(budget.status().tokens).toBe(reserved);
  const second=budget.reserve({messages:[]},100);await h.restart();budget=new ModelBudget(h.store);
  expect(budget.status().requests).toBe(2);
  expect(h.store.db.prepare("SELECT status FROM events WHERE id=?").get(second)).toEqual({status:"applied"});
  h.store.config.agent.budget.daily_requests=2;
  expect(()=>budget.reserve({},10)).toThrow("额度");
});
it("E1 slow LLM preparation does not block a due literal reminder",async()=>{
  const h=setup();await h.run({...taskAction,initial_plan:{kind:"window",window_start:h.store.now(),window_end:"2026-10-23T13:00:00Z",duration_minutes:60,next_action:"打开资料"}});
  await h.run({type:"create_automation",title:"Hello",kind:"one_shot",delay_seconds:30,body:"Hello",strict:true});h.advance(30000);
  await h.core.assistant.tick();
  let release!:(x:{text:string})=>void;
  h.core.agent={executionMode:"tools-v2",interpret:async()=>({action_groups:[],clarification:null,reply_intent:"discussion",discussion:""}),
    compose:()=>new Promise(resolve=>{release=resolve;})};
  const sent:string[]=[],scheduler=new Scheduler(h.core,{health:()=>({connected:true,lastEventAt:null}),send:async m=>{sent.push(m.body);return {status:"sent",externalId:"m"};}},"user");
  const started=performance.now();await scheduler.tick();
  expect(performance.now()-started).toBeLessThan(1000);expect(sent).toEqual(["Hello"]);
  scheduler.close();release({text:"过期文案"});await scheduler.drain(true);
});
it("E7 a discontinuous wall clock remains untrusted until explicitly reverified",()=>{
  let wall=0,mono=0;const clock=new Clock(()=>new Date(wall),()=>mono);
  expect(clock.read().trusted).toBe(true);wall+=60000;mono+=1000;
  expect(clock.read()).toMatchObject({trusted:false,reason:"CLOCK_DISCONTINUITY"});
  wall+=1000;mono+=1000;expect(clock.read().trusted).toBe(false);
  clock.verifySynchronized(true);expect(clock.read().trusted).toBe(true);
});
