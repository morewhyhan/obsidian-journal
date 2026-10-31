import { DateTime } from "luxon";
import { AppError } from "../../packages/contracts/types.js";
import type { Store } from "./store.js";
import { id } from "./files.js";
import { requireCapability } from "./policy.js";
import { inputTokenReservation } from "./token-counter.js";

export class ModelBudget {
  constructor(private s:Store,private model?:string) {
    // A previous physical request can no longer produce a usable receipt after restart.
    for(const row of s.db.prepare("SELECT id FROM events WHERE kind='model_reservation' AND status='prepared'").all() as {id:string}[])
      this.settle(row.id,null);
  }
  reserve(request:unknown,output:number,job="unbound") {
    requireCapability(this.s,"model");
    const reading=this.s.time.read();
    if(!reading.trusted)throw new AppError("CLOCK_UNTRUSTED","时间未核实，暂不推进付费额度",503);
    const date=DateTime.fromJSDate(reading.wallNow,{zone:this.s.config.timezone}).toISODate()!;
    const input=inputTokenReservation(request,this.model);
    const c=this.s.config.agent.budget;
    if(input>c.request_input_tokens)throw new AppError("MODEL_INPUT_LIMIT","模型输入超过保守预算，请缩小上下文或分页读取",413,
      {input_upper:input,limit:c.request_input_tokens});
    const reserved=input+output,ref=id("reservation");
    this.s.db.transaction(()=>{
      const meta=this.s.runtimeMeta();
      if(meta.model_job) {
        // Terminal for this job: retrying only burns the user's wait.
        if(meta.model_job.requests>=12)throw new AppError("MODEL_JOB_CALL_LIMIT","本作业模型调用已达上限",400);
        meta.model_job.requests++;
        this.s.updateRuntimeMeta(m=>({...m,model_job:meta.model_job}));
      }
      const guarded=meta.budget_guard && (!meta.budget_guard_day || date<=meta.budget_guard_day);
      const allowance=meta.recovery_allowance;
      if(guarded && (allowance?.date!==date || allowance.requests+1>allowance.max_requests || allowance.tokens+reserved>allowance.max_tokens))
        throw new AppError("MODEL_BUDGET_RECOVERY_GUARD","丢失运行额度，需核对预算或批准新的有限额度后再调用模型",503);
      const day=meta.model_budget ?? {date,requests:0,tokens:0};
      if(day.blocked)throw new AppError("MODEL_BUDGET_RECONCILE_REQUIRED","提供者用量超出预留依据，需核对后再开放",503);
      if(date<day.date)throw new AppError("CLOCK_UNTRUSTED","预算日期不能回退",503);
      const next=date>day.date ? {date,requests:0,tokens:0}:day;
      if(!guarded && (next.requests+1>c.daily_requests || next.tokens+reserved>c.daily_tokens))
        // Terminal for the day: retrying five times only delays the honest failure.
        throw new AppError("MODEL_BUDGET_EXHAUSTED","当日模型额度不足，现有事实和原文提醒保留",400);
      next.requests++;next.tokens+=reserved;
      this.s.updateRuntimeMeta(m=>({...m,model_budget:next,...(guarded?{recovery_allowance:{...allowance,requests:allowance.requests+1,tokens:allowance.tokens+reserved}}:{})}));
      this.s.db.prepare("INSERT INTO events(id,dedupe_key,source,kind,payload_json,created_at) VALUES(?,?,'model','model_reservation',?,?)")
        .run(ref,ref,JSON.stringify({date,job,reserved_tokens:reserved,input_upper:input,output_limit:output,state:"reserved",allowance_id:guarded?allowance.id:null}),this.s.now());
    })();return ref;
  }
  settle(ref:string,usage:{prompt_tokens:number;completion_tokens:number;total_tokens?:number}|null) {
    this.s.db.transaction(()=>{
      const row=this.s.db.prepare("SELECT status,payload_json FROM events WHERE id=? AND kind='model_reservation'").get(ref) as any;
      if(!row || row.status!=="prepared")return;
      const p=JSON.parse(row.payload_json);
      const valid=usage && [usage.prompt_tokens,usage.completion_tokens,usage.total_tokens??0].every(n=>Number.isSafeInteger(n)&&n>=0);
      const tokens=valid?Math.max(usage!.prompt_tokens+usage!.completion_tokens,usage!.total_tokens??0):p.reserved_tokens;
      this.s.updateRuntimeMeta(meta=>{
        if(meta.model_budget?.date===p.date)meta.model_budget.tokens+=tokens-p.reserved_tokens;
        if(p.allowance_id && meta.recovery_allowance?.id===p.allowance_id)meta.recovery_allowance.tokens+=tokens-p.reserved_tokens;
        if(valid && (usage!.prompt_tokens>p.input_upper || usage!.completion_tokens>p.output_limit))
          meta.model_budget={...meta.model_budget,blocked:true,reason:"PROVIDER_USAGE_EXCEEDS_RESERVATION"};
        return meta;
      });
      this.s.db.prepare("UPDATE events SET status='applied',completed_at=?,payload_json=? WHERE id=?")
        .run(this.s.now(),JSON.stringify({...p,state:"settled",tokens,estimated_usage:!valid,result_unknown:!valid}),ref);
    })();
  }
  status(){const m=this.s.runtimeMeta();return m.model_budget?{...m.model_budget,recovery_allowance:m.recovery_allowance??null}:null;}
}

/** Explicit offline authorization; never exposed as a model tool. Prior usage is retained. */
export function approveRecoveryBudget(s:Store,requests:number,tokens:number,acknowledgement:string) {
  if(!s.time.read().trusted)throw new AppError("CLOCK_UNTRUSTED","需要可信预算日",409);
  const date=DateTime.fromJSDate(s.clock(),{zone:s.config.timezone}).toISODate()!,meta=s.runtimeMeta();
  if(!meta.budget_guard || meta.budget_guard_day && date>meta.budget_guard_day)throw new AppError("BUDGET_NOT_GUARDED","当前没有丢库额度保护",409);
  const limits=s.config.agent.budget;
  if(acknowledgement!=="approve-additional-finite-budget" || !Number.isSafeInteger(requests) || requests<1 || requests>limits.daily_requests ||
    !Number.isSafeInteger(tokens) || tokens<1 || tokens>limits.daily_tokens)throw new AppError("BUDGET_APPROVAL_INVALID","需明确批准不超过当日配置上限的新增请求数和token数",400);
  if(s.db.prepare("SELECT 1 FROM events WHERE kind='model_reservation' AND status='prepared'").get())
    throw new AppError("BUDGET_RECONCILE_REQUIRED","先核对仍在途的额度预留",409);
  const allowance={id:id("allowance"),date,max_requests:requests,max_tokens:tokens,requests:0,tokens:0,approved_at:s.now(),source:"offline-maintenance"};
  s.updateRuntimeMeta(m=>({...m,recovery_allowance:allowance}));return allowance;
}
