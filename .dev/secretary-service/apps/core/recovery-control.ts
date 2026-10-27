import fs from "node:fs";
import { AppError } from "../../packages/contracts/types.js";
import { canonicalJson,hash } from "./files.js";
import type { Store } from "./store.js";

export type RecoveryScope="background_write"|"contact";
/** Offline maintenance only: no model tool or channel endpoint exposes this authority. */
export function recoveryInventory(s:Store) {
  const r=s.registry(),meta=s.runtimeMeta(),guard=meta.recovery_guard??null;
  const snapshot={registry:r,configuration:s.config,guard,restore_boundary:meta.restore_boundary??null};
  return {inventory_hash:hash(canonicalJson(snapshot)),restore_boundary:meta.restore_boundary??null,guard,
    review_required:["核对恢复点之后的取消、撤权、暂停和事故记录", "核对当前委托对象、固定路径、允许能力和有效期", "单独确认允许主动联系；不恢复旧发送队列"],
    current:{rules:(r.user_rules??[]).filter(x=>x.enabled).map(x=>({id:x.id,version:x.version,key:x.key,ends_at:x.ends_at})),
      controls:r.controls.map(x=>({id:x.id,version:x.version})),
      delegations:(r.followups??[]).filter(x=>x.status!=="resolved" && x.work?.delegation).map(x=>({work_id:x.id,step_id:x.work!.step_id,status:x.status,
        capabilities:x.work!.delegation!.capabilities,object_ids:x.work!.delegation!.object_ids,paths:x.work!.delegation!.paths,expires_at:x.work!.delegation!.expires_at})),
      operational_blocks:r.operational_blocks??[]},budget_guard:!!meta.budget_guard};
}
export function releaseRecovery(s:Store,expectedHash:string,scopes:RecoveryScope[],acknowledgement:string) {
  if(!s.time.read().trusted)throw new AppError("TIME_SYNC_REQUIRED","先确认宿主时间同步，才能解除恢复保护",409);
  if(!scopes.length || new Set(scopes).size!==scopes.length || scopes.some(x=>!["background_write","contact"].includes(x)) ||
    acknowledgement!=="reviewed-current-authority")throw new AppError("RECOVERY_REVIEW_REQUIRED","需要明确核对当前授权及解除范围",400);
  const inventory=recoveryInventory(s);
  if(inventory.inventory_hash!==expectedHash)throw new AppError("VERSION_CONFLICT","授权清单已变化，请重新核对恢复清单",409);
  if(!inventory.guard?.active)throw new AppError("RECOVERY_NOT_ACTIVE","没有需要解除的恢复保护",409);
  const released=[...new Set([...(inventory.guard.released_capabilities??[]),...scopes])];
  s.updateRuntimeMeta(m=>({...m,recovery_guard:{...m.recovery_guard,active:released.length<2,released_capabilities:released,
    reviewed_inventory_hash:expectedHash,reviewed_at:s.now(),review_source:"offline-maintenance"}}));
  // Keep the original replay boundary. Only the contact hold is explicitly released.
  if(scopes.includes("contact")) {
    s.recoveryUntil=null;
    const file=s.files.resolve(".agent/data/recovery-until","internal");
    if(fs.existsSync(file))fs.unlinkSync(file);
    s.state.resolveReason("REPLAY_WINDOW_OPEN");
  }
  // The lifecycle only mirrors the persisted guard; releasing the last scope is
  // the one place that clears the degraded reason instead of restarting.
  if(!s.runtimeMeta().recovery_guard?.active)
    s.state.resolveReason("RECOVERY_GUARD_ACTIVE");
  return {released:scopes,recovery_guard:s.runtimeMeta().recovery_guard,budget_guard:!!s.runtimeMeta().budget_guard};
}
