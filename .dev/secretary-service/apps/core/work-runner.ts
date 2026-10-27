import type { Core } from "./core.js";
import { AppError, type Input } from "../../packages/contracts/types.js";
import { deriveGrant } from "./background-grant.js";
import { reconcileWork } from "./work-checks.js";
import { canonicalJson,hash } from "./files.js";
import { referencedObject } from "../../packages/domain/work.js";

export async function runDelegatedWork(core:Core,allowForeground=false) {
  const s=core.store;
  if(!core.agent || core.agent.executionMode!=="tools-v2" || core.working && !allowForeground)return;
  const r=s.registry(),now=s.now();
  const due=(r.followups??[]).filter(f=>f.work?.delegation && f.status==="open" && f.work.owner==="assistant" &&
    (!f.next_check_at || f.next_check_at<=now)).sort((a,b)=>a.updated_at.localeCompare(b.updated_at));
  for(const f of due) {
    // Crash after a real effect but before the model receipt must not repeat the work.
    const settled=await s.exclusive(()=>{
      const current=s.registry(),live=current.followups?.find(x=>x.id===f.id);
      if(live?.work?.step_id!==f.work!.step_id || live?.status!=="open")return true;
      const op="work-proof:"+f.id+":"+f.work!.step_id;
      const ids=reconcileWork(s,current,op,live.work!.delegation!.source,f.id);
      if(!ids.length)return false;
      s.commit(op,"coordinator",op,reg=>{const changed=reconcileWork(s,reg,op,live.work!.delegation!.source,f.id);
        return {ids:changed,message:"实际准备效果已存在，不重复调用模型"};});
      return true;
    });
    if(settled)continue;
    const evidence=(f.work!.refs??[]).map(ref=>{
      if(ref.kind!=="note")return [ref.kind,ref.id,referencedObject(r,ref)?.version??null];
      try{return ["note",ref.path,hash(s.files.read(ref.path!))];}catch{return ["note",ref.path,null];}
    });
    const cause=hash(canonicalJson([f.work!.step_id,evidence,r.rules_revision??0,f.next_check_at]));
    if(f.analysis?.fingerprint===cause && (f.analysis.status==="done" || f.analysis.attempts>=2))continue;
    let grant;try{grant=deriveGrant(s,f);}catch{continue;}
    const attempt=f.analysis?.fingerprint===cause?f.analysis.attempts+1:1;
    const job="work-job:"+hash(canonicalJson([f.id,f.work!.step_id,cause,attempt]));
    const input:Input={id:job,external_id:job,channel:"coordinator",actor_ref:"assistant",occurred_at:now,
      text:"履行当前已接受委托。先查证，再在有限工具权限内真实办理；不能改变用户成果或扩大范围。需要等待或决定时，用save_work保留准确下一处理者和下一步。最后说明实际效果，不对用户直接发消息。"};
    const claimed=await s.exclusive(()=>{
      const live=s.registry().followups?.find(x=>x.id===f.id);
      if(live?.version!==f.version || live?.work?.step_id!==f.work!.step_id || live?.status!=="open")return false;
      try{grant=deriveGrant(s,live);}catch{return false;}
      s.commit(job+":start","coordinator",job,reg=>{
        const current=reg.followups!.find(x=>x.id===f.id)!;
        current.analysis={fingerprint:cause,status:"running",at:now,attempts:attempt,strategy:"delegated_work"};
        return {ids:[],message:"开始获准准备"};
      });
      s.db.prepare("INSERT OR REPLACE INTO inbox(id,channel,actor_ref,external_id,body,metadata_json,status,received_at,occurred_at) VALUES(?,?,?,?,?,?,'processing',?,?)")
        .run(job,"coordinator","assistant",job,input.text,JSON.stringify({agent_execution:"tools-v2",policy_stamp:grant.policy_stamp,
          background_grant:grant,observed_refs:grant.observed_versions}),now,now);
      return true;
    });
    if(!claimed)continue;
    try {
      await core.agent.interpret(input,{now,timezone:s.config.timezone,work:f,background_grant:grant,
        objects:grant.observed_versions,query:"通过secretary.state/followups补查；workspace只允许委托固定路径。"});
      await s.exclusive(()=>{
        s.commit(job+":reconcile","coordinator",job,reg=>{
          const changed=reconcileWork(s,reg,job,f.work!.delegation!.source);
          const current=reg.followups!.find(x=>x.id===f.id);
          if(current?.analysis?.fingerprint===cause)current.analysis.status="done";
          return {ids:changed,message:"准备效果已核对，未满足完成条件的责任保留"};
        });
        s.db.prepare("UPDATE inbox SET status='processed',body=NULL,processed_at=? WHERE id=?").run(s.now(),job);
      });
    }catch(error) {
      await s.exclusive(()=>{
        s.commit(job+":failure","coordinator",job,reg=>{
          const current=reg.followups!.find(x=>x.id===f.id);
          if(current?.analysis?.fingerprint===cause)current.analysis.status="failed";
          return {ids:[],message:"准备中断，已保存效果保留，责任不算完成"};
        });
        s.db.prepare("UPDATE inbox SET status='failed',body=NULL,processed_at=?,error_code=? WHERE id=?")
          .run(s.now(),error instanceof AppError?error.code:"BACKGROUND_FAILED",job);
      });
    }
    break;
  }
}
