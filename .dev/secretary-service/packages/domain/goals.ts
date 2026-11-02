import { AppError, GOAL_STATUSES, MILESTONE_STATUSES, type Action, type GoalCase, type GoalCriterion, type Milestone, type Registry, type Source } from "../contracts/types.js";
import { id } from "../shared/identity.js";

type GoalContext = { now: string; operation: string; source: Source; userAuthorized: boolean };

const text = (value: unknown, name: string, max = 2000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new AppError("INVALID_FIELD", `${name}不完整`);
  return value.trim();
};

const list = (value: unknown, name: string, maxItems = 20, maxLength = 500) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || !item.trim() || item.length > maxLength))
    throw new AppError("INVALID_FIELD", `${name}需要短文本列表`);
  return [...new Set(value.map((item) => String(item).trim()))];
};

function criteria(value: unknown, name: string): GoalCriterion[] {
  if (!Array.isArray(value) || value.length > 20 || value.length === 0)
    throw new AppError("INVALID_ACCEPTANCE", `${name}至少需要一条验收条件`);
  const ids = new Set<string>();
  return value.map((raw: any, index) => {
    if (!raw || typeof raw !== "object") throw new AppError("INVALID_ACCEPTANCE", `${name}无效`);
    const criterionId = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `g${index + 1}`;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(criterionId) || ids.has(criterionId))
      throw new AppError("INVALID_ACCEPTANCE", `${name}的条件ID需要唯一`);
    ids.add(criterionId);
    if (!["check", "count", "artifact"].includes(raw.kind)) throw new AppError("INVALID_ACCEPTANCE", `${name}的验收类型无效`);
    if (typeof raw.description !== "string" || !raw.description.trim()) throw new AppError("INVALID_ACCEPTANCE", `${name}缺少说明`);
    if (raw.kind === "count" && (!Number.isFinite(raw.target) || raw.target < 0 || typeof raw.unit !== "string" || !raw.unit.trim()))
      throw new AppError("INVALID_ACCEPTANCE", `${name}的数量条件需要目标和单位`);
    return {
      id: criterionId,
      kind: raw.kind,
      description: text(raw.description, `${name}说明`),
      target: raw.kind === "count" ? Number(raw.target) : null,
      unit: raw.kind === "count" ? text(raw.unit, `${name}单位`, 30) : null,
      verification: raw.verification === "tool" ? "tool" : "self_report",
      artifact_ref: raw.artifact_ref == null ? null : text(raw.artifact_ref, `${name}交付物`, 1024),
      ...(raw.evidence_ref == null ? {} : { evidence_ref: text(raw.evidence_ref, `${name}证据`, 1024) }),
    };
  });
}

function stamp(entity: { version: number; updated_at: string; last_operation_id: string }, c: GoalContext) {
  entity.version += 1;
  entity.updated_at = c.now;
  entity.last_operation_id = c.operation;
}

function requireAuthorized(c: GoalContext) {
  if (!c.userAuthorized) throw new AppError("NEEDS_CONFIRMATION", "目标变更需要用户明确接受", 422);
}

function goal(registry: Registry, targetId: string | undefined) {
  const found = registry.goals.find((item) => item.id === targetId);
  if (!found) throw new AppError("ITEM_NOT_FOUND", "目标不存在", 404);
  return found;
}

function checkVersion(target: GoalCase, action: Action) {
  if (action.expected_version !== undefined && target.version !== action.expected_version)
    throw new AppError("VERSION_CONFLICT", "目标已经变化，请重新读取", 409, { version: target.version });
}

function activeOrProposed(status: GoalCase["status"]) {
  return status === "proposed" || status === "active" || status === "paused";
}

export function createGoal(input: Action, c: GoalContext): GoalCase {
  const status = input.status === "active" ? "active" : "proposed";
  if (status === "active") requireAuthorized(c);
  const result: GoalCase = {
    id: id("goal"),
    version: 1,
    created_at: c.now,
    updated_at: c.now,
    last_operation_id: c.operation,
    title: text(input.title, "目标名称", 200),
    problem: text(input.problem, "目标问题"),
    desired_outcome: text(input.desired_outcome, "目标结果"),
    acceptance: criteria(input.acceptance, "目标验收"),
    constraints: list(input.constraints, "目标约束"),
    non_goals: list(input.non_goals, "目标不做"),
    principles: list(input.principles, "决策原则"),
    review_policy: {
      cadence: ["weekly", "monthly", "quarterly", "on_change"].includes(String((input.review_policy as any)?.cadence))
        ? (input.review_policy as any).cadence
        : "on_change",
      next_at: typeof (input.review_policy as any)?.next_at === "string" ? (input.review_policy as any).next_at : null,
      triggers: list((input.review_policy as any)?.triggers, "复查触发条件", 12, 200),
    },
    status,
    milestones: [],
    decision_log: [],
    source: c.source,
  };
  return result;
}

function revise(target: GoalCase, input: Action, c: GoalContext) {
  requireAuthorized(c);
  if (!activeOrProposed(target.status)) throw new AppError("GOAL_TERMINAL", "已结束的目标不能直接修改", 409);
  if (input.title !== undefined) target.title = text(input.title, "目标名称", 200);
  if (input.problem !== undefined) target.problem = text(input.problem, "目标问题");
  if (input.desired_outcome !== undefined) target.desired_outcome = text(input.desired_outcome, "目标结果");
  if (input.acceptance !== undefined) target.acceptance = criteria(input.acceptance, "目标验收");
  if (input.constraints !== undefined) target.constraints = list(input.constraints, "目标约束");
  if (input.non_goals !== undefined) target.non_goals = list(input.non_goals, "目标不做");
  if (input.principles !== undefined) target.principles = list(input.principles, "决策原则");
  if (input.review_policy !== undefined) {
    const policy = input.review_policy as any;
    target.review_policy = {
      cadence: ["weekly", "monthly", "quarterly", "on_change"].includes(String(policy.cadence)) ? policy.cadence : target.review_policy.cadence,
      next_at: policy.next_at === null || typeof policy.next_at === "string" ? policy.next_at : target.review_policy.next_at,
      triggers: policy.triggers === undefined ? target.review_policy.triggers : list(policy.triggers, "复查触发条件", 12, 200),
    };
  }
  stamp(target, c);
}

export function goalImpact(registry: Registry, goalId: string) {
  const tasks = registry.tasks.filter((item) => item.goal_id === goalId);
  const taskIds = new Set(tasks.map((item) => item.id));
  const plans = registry.plans.filter((item) => taskIds.has(item.target_ref.id) || registry.habits.some((habit) => habit.goal_id === goalId && habit.id === item.target_ref.id));
  const followups = (registry.followups ?? []).filter((item) => item.issue.task_id ? taskIds.has(item.issue.task_id) : false);
  return { tasks, plans, followups };
}

export function applyGoalAction(registry: Registry, action: Action, c: GoalContext): string[] | null {
  if (!["create_goal", "update_goal", "activate_goal", "pause_goal", "complete_goal", "abandon_goal", "add_milestone", "record_goal_decision"].includes(action.type)) return null;
  if (!registry.goals) registry.goals = [];
  if (action.type === "create_goal") {
    const created = createGoal(action, c);
    registry.goals.push(created);
    return [created.id];
  }
  const target = goal(registry, action.target_id);
  checkVersion(target, action);
  if (action.type === "update_goal") {
    revise(target, action, c);
    return [target.id];
  }
  requireAuthorized(c);
  if (action.type === "activate_goal") {
    if (!target.problem || !target.desired_outcome || !target.acceptance.length) throw new AppError("GOAL_INCOMPLETE", "目标缺少问题、结果或验收条件");
    if (target.status === "achieved" || target.status === "abandoned" || target.status === "superseded") throw new AppError("GOAL_TERMINAL", "已结束的目标不能激活", 409);
    target.status = "active";
  } else if (action.type === "pause_goal") {
    if (!activeOrProposed(target.status)) throw new AppError("GOAL_TERMINAL", "已结束的目标不能暂停", 409);
    target.status = "paused";
  } else if (action.type === "abandon_goal") {
    if (target.status === "achieved") throw new AppError("GOAL_TERMINAL", "已完成的目标不能放弃", 409);
    target.status = "abandoned";
  } else if (action.type === "complete_goal") {
    if (target.status !== "active" && target.status !== "paused") throw new AppError("GOAL_NOT_ACTIVE", "只有进行中的目标可以完成", 409);
    const evidence = list(action.completion_evidence, "完成证据", 12, 500);
    if (!evidence.length) throw new AppError("GOAL_EVIDENCE_REQUIRED", "完成目标需要可核对的证据");
    target.completed_evidence = evidence;
    target.status = "achieved";
  } else if (action.type === "add_milestone") {
    if (!activeOrProposed(target.status)) throw new AppError("GOAL_TERMINAL", "已结束的目标不能添加阶段", 409);
    const milestone: Milestone = {
      id: id("milestone"),
      version: 1,
      created_at: c.now,
      updated_at: c.now,
      last_operation_id: c.operation,
      outcome: text(action.milestone_outcome, "阶段结果"),
      acceptance: criteria(action.milestone_acceptance, "阶段验收"),
      sequence: Number.isInteger(action.sequence) && Number(action.sequence) >= 0 ? Number(action.sequence) : target.milestones.length,
      depends_on: list(action.depends_on, "阶段依赖", 12, 100),
      status: "planned",
    };
    target.milestones.push(milestone);
    stamp(target, c);
    return [target.id, milestone.id];
  } else if (action.type === "record_goal_decision") {
    if (!activeOrProposed(target.status)) throw new AppError("GOAL_TERMINAL", "已结束的目标不能新增决策记录", 409);
    const options = list(action.decision_options, "决策选项", 12, 500);
    if (options.length < 2) throw new AppError("INVALID_DECISION", "至少需要比较两个选项");
    const chosen = text(action.decision_chosen, "已选方案", 500);
    if (!options.includes(chosen)) throw new AppError("INVALID_DECISION", "已选方案必须来自比较选项");
    target.decision_log.push({
      id: id("decision"),
      at: c.now,
      question: text(action.decision_question, "决策问题", 1000),
      context: list(action.decision_context, "决策背景", 20, 500),
      options,
      chosen,
      rationale: text(action.decision_rationale, "选择理由", 2000),
      rejected: list(action.decision_rejected, "未选方案", 12, 500),
      valid_until: action.decision_valid_until == null ? null : String(action.decision_valid_until),
      source: c.source,
    });
    stamp(target, c);
    return [target.id];
  }
  stamp(target, c);
  return [target.id];
}

export function validateGoalCase(value: unknown): value is GoalCase {
  const item = value as GoalCase;
  return !!item && typeof item === "object" && typeof item.id === "string" && typeof item.title === "string" &&
    GOAL_STATUSES.includes(item.status) && Array.isArray(item.acceptance) && Array.isArray(item.milestones) &&
    item.milestones.every((milestone) => MILESTONE_STATUSES.includes(milestone.status));
}
