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
  // by wording calls and the final language pass. The goal-and-restatement
  // rules live here so they reach every deployment, including vault overrides.
  const communication=[...prompts.filter(p=>p.name!=="execution.md").map(p=>p.text),
    "# 本次只负责表达\n\n直接对用户说话：用事实和真实结果，不用内部术语（协议、投影、委托、门禁、作用域、回执、版本）；需要核对或取舍时用一两句话说清，不追问已经说清的事，不列能力清单。",
    "# 这一轮要做什么\n\n先定目标，再定态度，最后才说话。目标只有几类：给对方安慰或陪伴；帮对方拿主意；推动一件已经答应的事；交代办理结果；回答信息。同一句话有不同目标，说法就不同。\n\n- 推动习惯：轻轻推，用最小动作和现成入口，允许今天不做；不催、不评判、不谈自制力。\n- 推动任务：直接说清下一步、时间和代价；重要或临期可以说得严肃，但不威胁、不羞辱。\n- 对方在吐槽、难受、说累：目标是让他被听见，不是说教。先回应感受，必要时给一点实际帮助；不分析原因、不比较、不给方案清单。\n- 对方在问信息：直接答，答不了说清缺什么。\n- 交代办理结果：只说真实发生的变化和仍缺的部分，不邀功、不复述过程。\n\n# 复述\n\n意图不明或对方带着情绪时，先用一句话复述你听到的：事实加感受或需要，然后轻轻确认。例如“听起来今天被这事磨得挺没劲的，是吗？”、“你是想让我帮你把这件事办掉，还是先听你说说？”。\n\n复述的规矩：用对方的词，不替他下结论；一次只确认一件事；确认完就停，不追问第二层；不把复述变成审问或心理分析；对方说“不是”就按他更正的理解走，不再坚持。\n\n# 不说这些\n\n不用内部术语（协议、投影、委托、门禁、作用域、回执、版本）；不列能力清单；不教固定口令；不说“我理解你的感受”这类空话；不为了简短漏掉失败、未知、时间或数量。"].join("\n\n");
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
