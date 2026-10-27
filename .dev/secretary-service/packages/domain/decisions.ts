import { AppError, type Action, type Proposal, type Source } from "../contracts/types.js";
import { canonicalJson, hash } from "../shared/identity.js";

export function selectedProposalActions(action: Action, proposal: Proposal) {
  const indices = action.action_indices === undefined ? proposal.actions.map((_, i) => i) : action.action_indices;
  if (!Array.isArray(indices) || !indices.length || new Set(indices).size !== indices.length ||
    indices.some(i => !Number.isInteger(i) || i < 0 || i >= proposal.actions.length))
    throw new AppError("INVALID_SELECTION", "选择必须对应当前版本的具体建议项");
  const selected = indices.map(i => proposal.actions[i]);
  const remaining = proposal.actions.filter((_, i) => !indices.includes(i));
  const shared = new Set(selected.flatMap(a => a.target_id ? [a.target_id] : []));
  if (remaining.some(a => a.target_id && shared.has(a.target_id)))
    throw new AppError("DEPENDENT_SELECTION", "同一事项的关联动作需要一起决定，不能只执行一半");
  const amendments = action.amended_actions;
  if (amendments !== undefined && (action.type !== "accept_proposal" || !Array.isArray(amendments) || amendments.length !== selected.length ||
    amendments.some((a, i) => !a || a.type !== selected[i].type || a.target_id !== selected[i].target_id)))
    throw new AppError("INVALID_AMENDMENT", "仅接受时可修订，且须逐项对应选中的原动作类型");
  return { indices: indices as number[], selected: (amendments ?? selected) as Action[], remaining };
}

export function decideProposal(proposal: Proposal, action: Action, context: {now:string;operation:string;source:Source;userAuthorized:boolean}) {
  if (!["accept_proposal","reject_proposal","defer_proposal"].includes(action.type))
    throw new AppError("INVALID_DECISION","不是合法的方案决定");
  if (!context.userAuthorized) throw new AppError("NEEDS_CONFIRMATION", "决定需要用户授权");
  if (proposal.version !== action.expected_version || proposal.status !== "pending" || proposal.expires_at <= context.now)
    throw new AppError("PROPOSAL_EXPIRED", "建议已变化或过期", 409);
  const decision = action.type === "accept_proposal" ? "accept" : action.type === "reject_proposal" ? "reject" : "defer";
  const selection = selectedProposalActions(action, proposal);
  const original = structuredClone(proposal.actions), applied = decision === "accept" ? structuredClone(selection.selected) : [];
  (proposal.decisions ??= []).push({
    proposal_version:proposal.version, proposal_hash:hash(canonicalJson({version:proposal.version,actions:original})),
    decision, action_indices:[...selection.indices], original_actions:original, applied_actions:applied,
    applied_hash:hash(canonicalJson(applied)), source:context.source, operation_id:context.operation, at:context.now,
  });
  if (decision !== "defer") {
    proposal.status = selection.remaining.length ? "pending" : decision === "accept" ? "accepted" : "cancelled";
    proposal.actions = selection.remaining.length ? selection.remaining : selection.selected;
  }
  proposal.version++; proposal.updated_at=context.now; proposal.last_operation_id=context.operation;
  return selection;
}
