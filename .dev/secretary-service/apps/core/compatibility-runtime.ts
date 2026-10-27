import fs from "node:fs";
import path from "node:path";
import type {Store} from "./store.js";
import {resource,projectRoot} from "./config.js";
import {AGENT_TOOLS} from "../../packages/contracts/agent-tools.js";
import {canonicalJson,hash} from "./files.js";
import {AppError} from "../../packages/contracts/types.js";

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
  s.compatibility={fingerprint,manifest,verify:()=>{
    try{return configHash()===initialConfig && canonicalJson(promptFiles().map(p=>[p.name,hash(p.text)]))===canonicalJson(prompts.map(p=>[p.name,hash(p.text)]));}
    catch{return false;}
  }};
  return {manifest,fingerprint,instructions:prompts.map(p=>p.text).join("\n\n")};
}
export function requireRuntimeCombination(s:Store) {
  if(s.compatibility && !s.compatibility.verify())throw new AppError("COMPATIBILITY_CHANGED","配置或提示词已改变；请校验并重启，以新的兼容组合接续",409);
}
