import type { Store } from "./store.js";
import { AppError } from "../../packages/contracts/types.js";
import { id } from "./files.js";
import { requireRuntimeCombination } from "./compatibility-runtime.js";
export function beginModelJob(s:Store,inputId:string,kind:"front"|"background"|"compose"|"self_test") {
  requireRuntimeCombination(s);
  const now=s.now(),current=s.runtimeMeta().model_job;
  if(current && current.generation===s.generation && current.deadline_at>now)throw new AppError("MODEL_JOB_BUSY","模型槽正在处理另一作业",429);
  if(["front","background"].includes(kind)) {
    const row=s.db.prepare("SELECT channel,status FROM inbox WHERE id=?").get(inputId) as any;
    if(row?.status!=="processing" || (kind==="background")!==(row.channel==="coordinator"))throw new AppError("MODEL_JOB_INVALID","模型作业不属于有效入件",403);
  }
  const ms=kind==="front"?120000:kind==="background"?60000:kind==="compose"?10000:30000;
  const job={id:id("modeljob"),input_id:inputId,kind,generation:s.generation,deadline_at:new Date(Date.parse(now)+ms).toISOString(),
    mono_deadline:performance.now()+ms,requests:0,compatibility_fingerprint:s.compatibility?.fingerprint??null};
  s.updateRuntimeMeta(m=>({...m,model_job:job}));
  if(["front","background"].includes(kind))s.db.prepare("UPDATE inbox SET metadata_json=json_set(metadata_json,'$.model_job_id',?,'$.runtime_generation',?,'$.deadline_at',?) WHERE id=?")
    .run(job.id,s.generation,job.deadline_at,inputId);
  return job;
}
export function endModelJob(s:Store,jobId:string) {
  s.updateRuntimeMeta(m=>{if(m.model_job?.id===jobId)delete m.model_job;return m;});
}
export function modelDeadline(s:Store,required=false) {
  const job=s.runtimeMeta().model_job;
  if(!job && !required)return 125000;
  if(!job || job.generation!==s.generation)throw new AppError("MODEL_JOB_REQUIRED","缺少当前代次的模型作业",403);
  const ms=Math.min(Date.parse(job.deadline_at)-Date.parse(s.now()),job.mono_deadline-performance.now());
  if(ms<=0)throw new AppError("MODEL_JOB_EXPIRED","模型作业已到期限，不再发起子调用",409);
  return Math.ceil(ms);
}
