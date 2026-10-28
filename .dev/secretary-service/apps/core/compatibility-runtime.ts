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
  const skillGuide=[
    "",
    "# 技能库",
    "",
    "方法、格式、流程类请求，先看 03. Manual/技能/ 有没有可复用的技能；索引在该目录 README。",
    "用技能时按步骤做，偏离要说明原因；技能过时或更好用了，顺手改进它，而不是另写一份。",
    "做完一次如果这套做法值得再用（用户说过“以后都这样”，或花了多轮才谈清），主动提议写成一条技能：先给名字和要点，征得同意后用 workspace 写入该目录，并在索引加一行。",
    "一次性的会议记录、私人叙述不要写成技能。",
  ].join("\n");
  const instructions=prompts.map(p=>p.text).join("\n\n")+skillGuide;
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
  // Wording has the same values and persona, without workflow or tool manuals.
  // Core supplies the actual effect facts for this turn separately.
  const communication=[...prompts.filter(p=>["system.md","persona.md"].includes(p.name)).map(p=>p.text),
    "# 本次只负责表达\n\n结合上下文判断用户此刻想达到什么，再想清楚这次回复要帮他解决什么；根据已有事实回应，不把对动机的推测说成事实。问信息就回答，交代结果就说明实际变化，遇到必要取舍才提出建议和问题。复述只在所指不清时使用，不因用户表达情绪就自动追问。不猜心理；保留真实的失败、未知、时间和数量。自然说话，不照抄工具文字。"].join("\n\n");
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
