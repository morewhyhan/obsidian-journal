import { afterEach, expect, it } from "vitest";
import { harness, taskAction } from "./helpers.js";
import { businessCall } from "../apps/core/agent-runtime.js";
import { applicationCall } from "../apps/core/application.js";
import { workspaceCall } from "../apps/core/workspace.js";
import { Scheduler } from "../apps/core/scheduler.js";
import { atomicWrite } from "../apps/core/files.js";
import type { Action, Input } from "../packages/contracts/types.js";
const roots: ReturnType<typeof harness>[] = [];
afterEach(async () => { for (const h of roots.splice(0)) { await h.core.stop(); await h.close(); } });
const reply = (text: string) => ({action_groups:[], clarification:null, reply_intent:"discussion", discussion:text});
function setup() { const h = harness("2026-10-26T08:00:00Z"); roots.push(h); return h; }
function task(n: number) { return {...structuredClone(taskAction),title:"事项"+n,outcome:"完成事项"+n,due_at:"2026-10-29T10:00:00Z"}; }
async function turn(h: ReturnType<typeof harness>, text: string) {
  const input = h.input(text); await h.core.receive(input);
  await expect.poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id)).toMatchObject({status:"processed"});
  return input;
}
function use(h: ReturnType<typeof harness>, run: (input: Input, context: any) => Promise<any>) {
  h.core.agent = {executionMode:"tools-v2",interpret:run};
}
async function seed(h: ReturnType<typeof harness>, single = false) {
  use(h, async input => {
    await businessCall(h.core, {input_id:input.id,call_id:"offer",operation:"save_proposals",summary:"四项当前草案",
      action_groups: single ? [{action_identity:"all",actions:[1,2,3,4].map(task)}]
        : [1,2,3,4].map(n=>({action_identity:"item"+n,actions:[task(n)]}))});
    return reply("四项草案先保留，等你决定。");
  });
  await turn(h,"先帮我准备四项建议，暂时不执行。");
  expect(h.store.registry().tasks).toHaveLength(0);
}

for (const phrase of ["确定","确认","这四个都确定","可以了，写进去。","OK，就这样做","按这四项执行"]) {
  it("native batch decision uses model context and actually applies all four: "+phrase, async () => {
    const h=setup(); await seed(h); let called=0;
    use(h,async(input,context)=>{
      called++; expect(h.store.registry().tasks).toHaveLength(0);
      expect(context.input_mode).toBe("autonomous_tools");
      const output=await businessCall(h.core,{input_id:input.id,call_id:"accept",operation:"resolve_proposals",
        decisions:context.proposals.map((p:any)=>({target_id:p.id,expected_version:p.version,decision:"accept"}))});
      expect(output.results.every((r:any)=>r.status==="applied")).toBe(true);
      return reply("四件事都安排好了。");
    });
    const input=await turn(h,phrase);
    expect(called).toBe(1); expect(h.store.registry().tasks.map(t=>t.title)).toEqual([1,2,3,4].map(n=>"事项"+n));
    expect(h.store.registry().proposals.every(p=>p.status==="accepted")).toBe(true);
    const meta=JSON.parse((h.store.db.prepare("SELECT metadata_json FROM inbox WHERE id=?").get(input.id) as any).metadata_json);
    expect(meta.reply).toBe("四件事都安排好了。"); expect(meta.reply_origin).toBe("llm");
  });
}
it("negative and excluded decisions cannot be executed before the model reads them",async()=>{
  const h=setup();await seed(h);
  use(h,async input=>{expect(h.store.registry().tasks).toHaveLength(0);return reply("先保留，不落实。");});
  await turn(h,"全部先不确认");expect(h.store.registry().tasks).toHaveLength(0);
  use(h,async(input,ctx)=>{
    await businessCall(h.core,{input_id:input.id,call_id:"except",operation:"resolve_proposals",
      decisions:ctx.proposals.filter((_:any,i:number)=>i!==1).map((p:any)=>({target_id:p.id,expected_version:p.version,decision:"accept"}))});
    return reply("第二项先留着，其他三项已经安排。");
  });
  await turn(h,"除了第二个，其余全部确认");
  expect(h.store.registry().tasks.map(t=>t.title)).toEqual(["事项1","事项3","事项4"]);
  expect(h.store.registry().proposals.filter(p=>p.status==="pending")).toHaveLength(1);
});
it("amendment and acceptance commit the same version, not the original deadline",async()=>{
  const h=setup();await seed(h);
  use(h,async(input,ctx)=>{
    const decisions=ctx.proposals.map((p:any,i:number)=>({target_id:p.id,expected_version:p.version,decision:"accept" as const,
      ...(i===1?{replacements:[{...p.actions[0],due_at:"2026-10-27T10:00:00Z"}]}:{})}));
    await businessCall(h.core,{input_id:input.id,call_id:"amend",operation:"resolve_proposals",decisions});
    return reply("第二项截止改为明天18点，四项已落实。");
  });
  await turn(h,"全部确认，不过第二项截止改为明天18点");
  expect(h.store.registry().tasks).toHaveLength(4);
  expect(h.store.registry().tasks.find(t=>t.title==="事项2")!.due_at).toBe("2026-10-27T10:00:00.000Z");
  expect(h.store.registry().proposals[1].actions[0].due_at).toBe("2026-10-27T10:00:00Z");
});
it("one aggregate proposal supports selective acceptance without duplicating pending proposals",async()=>{
  const h=setup();await seed(h,true);
  use(h,async(input,ctx)=>{
    const p=ctx.proposals[0];await businessCall(h.core,{input_id:input.id,call_id:"partial",operation:"resolve_proposals",
      decisions:[{target_id:p.id,expected_version:p.version,decision:"accept",action_indices:[0,2]}]});
    return reply("第一和第三件已安排，剩下两件保留。");
  });
  await turn(h,"第一和第三件确定");
  expect(h.store.registry().tasks.map(t=>t.title)).toEqual(["事项1","事项3"]);
  expect(h.store.registry().proposals).toHaveLength(1);
  expect(h.store.registry().proposals[0].actions.map(a=>a.title)).toEqual(["事项2","事项4"]);
});
it("rejecting one item inside a combined proposal preserves the other items",async()=>{
  const h=setup();await seed(h,true);
  use(h,async(input,ctx)=>{const p=ctx.proposals[0];await businessCall(h.core,{input_id:input.id,call_id:"reject-part",operation:"resolve_proposals",
    decisions:[{target_id:p.id,expected_version:p.version,decision:"reject",action_indices:[1]}]});return reply("第二件放下，其余三件保留。");});
  await turn(h,"第二件不要了，其他先留着");
  expect(h.store.registry().tasks).toHaveLength(0);
  expect(h.store.registry().proposals[0].actions.map(a=>a.title)).toEqual(["事项1","事项3","事项4"]);
  expect(h.store.registry().proposals[0].status).toBe("pending");
});
it("independent failure returns to the same loop for correction without replaying success",async()=>{
  const h=setup();
  use(h,async input=>{
    const one=await businessCall(h.core,{input_id:input.id,call_id:"first",operation:"apply_changes",action_groups:[
      {action_identity:"one",actions:[task(1)]},{action_identity:"two",actions:[{...task(2),acceptance:[]}]}]});
    expect(one.results.map((r:any)=>r.status)).toEqual(["applied","rejected"]);
    expect(one.results[1].error.code).toBe("INVALID_ACCEPTANCE");
    expect(h.store.registry().tasks).toHaveLength(1);
    const two=await businessCall(h.core,{input_id:input.id,call_id:"correct",operation:"apply_changes",action_groups:[{action_identity:"two-fixed",actions:[task(2)]}]});
    expect(two.results[0].status).toBe("applied");
    const retry=await businessCall(h.core,{input_id:input.id,call_id:"correct",operation:"apply_changes",action_groups:[{action_identity:"two-fixed",actions:[task(2)]}]});
    expect(retry).toEqual(two);return reply("两件事都已保存。");
  });
  await turn(h,"这两件都办一下。");expect(h.store.registry().tasks).toHaveLength(2);
});
it("accepted current-day work creates its template diary and parents without a second model tool call",async()=>{
  const h=setup();
  use(h,async input=>{await businessCall(h.core,{input_id:input.id,call_id:"today",operation:"apply_changes",action_groups:[{
    action_identity:"today",actions:[{...task(1),initial_plan:{kind:"fixed",window_start:"2026-10-26T08:00:00Z",window_end:"2026-10-26T09:00:00Z",duration_minutes:60,next_action:"先打开资料A"}}]}]});return reply("今天的安排已经写进日记。");});
  await turn(h,"今天这一个小时按刚才说的办。");
  const daily=h.store.files.list().find(p=>p.endsWith('2026-10-26.md'));
  expect(daily).toBeTruthy();expect(h.store.files.read(daily!)).toContain('先打开资料A');
  expect(h.store.files.list().some(p=>p.endsWith('年度计划.md'))).toBe(true);
  expect(h.store.registry().tasks).toHaveLength(1);expect(h.store.registry().diary_links.length).toBeGreaterThan(0);
});
it("editing an old task does not backfill template diaries for its historical time blocks",async()=>{
  const h=setup();await h.run({...task(1),initial_plan:{kind:"fixed",window_start:"2026-10-26T08:00:00Z",window_end:"2026-10-26T09:00:00Z",duration_minutes:60,next_action:"旧步骤"}});
  h.setTime("2026-10-29T08:00:00Z");
  use(h,async(input,ctx)=>{const t=ctx.items[0];await businessCall(h.core,{input_id:input.id,call_id:"next",operation:"apply_changes",
    action_groups:[{action_identity:"next",actions:[{type:"configure_task",target_id:t.id,expected_version:t.version,planning:{next_action:"新的下一步"}}]}]});return reply("下一步已更新。");});
  await turn(h,"把下一步按刚才那样改好。");
  expect(h.store.files.list().some(p=>p.endsWith('2026-10-26.md'))).toBe(false);
});
it("a saved rule cannot hide diary failure in the same committed task group",async()=>{
  const h=setup();atomicWrite(h.store.files.resolve("Template/日记模版.md"),"<% unsupported() %>");
  use(h,async input=>{
    const result=await businessCall(h.core,{input_id:input.id,call_id:"rule-and-task",operation:"apply_changes",action_groups:[{
      action_identity:"rule-and-task",actions:[
        {type:"set_personal_rule",key:"working.english_first",value:{instruction:"英语先复习旧词",task_ids:[],categories:["英语"],purpose:"all"},expected_rules_revision:0},
        {...task(1),initial_plan:{kind:"fixed",window_start:"2026-10-26T08:00:00Z",window_end:"2026-10-26T09:00:00Z",duration_minutes:60,next_action:"先复习旧词"}}
      ]}]});
    expect(result.results[0].status).toBe("applied");
    expect(result.results[0].effects).toContain("模板笔记创建或绑定尚未成功");
    return reply("原则和任务已保存，日记模板有错误，还没能写进日记。");
  });
  await turn(h,"把这个原则记住，今天这项任务也按刚才的安排办。");
  expect(h.store.registry().tasks).toHaveLength(1);
  expect(h.store.registry().user_rules?.some(r=>r.enabled)).toBe(true);
  expect(h.store.files.list().some(p=>p.endsWith('2026-10-26.md'))).toBe(false);
});
it("combined explanation, local negation and interrogative task titles do not trigger global read-only gates",async()=>{
  const h=setup();
  use(h,async input=>{await businessCall(h.core,{input_id:input.id,call_id:"create",operation:"apply_changes",
    action_groups:[{action_identity:"new",actions:[task(1)]}]});return reply("区别已经说清楚，任务也记下了。");});
  await turn(h,"先解释任务和习惯有什么区别，再创建任务：确认报告是否已提交，不需要额外提醒。");
  expect(h.store.registry().tasks).toHaveLength(1);expect(h.store.registry().proposals).toHaveLength(0);
});
it("native tools can search full prior dialogue and edit an implicit note request without magic verbs",async()=>{
  const h=setup();atomicWrite(h.store.files.resolve("03. Manual/test.md"),"旧段落");
  use(h,async()=>reply("当前草案：三件事，第二件下午三点，最后一件待定。"));
  await turn(h,"先讨论一下");
  use(h,async input=>{
    const extra={} as any;
    const past:any=await applicationCall(h.core,{input_id:input.id,call_id:"history",operation:"conversation"},extra);
    expect(past.items[0].reply).toContain("第二件下午三点");
    const note:any=await workspaceCall(h.core,{input_id:input.id,call_id:"read",operation:"read",path:"03. Manual/test.md"});
    await workspaceCall(h.core,{input_id:input.id,call_id:"edit",operation:"edit",path:"03. Manual/test.md",base_hash:note.hash,old_text:"旧段落",new_text:"新版段落"});
    return reply("那一段已换成新版。");
  });
  await turn(h,"就用刚才那个新版吧。");expect(h.store.files.read("03. Manual/test.md")).toBe("新版段落");
});
it("domain permission and version boundaries still reject bad native tools",async()=>{
  const h=setup();
  use(h,async input=>{
    const r=await businessCall(h.core,{input_id:input.id,call_id:"bad",operation:"apply_changes",
      action_groups:[{action_identity:"guess",actions:[{type:"cancel_item",target_id:"invented",expected_version:1}]}]});
    expect(r.results[0].error.code).toBe("VERSION_CONFLICT");
    await expect(workspaceCall(h.core,{input_id:input.id,call_id:"escape",operation:"read",path:"../private.md"})).rejects.toThrow();
    return reply("这个对象和路径都无法访问，未执行。");
  });await turn(h,"处理一下");expect(h.store.registry().tasks).toHaveLength(0);
});
it("model failure after a real write never sends a canned reply or loses the write",async()=>{
  const h=setup();
  use(h,async input=>{await businessCall(h.core,{input_id:input.id,call_id:"once",operation:"apply_changes",action_groups:[{action_identity:"new",actions:[task(1)]}]});throw new Error("MODEL_OFFLINE");});
  const input={...h.input("办一下这件事"),channel:"qq"};await h.core.receive(input);
  await expect.poll(()=>h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id)).toMatchObject({status:"failed"});
  expect(h.store.registry().tasks).toHaveLength(1);
  expect(h.store.db.prepare("SELECT count(*) n FROM outbox").get()).toEqual({n:0});
});
it("native reminder text comes from the LLM rather than canned scheduler prose",async()=>{
  const h=setup();await h.run({...task(1),initial_plan:{kind:"fixed",window_start:"2026-10-26T08:00:00Z",window_end:"2026-10-26T09:00:00Z",duration_minutes:60,next_action:"打开资料A"}});
  const sent:string[]=[];const channel={health:()=>({connected:true,lastEventAt:null}),send:async(m:any)=>{sent.push(m.body);return{status:"sent" as const,externalId:"sent"};}};
  h.core.agent={executionMode:"tools-v2",interpret:async()=>reply(""),compose:async()=>({text:"资料A接着上次的位置，先写第一段。"})};
  const scheduler=new Scheduler(h.core,channel,"user");await scheduler.tick();expect(sent).toEqual(["资料A接着上次的位置，先写第一段。"]);
  scheduler.close();
});
it("a pause or completion while reminder language is being generated prevents stale delivery",async()=>{
  const h=setup();await h.run({...task(1),initial_plan:{kind:"fixed",window_start:"2026-10-26T08:00:00Z",window_end:"2026-10-26T09:00:00Z",duration_minutes:60,next_action:"打开资料A"}});
  let sent=0;const channel={health:()=>({connected:true,lastEventAt:null}),send:async()=>{sent++;return{status:"sent" as const,externalId:"sent"};}};
  h.core.agent={executionMode:"tools-v2",interpret:async()=>reply(""),compose:async()=>{
    await h.run({type:"pause_contact"});return{text:"这条旧提醒不应发送。"};}};
  const scheduler=new Scheduler(h.core,channel,"user");await scheduler.tick();scheduler.close();expect(sent).toBe(0);
});
it("queued legacy reminders cannot bypass failed LLM generation after an upgrade",async()=>{
  const h=setup();await h.run({...task(1),initial_plan:{kind:"fixed",window_start:"2026-10-26T08:00:00Z",window_end:"2026-10-26T09:00:00Z",duration_minutes:60,next_action:"打开资料A"}});
  const offline=new Scheduler(h.core,{health:()=>({connected:false,lastEventAt:null}),send:async()=>({status:"failed",reason:"offline"})},"user");
  await offline.tick();offline.close();expect(h.store.db.prepare("SELECT count(*) n FROM outbox WHERE status='pending'").get()).toEqual({n:1});
  let sent=0;const channel={health:()=>({connected:true,lastEventAt:null}),send:async()=>{sent++;return{status:"sent" as const,externalId:"sent"};}};
  h.core.agent={executionMode:"tools-v2",interpret:async()=>reply(""),compose:async()=>{throw new Error("offline");}};
  const scheduler=new Scheduler(h.core,channel,"user");await scheduler.tick();scheduler.close();expect(sent).toBe(0);
});
it("restart composes a real recovery explanation without replaying business or sending a static receipt",async()=>{
  const h=setup();let inputId="";
  use(h,async input=>{inputId=input.id;await businessCall(h.core,{input_id:input.id,call_id:"create",operation:"apply_changes",
    action_groups:[{action_identity:"new",actions:[task(1)]}]});return reply("已经保存。");});
  await turn(h,"这件事办一下");
  await h.core.stop();h.store.db.prepare("UPDATE inbox SET status='processing' WHERE id=?").run(inputId);
  await h.restart();
  let interpreted=0,composed=0;
  h.core.agent={executionMode:"tools-v2",interpret:async()=>{interpreted++;return reply("不应重跑");},compose:async facts=>{
    composed++;expect((facts as any).effects.applied.length).toBeGreaterThan(0);return{text:"上次任务已经保存，中断没有重复办理。"};}};
  await h.core.processPending();expect(interpreted).toBe(0);expect(composed).toBe(1);
  expect(h.store.registry().tasks).toHaveLength(1);
  const meta=JSON.parse((h.store.db.prepare("SELECT metadata_json FROM inbox WHERE id=?").get(inputId) as any).metadata_json);
  expect(meta.recovered_without_replay).toBe(true);expect(meta.reply_origin).toBe("llm");
});
it("a newer user correction prevents an older in-flight request from committing",async()=>{
  const h=setup();let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  use(h,async input=>{
    if(input.text==="先排旧版"){
      await gate;
      await expect(businessCall(h.core,{input_id:input.id,call_id:"stale",operation:"apply_changes",
        action_groups:[{action_identity:"old",actions:[task(1)]}]})).rejects.toMatchObject({code:"NEWER_INPUT_PENDING"});
      return reply("旧版未执行。");
    }
    return reply("按刚才的新要求保留草案，先不执行。");
  });
  const first=h.input("先排旧版");await h.core.receive(first);
  const second=h.input("刚才那个先别执行");await h.core.receive(second);release();
  await expect.poll(()=>h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(second.id)).toMatchObject({status:"processed"});
  expect(h.store.registry().tasks).toHaveLength(0);
});
