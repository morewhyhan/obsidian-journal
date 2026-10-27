import { AppError, type Action } from "./types.js";

const target="target_id expected_version";
const habit="title min_behavior minimum_quantity optional_target status note_refs recurrence anchor reminder_mode";
const task="title outcome acceptance due_at verification status parent_task_id supporting_habit_ids note_refs planning";
const automation="title kind timezone due_at delay_seconds schedule body to_diary strict";
const window="kind window_start window_end available_windows duration_minutes next_action";
// Shared by the published tool schema and the application boundary. A field
// valid for one command must not be silently ignored by another command.
export const actionFields: Record<string,string[]> = Object.fromEntries(Object.entries({
  create_habit:habit, update_habit:target+" "+habit,
  create_task:task+" initial_plan", update_task:target+" "+task,
  report_habit:target+" business_date status quantity optional_target_met performed_at",
  report_event:target+" event_key business_date",
  update_task_progress:target+" criterion_id value unit mode status report task_status verification_pending",
  complete_task:target+" report performed_at business_date", reopen_task:target+" report performed_at business_date",
  schedule:target+" "+window+" allow_reflow overdue_recovery business_date", reschedule:target+" "+window+" overdue_recovery",
  pause_contact:"target_id ends_at", resume_contact:"target_id", cancel_item:target,
  remember_fact:"fact kind", link_diary:target+" path label", project_diary:target,
  set_personal_rule:"key value starts_at ends_at expected_rules_revision",
  control_rule:target+" enabled kind expected_rules_revision", undo_rule:target+" expected_rules_revision",
  create_automation:automation, update_automation:target+" "+automation,
  control_automation:target+" control ends_at", report_automation:target+" business_date occurrence_id report to_diary",
  start_focus:"task_ref work_minutes break_minutes rounds",
  pause_focus:target, resume_focus:target, stop_focus:target,
  set_period_focus:"kind business_date content base_hash replace_section",
  set_planning:"preferences expected_planning_version", configure_task:target+" planning",
  report_execution:target+" execution next_action remaining_minutes blocker effort_minutes report plan_id performed_at business_date",
  plan_day:"business_date",
  reject_proposal:target,
  save_work:target+" work", control_work:target+" control",
}).map(([type,fields])=>[type,["type",...fields.split(" ")]]));

export function validateActionFields(action: Action) {
  const fields=actionFields[action.type];
  if (!fields) throw new AppError("ACTION_UNSUPPORTED","不支持此业务操作");
  const unexpected=Object.keys(action).filter(k=>!fields.includes(k));
  if (unexpected.length) throw new AppError("ACTION_FIELD_UNSUPPORTED", "此操作不接受字段："+unexpected.join("、"));
}
