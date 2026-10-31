import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {afterEach,it,expect,vi} from "vitest";
import {harness,taskAction,temporary,removeTemporary} from "./helpers.js";
import {AppError} from "../packages/contracts/types.js";
import {atomicWrite,hash} from "../apps/core/files.js";
import {Store,restoreData} from "../apps/core/store.js";
import {loadConfig} from "../apps/core/config.js";
import {SnapshotBackup,decryptBackup} from "../apps/core/snapshot-backup.js";
import {effectivePolicy} from "../apps/core/policy.js";
import {recordQuery,checkReads} from "../apps/core/read-stamps.js";
import {beginModelJob,endModelJob,modelDeadline} from "../apps/core/model-job.js";
import {ModelBudget,approveRecoveryBudget} from "../apps/core/model-budget.js";
import {nativeSession,businessCall} from "../apps/core/agent-runtime.js";
import {workspaceCall} from "../apps/core/workspace.js";
import {recoveryInventory,releaseRecovery} from "../apps/core/recovery-control.js";
import {runDelegatedWork} from "../apps/core/work-runner.js";
import {loadRuntimeCombination} from "../apps/core/compatibility-runtime.js";
import {RuntimeLog} from "../apps/core/log.js";
import {deriveGrant,checkBackgroundActions,checkGrant} from "../apps/core/background-grant.js";

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();vi.unstubAllEnvs();});
const setup=()=>{const h=harness();cleanups.push(()=>h.close());return h;};
it("D24 batched search keeps file checks and never reuses path authorization across calls",()=>{
  const h=setup();atomicWrite(path.join(h.root,"03. Manual/a.md"),"needle");
  expect(h.store.files.search(["03. Manual/a.md"],"needle")).toHaveLength(1);
  fs.linkSync(path.join(h.root,"03. Manual/a.md"),path.join(h.root,"03. Manual/alias.md"));
  expect(()=>h.store.files.search(["03. Manual/a.md"],"needle")).toThrow("普通文件");
  expect(()=>h.store.files.search(["../private.md"],"needle")).toThrow("路径");
  expect(()=>h.store.files.search([".agent/config.md"],"needle")).toThrow("隐藏");
});
it("D05 changed user scope replaces stale delegation; background handoff cannot weaken accepted completion",async()=>{
  const h=setup(),draft="03. Manual/first.md",second="03. Manual/second.md";
  const work={key:"scope",summary:"准备材料",owner:"assistant",next_action:"写出事实",
    refs:[{kind:"note",path:draft,role:"output"}],done_when:{kind:"material_verified",path:draft,check:{kind:"contains_all",terms:["事实"]}}};
  await h.run({type:"save_work",work});const first=h.store.registry().followups![0],grant=deriveGrant(h.store,first),input=active(h);
  h.store.db.prepare("UPDATE inbox SET channel='coordinator',metadata_json=json_set(metadata_json,'$.background_grant',json(?)) WHERE id=?").run(JSON.stringify(grant),input.id);
  expect(()=>checkBackgroundActions(h.store,input.id,[{type:"save_work",target_id:first.id,work:{...work,done_when:{kind:"material_verified",path:draft,check:{kind:"exists_nonempty"}}}}])).toThrow("完成条件");
  await h.run({type:"save_work",target_id:first.id,expected_version:first.version,work:{...work,refs:[{kind:"note",path:second,role:"output"}],
    done_when:{kind:"user_confirmed",path:second}}});
  const next=h.store.registry().followups![0];expect(next.work!.step_id).not.toBe(first.work!.step_id);
  expect(next.work!.delegation!.write_paths).toEqual([second]);expect(next.work!.delegation!.capabilities).toContain("write_named_artifact");
  expect(()=>checkGrant(h.store,input.id)).toThrow();
});
it("D02 production requires real clock attestation while an explicitly injected test clock remains deterministic",async()=>{
  vi.stubEnv("NODE_ENV","production");vi.stubEnv("SECRETARY_TIME_SYNCHRONIZED","0");
  const h=setup();expect(h.store.time.read().trusted).toBe(true);
  const root=temporary(),store=new Store(root,loadConfig(root));
  cleanups.push(async()=>{await store.close();removeTemporary(root);});
  expect(store.time.read()).toMatchObject({trusted:false,reason:"TIME_SYNC_UNVERIFIED"});
  store.time.verifySynchronized(true);expect(store.time.read().trusted).toBe(true);
});
function active(h:ReturnType<typeof setup>){const input=h.input();h.store.db.prepare("INSERT INTO inbox(id,channel,actor_ref,external_id,body,status,metadata_json,received_at,occurred_at) VALUES(?,'web','user',?,?,'processing',?,?,?)")
  .run(input.id,input.external_id,input.text,JSON.stringify({agent_execution:"tools-v2",policy_stamp:effectivePolicy(h.store).policy_stamp}),h.store.now(),h.store.now());return input;}

it("E8 encrypted snapshot restores exact files and five empty operational tables under a persistent guard",async()=>{
  const h=setup(),outside=temporary(),target=temporary();cleanups.push(async()=>{removeTemporary(outside);removeTemporary(target);});
  const key=crypto.randomBytes(32),keyFile=path.join(outside,"key");atomicWrite(keyFile,key);
  atomicWrite(path.join(h.root,"note.md"),"PRIVATE-SENTINEL\r\n原文");await h.run(taskAction);
  h.store.config.planning.evening_time="20:00";
  const backup=new SnapshotBackup(h.store,path.join(outside,"backups"),keyFile);await backup.tick(true);
  expect(backup.status.state).toBe("saved");
  const encoded=fs.readFileSync(path.join(outside,"backups",backup.status.file!),"utf8");expect(encoded).not.toContain("PRIVATE-SENTINEL");
  const pack=JSON.parse(encoded),decoded=decryptBackup(pack,key);
  restoreData(target,decoded);
  const restored=new Store(target,loadConfig(target),()=>h.store.clock());
  try {
    expect(restored.files.read("note.md")).toBe("PRIVATE-SENTINEL\r\n原文");expect(restored.registry().tasks).toEqual(h.store.registry().tasks);
    expect(restored.config.planning.evening_time).toBe("20:00");
    expect(
      (restored.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map((t) => t.name),
    ).toEqual(["documents", "events", "fact_usage", "inbox", "outbox", "revocations", "schema_meta"]);
    // A restored runtime starts with no revocation history of its own.
    expect(restored.db.prepare("SELECT count(*) n FROM revocations").get()).toEqual({ n: 0 });
    expect(restored.db.prepare("SELECT count(*) n FROM inbox").get()).toEqual({n:0});
    expect(effectivePolicy(restored).capabilities).toMatchObject({background_write:false,contact:false});
    pack.tag=Buffer.alloc(16).toString("base64");expect(()=>decryptBackup(pack,key)).toThrow("认证");
  }finally{await restored.close();}
});
it("E8 a bad recovery package leaves an empty target and never publishes partial data",()=>{
  const h=setup(),target=temporary();cleanups.push(async()=>removeTemporary(target));
  atomicWrite(path.join(h.root,"note.md"),"kept");const data=h.store.exportData();data.files[0].hash=hash("tampered");
  expect(()=>restoreData(target,data)).toThrow();expect(fs.readdirSync(target)).toEqual([]);
  expect(h.store.files.read("note.md")).toBe("kept");
});
it("D10 empty collection reads detect matching phantoms while unrelated objects remain writable",async()=>{
  const h=setup(),input=active(h),q={operation:"state",scope:"tasks",query:"target-A"};
  recordQuery(h.store,input.id,q,h.store.registry());
  await h.run({...taskAction,title:"unrelated-B"});expect(()=>checkReads(h.store,input.id)).not.toThrow();
  await h.run({...taskAction,title:"target-A"});expect(()=>checkReads(h.store,input.id)).toThrow("读取");
  expect(()=>recordQuery(h.store,input.id,{...q,offset:20},h.store.registry())).toThrow("分页");
  recordQuery(h.store,input.id,q,h.store.registry());expect(()=>checkReads(h.store,input.id)).not.toThrow();
});
it("E3/E4 physical model calls share a job cap and late tools lose authority when the job ends",()=>{
  const h=setup(),input=active(h),job=beginModelJob(h.store,input.id,"front"),budget=new ModelBudget(h.store);
  expect(modelDeadline(h.store)).toBeLessThanOrEqual(120000);
  for(let i=0;i<12;i++){const r=budget.reserve({messages:[]},10,job.id);budget.settle(r,{prompt_tokens:2,completion_tokens:1});}
  expect(()=>budget.reserve({},10,job.id)).toThrow("作业模型调用");
  endModelJob(h.store,job.id);expect(()=>nativeSession(h.core,input.id,true)).toThrow("执行权");
});
it("I6 accepting a named, unchanged preparation closes only the assistant responsibility",async()=>{
  const h=setup(),file="03. Manual/result.md";atomicWrite(path.join(h.root,file),"用户已审阅的具体结果");await h.run(taskAction);
  await h.run({type:"save_work",work:{key:"review",summary:"准备稿等接受",owner:"user",next_action:"核对这份准备稿",
    refs:[{kind:"note",path:file,role:"output",hash:hash(h.store.files.read(file))}],done_when:{kind:"user_confirmed",path:file}}});
  const f=h.store.registry().followups!.find(f=>f.work?.key==="review")!;
  await h.run({type:"control_work",target_id:f.id,expected_version:f.version,control:"complete"});
  expect(h.store.registry().followups!.find(x=>x.id===f.id)!.work?.resolution?.kind).toBe("completed");
  expect(h.store.registry().tasks[0].status).toBe("ready");
});
it("D09 changing transport labels cannot duplicate one accepted logical intention",async()=>{
  const h=setup(),input=active(h);
  const invoke=(label:string,call:string,action=taskAction)=>businessCall(h.core,{input_id:input.id,call_id:call,operation:"apply_changes",action_groups:[{action_identity:label,actions:[action]}]});
  expect((await invoke("label-a","call-a")).results[0].status).toBe("applied");
  expect((await invoke("label-b","call-b")).results[0].already_applied).toBe(true);
  expect((await invoke("label-a","call-c",{...taskAction,title:"different"})).results[0].status).toBe("rejected");
  expect(h.store.registry().tasks).toHaveLength(1);
});
it("E2 after three foreground jobs one actual background preparation gets its turn",async()=>{
  const h=setup(),file="03. Manual/fair.md",order:string[]=[];
  await h.run({type:"save_work",work:{key:"fair",summary:"准备材料",owner:"assistant",next_action:"写到指定位置",
    refs:[{kind:"note",path:file,role:"output"}],done_when:{kind:"material_verified",path:file,check:{kind:"exists_nonempty"}}}});
  let release!:()=>void;const wait=new Promise<void>(r=>{release=r;});let fronts=0;
  h.core.agent={executionMode:"tools-v2",interpret:async input=>{
    if(input.channel==="coordinator") {order.push("background");await workspaceCall(h.core,{input_id:input.id,call_id:"fair-write",operation:"write",path:file,content:"真实材料"});}
    else {order.push("front"+(++fronts));if(fronts===1)await wait;}
    return {action_groups:[],clarification:null,reply_intent:"discussion",discussion:"已核对当前情况"};
  }};
  for(let i=0;i<6;i++)await h.core.receive(h.input("查询现状"));release();
  await expect.poll(()=>h.store.db.prepare("SELECT count(*) n FROM inbox WHERE channel='web' AND status IN ('pending','processing')").get()).toEqual({n:0});
  expect(order.indexOf("background")).toBe(3);expect(h.store.files.read(file)).toBe("真实材料");
});
it("E8 recovery release requires the current reviewed inventory and opens only its named scope across restart",async()=>{
  const h=setup();h.store.updateRuntimeMeta(m=>({...m,recovery_guard:{active:true,reason:"BACKUP_RESTORED",created_at:h.store.now()},budget_guard:true}));
  const old=recoveryInventory(h.store);await h.run(taskAction);
  expect(()=>releaseRecovery(h.store,old.inventory_hash,["contact"],"reviewed-current-authority")).toThrow("清单已变化");
  const current=recoveryInventory(h.store);
  expect(()=>releaseRecovery(h.store,current.inventory_hash,["contact"],"yes")).toThrow("明确核对");
  releaseRecovery(h.store,current.inventory_hash,["background_write"],"reviewed-current-authority");
  expect(effectivePolicy(h.store).capabilities).toMatchObject({background_write:true,contact:false});
  await h.restart();expect(effectivePolicy(h.store).capabilities).toMatchObject({background_write:true,contact:false});
  const next=recoveryInventory(h.store);releaseRecovery(h.store,next.inventory_hash,["contact"],"reviewed-current-authority");
  expect(effectivePolicy(h.store).capabilities.contact).toBe(true);expect(h.store.runtimeMeta().budget_guard).toBe(true);
});
it("D09 a repeated file intention with a different call label returns its existing receipt instead of replaying",async()=>{
  const h=setup(),input=active(h),args={input_id:input.id,operation:"write" as const,path:"03. Manual/once.md",content:"only once"};
  const first=await workspaceCall(h.core,{...args,call_id:"first"});
  expect(await workspaceCall(h.core,{...args,call_id:"second"})).toEqual(first);
  expect(h.store.db.prepare("SELECT count(*) n FROM events WHERE kind='tool_effect' AND input_id=?").get(input.id)).toEqual({n:1});
  await expect(workspaceCall(h.core,{...args,call_id:"first",content:"different"})).rejects.toThrow("调用标识");
});
it("C2 classification runs through a bounded, exclusive model job slot",async()=>{
  const h=setup();
  const job=beginModelJob(h.store,"classify-"+Math.random().toString(16).slice(2),"classify");
  expect(job.kind).toBe("classify");
  expect(Date.parse(job.deadline_at)-Date.parse(h.store.now())).toBe(60000);
  // Understanding cannot run in parallel with another model call.
  expect(()=>beginModelJob(h.store,"classify-other","classify")).toThrow("模型槽");
  endModelJob(h.store,job.id);
  expect(beginModelJob(h.store,"classify-next","classify").kind).toBe("classify");
});
it("R2 restarting after the artifact was written reconciles real completion without another model call",async()=>{
  const h=setup(),file="03. Manual/recovered.md";
  await h.run({type:"save_work",work:{key:"recovered",summary:"准备已接受材料",owner:"assistant",next_action:"写入准确材料",
    refs:[{kind:"note",path:file,role:"output"}],done_when:{kind:"material_verified",path:file,check:{kind:"contains_all",terms:["有效入口"]}}}});
  atomicWrite(path.join(h.root,file),"有效入口：已持久写入");await h.restart();let calls=0;
  h.core.agent={executionMode:"tools-v2",interpret:async()=>{calls++;throw new Error("must not run");}};
  await runDelegatedWork(h.core);
  expect(calls).toBe(0);expect(h.store.registry().followups![0].work?.resolution?.kind).toBe("completed");
});
it("D08b the model context stays bounded when the vault is large",async()=>{
  const h=setup(),input=active(h);
  for(let i=0;i<35;i++)
    await h.run({...taskAction,title:"任务"+i} as any);
  for(let i=0;i<11;i++)
    await businessCall(h.core,{input_id:input.id,call_id:"prop"+i,operation:"save_proposals",
      action_groups:[{action_identity:"prop"+i,actions:[{...taskAction,title:"建议"+i}]}]} as any);
  const context=h.core.context(input as any) as any;
  expect(context.items.length).toBeLessThanOrEqual(30);
  expect(context.proposals.length).toBeLessThanOrEqual(10);

  // The model is told that it is only seeing part of the state.
  expect(context.truncated.items).toBe(true);
  expect(context.truncated.proposals).toBe(true);
  expect(context.available_counts.items).toBeGreaterThan(30);
});
it("S3c a background planning gap is recorded and visible to the next turn",async()=>{
  const h=setup(),file="03. Manual/gap.md";
  await h.run({type:"save_work",work:{key:"gap",summary:"准备材料",owner:"assistant",next_action:"写入材料",
    refs:[{kind:"note",path:file,role:"output"}],done_when:{kind:"material_verified",path:file,check:{kind:"contains_all",terms:["有效入口"]}}}});
  h.core.agent={executionMode:"tools-v2",interpret:async()=>{
    throw new AppError("PLANNING_CONFLICT","连带安排无法放入剩余时间，请选择保留哪项承诺",409);
  }};
  await runDelegatedWork(h.core);
  const gap=h.store.runtimeMeta().planning_gap;
  expect(gap?.message).toContain("无法放入");
  // The next turn can see it without reading logs.
  const context=h.core.context(h.input("看看有什么要决定") as any) as any;
  expect(context.planning_gap?.message).toContain("无法放入");
  // Repeating the same failure keeps a bounded history rather than growing it.
  h.core.recordPlanningGap("第二次同类缺口");
  const history = (h.core.context(h.input("再看一下") as any) as any).recent_planning_gaps;
  expect(history).toHaveLength(2);
  expect(history.at(-1).message).toBe("第二次同类缺口");
  // The responsibility is not marked complete by a failed background attempt.
  expect(h.store.registry().followups![0].status).toBe("open");

  // The user changes the day's constraint (here: allow using that day's reserve),
  // and the recorded gap stops being reported as current.
  await h.run({
    type: "set_planning",
    preferences: {
      availability: [{ weekdays: [1, 2, 3, 4, 5, 6, 7], start: "10:00", end: "20:00" }],
      buffer_minutes: 0,
    },
  } as any);
  expect(h.store.runtimeMeta().planning_gap).toBeUndefined();
  expect((h.core.context(h.input("再看看") as any) as any).planning_gap).toBeNull();
});
it("C4 an identical failing preparation stops after two attempts instead of opening endless jobs",async()=>{
  const h=setup(),file="03. Manual/materials.md";
  await h.run({type:"save_work",work:{key:"materials",summary:"准备已接受材料",owner:"assistant",next_action:"查材料并写入",
    refs:[{kind:"note",path:file,role:"output"}],done_when:{kind:"material_verified",path:file,check:{kind:"contains_all",terms:["有效入口"]}}}});
  let calls=0;
  h.core.agent={executionMode:"tools-v2",interpret:async()=>{calls++;throw new Error("model unavailable");}};
  await runDelegatedWork(h.core);
  await runDelegatedWork(h.core);
  await runDelegatedWork(h.core);
  // Same cause is not retried forever: exactly two attempts, then the责任 stays open.
  expect(calls).toBe(2);
  const follow=h.store.registry().followups![0];
  expect(follow.status).toBe("open");
  expect(follow.work?.resolution).toBeUndefined();
  expect(follow.analysis).toMatchObject({status:"failed",attempts:2});
  expect(h.store.db.prepare("SELECT count(*) n FROM inbox WHERE channel='coordinator'").get()).toEqual({n:2});
  // Nothing was faked as done: no artifact, no completed resolution, no extra job.
  expect(fs.existsSync(path.join(h.root,file))).toBe(false);
});
it("E11 a hundred identical wake-ups cannot multiply attempts or invent new causes",async()=>{
  const h=setup(),file="03. Manual/storm.md";
  await h.run({type:"save_work",work:{key:"storm",summary:"准备材料",owner:"assistant",next_action:"查材料",
    refs:[{kind:"note",path:file,role:"output"}]}});
  let calls=0;
  h.core.agent={executionMode:"tools-v2",interpret:async()=>{calls++;throw new Error("model unavailable");}};
  for(let i=0;i<100;i++)await runDelegatedWork(h.core);
  expect(calls).toBe(2);
  expect(h.store.db.prepare("SELECT count(*) n FROM inbox WHERE channel='coordinator'").get()).toEqual({n:2});
  const follow=h.store.registry().followups![0];
  expect(follow.analysis).toMatchObject({status:"failed",attempts:2});
  expect(follow.status).toBe("open");
  // New evidence is a genuinely new cause, so one re-evaluation is allowed and bounded again.
  atomicWrite(path.join(h.root,file),"新的材料片段");h.advance(24*60*60*1000);
  await runDelegatedWork(h.core);expect(calls).toBe(3);
  for(let i=0;i<100;i++)await runDelegatedWork(h.core);
  expect(calls).toBe(4);
});
it("E3 restored budgets permit only an explicitly approved finite allowance and keep its consumption after restart",async()=>{
  const h=setup();h.store.updateRuntimeMeta(m=>({...m,budget_guard:true,budget_guard_day:"2026-10-23"}));
  let budget=new ModelBudget(h.store);
  expect(()=>budget.reserve({},10)).toThrow("丢失运行额度");
  expect(()=>approveRecoveryBudget(h.store,1,2000,"yes")).toThrow("明确批准");
  approveRecoveryBudget(h.store,1,2000,"approve-additional-finite-budget");
  const ref=budget.reserve({},10);budget.settle(ref,null);const used=budget.status()!.tokens;
  await h.restart();budget=new ModelBudget(h.store);
  expect(()=>budget.reserve({},10)).toThrow("有限额度");expect(budget.status()!.tokens).toBe(used);
  h.advance(86400000);expect(()=>budget.reserve({},10)).not.toThrow();
});
it("D25 a changed prompt invalidates old write authority and new model jobs without exposing the provider key",async()=>{
  const h=setup(),combination=loadRuntimeCombination(h.store,{LLM_MODEL:"deepseek-flash",LLM_API_KEY:"PRIVATE-SENTINEL"}),input=active(h);
  expect(JSON.stringify(combination.manifest)).not.toContain("PRIVATE-SENTINEL");
  atomicWrite(h.store.files.resolve(".agent/prompts/persona.md","internal"),"新角色规则");
  expect(()=>beginModelJob(h.store,input.id,"front")).toThrow("兼容组合");
  await expect(workspaceCall(h.core,{input_id:input.id,call_id:"stale",operation:"write",path:"blocked.md",content:"must not write"})).rejects.toThrow("兼容组合");
  expect(fs.existsSync(path.join(h.root,"blocked.md"))).toBe(false);
});
it("D25c a prompt that still routes business changes through submit_proposal is refused, and the wording view carries no tool protocol",()=>{
  const h=setup();
  atomicWrite(h.store.files.resolve(".agent/prompts/system.md","internal"),"业务变更通过 submit_proposal 交给 Core。");
  expect(()=>loadRuntimeCombination(h.store,{LLM_MODEL:"deepseek-flash"})).toThrow("submit_proposal");
  atomicWrite(h.store.files.resolve(".agent/prompts/system.md","internal"),"业务变更用 secretary.apply_changes 直接办理。");
  const c=loadRuntimeCombination(h.store,{LLM_MODEL:"deepseek-flash"});
  expect(c.communication).not.toContain("input_mode=");
  expect(c.instructions).toContain("input_mode=");
  expect(c.instructions).toContain("技能库");
  expect(c.communication).toContain("只负责表达");
  // Wording gets the user's values and voice without the detailed tool manual.
  expect(c.communication).toContain("判断用户此刻想达到什么");
  expect(c.communication).toContain("复述");
  expect(c.communication).toContain("不把对动机的推测说成事实");
  expect(c.communication).not.toContain("create_task需要");
});
it("D25b an oversized prompt set fails at startup instead of every model turn",()=>{
  const h=setup();
  // Size the fixture from the configured budget so the guard keeps protecting
  // the real invariant when the limit changes.
  const unit = "必须遵守的长期规则。";
  const limit = h.store.config.agent.budget.request_input_tokens;
  const repeats = Math.ceil((limit * 1.5) / unit.length);
  atomicWrite(h.store.files.resolve(".agent/prompts/workflows.md","internal"), unit.repeat(repeats));
  expect(()=>loadRuntimeCombination(h.store,{LLM_MODEL:"deepseek-flash"})).toThrow("模型输入预算");
});
it("D10 workspace range reads detect a new file while successful own writes advance only the checked baseline",async()=>{
  const h=setup(),input=active(h),call=(args:any)=>workspaceCall(h.core,{input_id:input.id,call_id:crypto.randomUUID(),...args});
  await call({operation:"list"});await call({operation:"write",path:"03. Manual/one.md",content:"one"});
  await call({operation:"write",path:"03. Manual/two.md",content:"two"});
  atomicWrite(path.join(h.root,"external.md"),"external");
  await expect(call({operation:"write",path:"three.md",content:"three"})).rejects.toThrow("读取");
  expect(fs.existsSync(path.join(h.root,"three.md"))).toBe(false);
});
it("Q7 diagnostics keep bounded aggregates and a later success does not erase repeated error history",()=>{
  const h=setup(),log=new RuntimeLog(h.store);
  for(let i=0;i<140;i++)log.write("module"+i,{code:"FAILED",duration_ms:i});
  log.write("module0",{code:"FAILED"});log.write("success",{duration_ms:2});
  const result=log.summary();expect(result.errors).toHaveLength(128);expect(result.error_groups_dropped).toBe(12);
  expect(result.errors[0].count).toBe(2);expect(result.latency.counts.reduce((a,b)=>a+b,0)).toBe(141);
});

it("A a zero daily cap is accepted as unlimited, while size limits stay positive", () => {
  const h = setup();
  const configPath = h.store.files.resolve(".agent/config.json", "internal");
  const base = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  base.agent = {
    ...(base.agent ?? {}),
    budget: { request_input_tokens: 65536, request_output_tokens: 4096, daily_requests: 0, daily_tokens: 0 },
  };
  atomicWrite(configPath, JSON.stringify(base));
  expect(loadConfig(h.root).agent.budget).toMatchObject({ daily_requests: 0, daily_tokens: 0 });
  // A zero size limit is still nonsense and must fail at startup.
  base.agent.budget.request_input_tokens = 0;
  atomicWrite(configPath, JSON.stringify(base));
  expect(() => loadConfig(h.root)).toThrow("模型预算无效");
});
