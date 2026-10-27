import type { Registry } from "../../packages/contracts/types.js";
import { AppError } from "../../packages/contracts/types.js";
import { ruleValue } from "../../packages/domain/assistant.js";
import type { Store } from "./store.js";
import { canonicalJson,hash } from "./files.js";

export function effectivePolicy(store:Store,r:Registry=store.registry()) {
  const now=store.now();
  let runtimeAvailable=true,guard:any;
  try{guard=store.runtimeMeta().recovery_guard;}catch{runtimeAvailable=false;guard={active:true,reason:"RUNTIME_UNAVAILABLE"};}
  const blocks=(r.operational_blocks??[]).filter(b=>!b.cleared_at);
  const reason=(cap:string)=>blocks.filter(b=>b.capability===cap).map(b=>b.reason_code);
  const disabled=!ruleValue(r,"assistance.enabled",true,now);
  const time=store.time.read();
  const writable=store.state.acceptsWork();
  const recoveryBlocks=(cap:string)=>guard?.active && !guard.released_capabilities?.includes(cap);
  const capabilities={
    business_write:writable && reason("business_write").length===0,
    background_write:writable && time.trusted && !disabled && !recoveryBlocks("background_write") && !reason("business_write").length && !reason("background_write").length,
    contact:writable && !disabled && !recoveryBlocks("contact") && time.trusted && ruleValue(r,"contact.enabled",true,now) && !reason("contact").length,
    model:runtimeAvailable && !reason("model").length,
  };
  return {capabilities,recovery_guard:guard??null,operational_blocks:blocks,time:{trusted:time.trusted,reason:time.reason},
    policy_stamp:hash(canonicalJson([r.rules_revision??0,r.planning_version??0,
      (r.user_rules??[]).filter(x=>x.enabled && x.starts_at<=now && (!x.ends_at || x.ends_at>now)).map(x=>[x.id,x.version]),
      guard,blocks,store.config,capabilities]))};
}
export function requireCapability(store:Store,cap:keyof ReturnType<typeof effectivePolicy>["capabilities"]) {
  const p=effectivePolicy(store);
  if(!p.capabilities[cap])throw new AppError("CAPABILITY_BLOCKED","当前能力受暂停、事故或恢复保护限制",403,{capability:cap});
}
