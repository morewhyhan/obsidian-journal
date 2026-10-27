import fs from "node:fs";
import path from "node:path";
import type {Store} from "./store.js";
import {resource,projectRoot} from "./config.js";
import {AGENT_TOOLS} from "../../packages/contracts/agent-tools.js";
import {canonicalJson,hash} from "./files.js";
import {AppError} from "../../packages/contracts/types.js";
import {inputTokenReservation} from "./token-counter.js";

const names=["system.md","persona.md","workflows.md","execution.md"];
export function loadRuntimeCombination(s:Store,env:NodeJS.ProcessEnv) {
  const promptFiles=()=>names.map(name=>{
    const local=s.files.resolve(".agent/prompts/"+name,"internal"),file=fs.existsSync(local)?local:resource("prompts/"+name);
    return {name,text:fs.readFileSync(file,"utf8")};
  });
  const configFile=s.files.resolve(".agent/config.json","internal");
  const configHash=()=>fs.existsSync(configFile)?hash(fs.readFileSync(configFile)):null;
  const prompts=promptFiles(),initialConfig=configHash();
  const releaseFile=resource("release.json");
  const release=fs.existsSync(releaseFile)?JSON.parse(fs.readFileSync(releaseFile,"utf8")):null;
  let provider:string|null=null;try{const url=new URL(env.LLM_BASE_URL??"");provider=url.origin+url.pathname;}catch{}
  const manifest={format:1,release,lock_hash:hash(fs.readFileSync(path.join(projectRoot,"package-lock.json"))),
    tools_hash:hash(canonicalJson(AGENT_TOOLS)),prompts:Object.fromEntries(prompts.map(p=>[p.name,hash(p.text)])),
    schema:{registry:2,days:1,sql:1},model:{id:env.LLM_MODEL??null,provider,thinking:"enabled",reasoning_effort:"low"},
    configuration_hash:hash(canonicalJson(s.config)),deployment_images:"verify_with_check-deployment.py"};
  const fingerprint=hash(canonicalJson(manifest));
  // The effective prompt set is the largest fixed part of every model request.
  // If it alone consumes most of the input reservation, every real turn is
  // refused later with MODEL_INPUT_LIMIT: fail at startup with the real reason.
  const instructions=prompts.map(p=>p.text).join("\n\n");
  // One effective protocol: the native tool loop executes business changes.
  // A prompt line that still routes them through submit_proposal would fight
  // the bridge, which rejects that call in native mode.
  const legacyRouting=prompts.flatMap(p=>p.text.split("\n")
    .map((line,index)=>({name:p.name,line,index}))
    .filter(x=>x.line.includes("submit_proposal") && !x.line.includes("兼容")));
  if(legacyRouting.length)
    throw new AppError("PROMPT_PROTOCOL_CONFLICT",
      "提示词要求用 submit_proposal 办理业务，但当前是工具环执行；请改成 apply_changes，或在同一行说明仅兼容模式使用",
      500,
      {conflicts:legacyRouting.map(x=>x.name+":"+(x.index+1))});
  // Communication-only view: persona and tone without the tool protocol, used
  // by wording calls and the final language pass.
  const communication=[...prompts.filter(p=>p.name!=="execution.md").map(p=>p.text),
    "# 本次只负责表达\n\n直接对用户说话：用事实和真实结果，不用内部术语（协议、投影、委托、门禁、作用域、回执）。需要核对或取舍时用一两句话说清，不追问已经说清的事，不列能力清单。"].join("\n\n");
  const promptTokens=inputTokenReservation({messages:[{role:"system",content:instructions}]},"deepseek-flash");
  const inputLimit=s.config.agent.budget.request_input_tokens;
  if(promptTokens>inputLimit*0.55)
    throw new AppError("PROMPT_BUDGET_EXCEEDED",
      "有效提示词约占模型输入预算的"+Math.round(promptTokens/inputLimit*100)+"%，请精简提示词或调整 agent.budget.request_input_tokens",500,
      {prompt_tokens:promptTokens,request_input_tokens:inputLimit});
  s.compatibility={fingerprint,manifest,verify:()=>{
    try{return configHash()===initialConfig && canonicalJson(promptFiles().map(p=>[p.name,hash(p.text)]))===canonicalJson(prompts.map(p=>[p.name,hash(p.text)]));}
    catch{return false;}
  }};
  return {manifest,fingerprint,instructions,communication,prompt_tokens:promptTokens};
}
export function requireRuntimeCombination(s:Store) {
  if(s.compatibility && !s.compatibility.verify())throw new AppError("COMPATIBILITY_CHANGED","配置或提示词已改变；请校验并重启，以新的兼容组合接续",409);
}
