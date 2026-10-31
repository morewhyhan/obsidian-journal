import fs from "node:fs";
import { DateTime } from "luxon";
import { Lease, withDeadline } from "./deadline.js";
import {
  AppError,
  type Action,
  type Execution,
  type Input,
  type Source,
  type Registry,
  type Proposal,
} from "../../packages/contracts/types.js";
import {
  applyActions,
  verificationKey,
} from "../../packages/domain/actions.js";
import {
  localDate,
  route,
  type Period,
} from "../../packages/calendar/index.js";
import { atomicWrite, hash, id, canonicalJson } from "./files.js";
import { Store } from "./store.js";
import { DocumentOperations } from "./document-operations.js";
import { applicationCapabilities } from "./application.js";
import { Coordinator } from "./coordinator.js";
import { AssistantRuntime } from "./assistant.js";
import { policyStamp } from "./tool-effects.js";
import { reconcileWork, wakeOnFeedback } from "./work-checks.js";
import { searchFacts, readFacts, appendFactTo, forgetFactTo, cleanupRevokedFragments, factsDigest, activeFacts, scrubLegacyUserNotes } from "./facts.js";
import { recordFactUsage, applyFactUsage } from "./fact-usage.js";
import { publishInterpretation, understoodSeq, validateInterpretation } from "./classification.js";
import type { RevocationRecord } from "./facts.js";
import type { FactDraft, FactFile } from "../../packages/contracts/facts.js";
import { requireCapability } from "./policy.js";
import { advanceOwnReads } from "./read-stamps.js";
import {workInputSchema} from "../../packages/contracts/work.js";
import { advanceOwnGrant,checkBackgroundActions } from "./background-grant.js";
import { quietHours } from "../../packages/domain/assistant.js";
import { processNativeInput, nativeSession } from "./agent-runtime.js";
import { selectedProposalActions, decideProposal } from "../../packages/domain/decisions.js";
import {
  discussionOnly,
  proposalRequested,
  confirmation,
  requestActionTypes,
  explicitCommitment,
  literalReportText,
} from "./conversation.js";
import {
  bind,
  checkboxActions,
  createPeriod,
  project,
  prepareAutomaticBindings,
  patchFocus,
  focusHeadings,
} from "./journal.js";
export type AgentResult = {
  action_groups: { action_identity: string; actions: Action[] }[];
  clarification: string | null;
  reply_intent: string;
  summary?: string;
  discussion?: string;
  language_review?: string;
};
export interface AgentAdapter {
  executionMode?: "tools-v2";
  interpret(input: Input, context: unknown): Promise<AgentResult>;
  compose?(facts: unknown): Promise<{ text: string }>;
  /**
   * C2 understanding for accepted-but-unread inputs. Optional: without it the
   * gate stays fail-closed (any newer unclassified input holds older writes).
   */
  classify?(inputs: { id: string; text: string; occurred_at: string }[]): Promise<{
    items: { input_id: string; interpretation: unknown }[];
  } | null>;
  close?(): void;
}


function quietAt(value: DateTime, config: Store["config"]) {
  const time = value.setZone(config.timezone).toFormat("HH:mm"),
    quiet = config.notifications.quiet_hours;
  return quiet.start > quiet.end
    ? time >= quiet.start || time < quiet.end
    : time >= quiet.start && time < quiet.end;
}

function entirelyQuiet(start: string, end: string, config: Store["config"]) {
  const from = DateTime.fromISO(start, { setZone: true }),
    to = DateTime.fromISO(end, { setZone: true }),
    last = to.minus({ milliseconds: 1 });
  if (!from.isValid || !to.isValid || to <= from) return false;
  // A schedule may be longer than the configured quiet period. In that case
  // it necessarily contains an allowed instant even if both endpoints look
  // quiet.
  const quietMinutes = (() => {
    const start = DateTime.fromFormat(
      config.notifications.quiet_hours.start,
      "HH:mm",
      {
        zone: config.timezone,
      },
    );
    let end = DateTime.fromFormat(
      config.notifications.quiet_hours.end,
      "HH:mm",
      {
        zone: config.timezone,
      },
    );
    if (end <= start) end = end.plus({ days: 1 });
    return end.diff(start, "minutes").minutes;
  })();
  return (
    to.diff(from, "minutes").minutes <= quietMinutes &&
    quietAt(from, config) &&
    quietAt(last, config)
  );
}

export class Core {
  assistant: AssistantRuntime;
  coordinator: Coordinator;
  documents: DocumentOperations;
  subscribers = new Set<(event: { type: string; data: unknown }) => void>();
  agent?: AgentAdapter;
  summaryError: string | null = null;
  /** A turn lease, not a boolean: a hung turn expires instead of starving the queue. */
  readonly turnLease = new Lease("turn", 150_000);
  /** A single turn may not hold the queue longer than this. */
  turnDeadlineMs = 45_000;
  private foregroundStreak=0;
  operationKey(input:Input,actions:Action[],identity:string) {
    const literal=literalReportText(input.text);
    const normalized=literal !== null && actions.length === 1 && actions[0].type === "report_automation"
      ? [{...actions[0],report:literal}] : actions;
    return input.id+":"+hash(canonicalJson(normalized))+(identity.startsWith("native-group:") ? ":"+hash(identity) : "");
  }
  private stopping = false;
  private idle: Promise<void> = Promise.resolve();
  private releaseIdle?: () => void;
  get working() {
    return this.turnLease.held;
  }
  constructor(public store: Store) {
    this.documents = new DocumentOperations(store);
    this.coordinator = new Coordinator(this);
    this.assistant = new AssistantRuntime(this);
    this.recoverPending();
    this.recoverInterruptedInputs();
    try {
      // Finish any revocation cleanup left pending by an earlier run.
      this.cleanupRevocations();
    } catch {
      /* The receipt keeps reporting "清理待完成"; never claim an unverified erase. */
    }
  }
  inputEffects(inputId: string) {
    const events = this.store.db.prepare(
      "SELECT kind,status,payload_json FROM events WHERE input_id=? AND kind IN ('business','tool_effect') ORDER BY rowid",
    ).all(inputId) as any[];
    const applied = events.filter((e) => e.status === "applied").flatMap((e) => {
      const p = JSON.parse(e.payload_json);
      return e.kind === "business"
        ? p.result?.updated_ids?.length ? [p.result.message || "业务记录已保存"] : []
        : [(({write:"笔记写入",edit:"笔记更新",rename:"笔记改名",delete:"笔记移入回收站",
            create_period:p.result?.existing ? "确认已有周期笔记" : "按模板创建周期笔记",
            restore_note:"恢复笔记",restore_version:"恢复笔记版本"} as Record<string,string>)[p.operation] ?? "笔记操作")
            + (p.path ? "：" + p.path : "") + (p.result?.warnings?.length ? "；"+p.result.warnings.slice(0,3).join("；") : "")];
    });
    const uncertain = events.some((e) => e.kind === "tool_effect" && ["prepared", "failed"].includes(e.status));
    return { applied, uncertain };
  }
  private recoverInterruptedInputs() {
    const rows = this.store.db.prepare(
      "SELECT * FROM inbox WHERE status='pending' AND channel<>'coordinator' AND json_extract(metadata_json,'$.interrupted')=1",
    ).all() as any[];
    for (const row of rows) {
      if (JSON.parse(row.metadata_json).agent_execution === "tools-v2") continue;
      const effects = this.inputEffects(row.id);
      const text = effects.applied.length || effects.uncertain
        ? "上次处理被中断，未重放操作。" +
          (effects.applied.length ? "已保存：" + effects.applied.join("；") + "。" : "") +
          (effects.uncertain ? "有文件操作未取得最终回执，需要检查当前文件；其余部分未继续执行。" : "其余部分未继续执行。")
        : "上次处理被中断，尚无已保存的业务变更；原安排保留。";
      this.store.db.prepare("UPDATE inbox SET status='failed',processed_at=?,error_code='INPUT_INTERRUPTED',metadata_json=json_set(metadata_json,'$.reply',?) WHERE id=?")
        .run(this.store.now(), text, row.id);
      if (row.channel === "qq") this.queueReply({ ...row, actor_ref: row.actor_ref } as Input, text);
    }
  }
  recoverPending() {
    const store = this.store;
    store.recover();
    this.documents.recover();
    this.recoverDocumentSaves();
    this.recoverCheckboxes();
    const unprojected = store.db
      .prepare(
        "SELECT * FROM events e WHERE kind='business' AND status='applied' AND json_array_length(payload_json,'$.result.updated_ids')>0 AND NOT EXISTS (SELECT 1 FROM events p WHERE p.parent_id=e.id AND p.kind='diary_projection')",
      )
      .all() as any[];
    const missingMemory = store.db
      .prepare(
        "SELECT * FROM events e WHERE kind='business' AND status='applied' AND NOT EXISTS (SELECT 1 FROM events m WHERE m.parent_id=e.id AND m.kind='memory_derivation')",
      )
      .all() as any[];
    for (const event of [...unprojected, ...missingMemory]) {
      const ids = JSON.parse(event.payload_json).result?.updated_ids ?? [];
      for (const [kind, suffix] of [["diary_projection", ":projection"], ["memory_derivation", ":memory"]] as const) {
        if (kind === "diary_projection" && !unprojected.includes(event)) continue;
        const id = event.id + suffix;
        store.db
          .prepare(
            "INSERT OR IGNORE INTO events(id,dedupe_key,input_id,parent_id,source,kind,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(id, id, event.input_id, event.id, "core", kind, JSON.stringify({ target_ids: ids }), store.now());
      }
    }
    this.flushProjections();
    this.flushPeriodProjections();
    this.flushMemoryDerivations();
    this.flushWorkReconcile();
    this.flushReminderValidity();
    if (unprojected.length)
      this.emit("item_changed", {
        ids: [
          ...new Set(
            unprojected.flatMap(
              (event) =>
                JSON.parse(event.payload_json).result?.updated_ids ?? [],
            ),
          ),
        ],
      });
    this.rebuildSummary();
  }
  rebuildSummary(strict = false) {
    try {
      const registry = this.store.registry(),
        date = localDate(this.store.clock(), this.store.config.timezone),
        record = this.store.day(date),
        // Every source that can invalidate this derivative belongs in the key:
        // a corrected or forgotten fact must make the summary stale, not "current".
        source =
          "registry:" +
          registry.revision +
          ";day:" +
          date +
          ":" +
          record.revision +
          ";facts:" +
          factsDigest(this.store) +
          ";revocations:" +
          this.store.revocationRevision(),
        file = this.store.files.resolve(
          ".agent/context/current.md",
          "internal",
        );
      if (
        fs.existsSync(file) &&
        fs.readFileSync(file, "utf8").includes("<!-- " + source + " -->")
      )
        return;
      const liveFacts = activeFacts(this.store, this.store.now()),
        active = registry.habits.filter((h) => h.status === "active"),
        tasks = registry.tasks.filter((t) =>
          ["ready", "in_progress", "blocked"].includes(t.status),
        ),
        pause = registry.controls
          .filter((p) => p.scope === "global" && p.ends_at > this.store.now())
          .sort((a, b) => b.ends_at.localeCompare(a.ends_at))[0];
      atomicWrite(
        file,
        "# 当前状态\n\n<!-- " +
          source +
          " -->\n更新时间：" +
          this.store.now() +
          "\n\n有效习惯 " +
          active.length +
          " 项；未结束任务 " +
          tasks.length +
          " 项。\n当天已确认发生 " +
          record.occurrences.filter((o) => o.status === "did").length +
          " 次。\n有效长期事实 " +
          liveFacts.length +
          " 条（已撤销的不再计入）。\n" +
          (pause ? "当前暂停主动联系，至 " + pause.ends_at + "。\n" : "") +
          "\n来源：`.agent/state/registry.json`" +
          (record.revision ? "、`" + this.store.dayPath(date) + "`" : "") +
          "。\n此文件为可重建摘要，具体事实以来源文件为准。\n",
      );
      this.summaryError = null;
    } catch (error) {
      if (strict) throw error;
      this.summaryError = "CONTEXT_SUMMARY_FAILED";
    }
  }
  emit(type: string, data: unknown) {
    for (const cb of this.subscribers) {
      try {
        cb({ type, data });
      } catch {
        this.subscribers.delete(cb);
      }
    }
  }
  source(input: Input): Source {
    const receipt = this.store.db
      .prepare("SELECT received_at FROM inbox WHERE id=?")
      .get(input.id) as { received_at: string } | undefined;
    return {
      input_id: input.id,
      channel: input.channel,
      external_id: input.external_id,
      accepted_at: receipt?.received_at ?? this.store.now(),
      summary: input.text.slice(0, 250),
    };
  }
  async execute(
    input: Input,
    actions: Action[],
    identity: string,
    authorized = true,
    logicalGroups: import("../../packages/contracts/types.js").OperationGroupRef[] = [],
    authorize?:()=>unknown,
  ): Promise<Execution> {
    const literal = literalReportText(input.text);
    if (literal !== null && actions.length === 1 && actions[0].type === "report_automation")
      actions = actions.map((a) => a.type === "report_automation" ? { ...a, report: literal } : a);
    // Identity covers every field and the action order. A title/type alone
    // cannot distinguish two legitimate operations in the same message.
    const executionKey = this.operationKey(input,actions,identity);
    return this.store.exclusive(() => {
      requireCapability(this.store,input.channel==="coordinator"?"background_write":"business_write");
      authorize?.();
      const run = this.store.db.prepare("SELECT metadata_json FROM inbox WHERE id=?").get(input.id) as any;
      if (run && JSON.parse(run.metadata_json).agent_execution === "tools-v2") nativeSession(this, input.id, true);
      if(input.channel==="coordinator" && run && JSON.parse(run.metadata_json).background_grant)checkBackgroundActions(this.store,input.id,actions);
      this.recoverPending();
      const verified = new Map<string, Source>();
      const verificationActions = actions.flatMap((action) =>
        action.type === "accept_proposal"
          ? (() => { const p = this.store.registry().proposals.find(p => p.id === action.target_id);
              return p ? selectedProposalActions(action, p).selected : []; })()
          : [action],
      );
      for (const action of verificationActions) {
        if(action.type==="save_work") {
          const parsed=workInputSchema.safeParse(action.work);
          if(!parsed.success)throw new AppError("WORK_INVALID","工作引用或完成条件无效");
          for(const ref of parsed.data.refs??[])if(ref.kind==="note" && ref.path)this.store.files.resolve(ref.path);
        }
        if(action.type==="control_work" && action.control==="complete" && input.channel!=="coordinator" && authorized) {
          const f=this.store.registry().followups?.find(f=>f.id===action.target_id),w=f?.work;
          if(w?.done_when?.kind==="user_confirmed") {
            const resultPath=w.done_when.path;
            const ref=w.refs?.find(ref=>ref.path===resultPath && ref.role==="output");
            if(ref?.path && ref.hash)try {
              const actual=hash(this.store.files.read(ref.path));
              if(ref.hash===actual)verified.set("work:"+f!.id+":"+w.step_id,{...this.source(input),external_id:actual});
            }catch{/* A missing or changed preparation cannot be confirmed as the old result. */}
          }
        }
        if (action.type !== "complete_task") continue;
        const task = this.store
          .registry()
          .tasks.find((t) => t.id === action.target_id);
        for (const criterion of task?.acceptance ?? []) {
          if (
            criterion.verification !== "tool" ||
            criterion.kind !== "artifact" ||
            !criterion.artifact_ref ||
            !criterion.artifact_check
          )
            continue;
          try {
            const bytes = this.store.files.readBytes(
              criterion.artifact_ref,
              criterion.artifact_ref.startsWith("Attachment/")
                ? "attachment"
                : "document",
              this.store.config.web.max_attachment_bytes,
            );
            if (bytes.length>0) {
              if (criterion.artifact_check.kind === "contains_all" &&
                !criterion.artifact_check.terms.every((term) => bytes.toString("utf8").includes(term))) continue;
              verified.set(verificationKey(task!.id, criterion), {
                input_id: input.id,
                channel: "tool:artifact_check",
                external_id: hash(bytes),
                accepted_at: this.store.now(),
                summary: criterion.artifact_check.kind === "exists_nonempty" ? "仅核验约定文件存在且非空" : "已核验约定文件包含全部指定文本",
              });
            }
          } catch {
            /* Only the registered workspace artifact checker can grant verification. */
          }
        }
      }
      // Filled during prepare, consumed after the commit for the legacy-note scrub.
      const legacyContents: string[] = [];
      let workSource = this.source(input);
      let workReconcileError: string | null = null;
      // A replay of an interrupted commit can land the tombstone from inside
      // this call and then abort it; the finally below retries any pending marker
      // so the note never lags behind the revocation.
      let result: any;
      let revocationCleanup: any = null;
      try {
        result = this.store.commit(
        executionKey,
        input.channel,
        input.id,
        (registry, loadDay, operation, _rememberFact) => {
          if (actions.length > 20)
            throw new AppError("BATCH_TOO_LARGE", "一次最多20个动作");
          let stagedFacts: FactFile | null = null;
          const revocations: RevocationRecord[] = [];
          const currentFacts = () => stagedFacts ?? readFacts(this.store);
          const factSource = () => ({ kind: "input" as const, id: input.id, channel: input.channel, at: this.store.now() });
          const rememberFact = (fact: string, meta?: Omit<FactDraft, "content">) => {
            stagedFacts = appendFactTo(
              currentFacts(),
              { content: fact, kind: meta?.kind ?? "user_reported", ...meta },
              factSource(),
              this.store.now(),
            );
          };
          const forgetFact = (targetId: string, expectedVersion: number) => {
            const { file, revocation, legacy_content } = forgetFactTo(
              this.store, currentFacts(), targetId, expectedVersion, this.store.now(),
            );
            stagedFacts = file;
            revocations.push(revocation);
            if (legacy_content) legacyContents.push(legacy_content);
            return revocation;
          };
          workSource = this.source(input);
          const context = {
            operation,
            source: workSource,
            now: this.store.now(),
            zone: this.store.config.timezone,
            loadDay,
            userAuthorized: authorized,
            rememberFact,
            forgetFact,
            verified,
            planningDefaults: this.store.config.planning,
            quietDefaults: this.store.config.notifications.quiet_hours,
            validateNoteRef: (relative: string) => {
              this.store.files.read(relative);
            },
          };
          const acceptedProposals: string[] = [];
          const expanded = actions.flatMap((action) => {
            if (["reject_proposal","defer_proposal"].includes(action.type)) {
              const proposal = registry.proposals.find(p => p.id === action.target_id);
              if (!proposal || proposal.version !== action.expected_version || proposal.status !== "pending" || proposal.expires_at <= this.store.now())
                throw new AppError("PROPOSAL_EXPIRED", "建议已变化或过期", 409);
              decideProposal(proposal, action, context);
              acceptedProposals.push(proposal.id);
              return [];
            }
            if (action.type !== "accept_proposal") return [action];
            const proposal = registry.proposals.find(
              (p) => p.id === action.target_id,
            );
            if (
              !proposal ||
              proposal.version !== action.expected_version ||
              proposal.status !== "pending" ||
              proposal.expires_at <= this.store.now()
            )
              throw new AppError("PROPOSAL_EXPIRED", "建议已变化或过期", 409);
            const selection = decideProposal(proposal, action, context);
            if (selection.selected.some((a) => ["accept_proposal", "reject_proposal", "link_diary", "project_diary", "pending_diary_binding"].includes(a.type)))
              throw new AppError("AGENT_INVALID", "不允许嵌套接受提案");
            acceptedProposals.push(proposal.id);
            return selection.selected;
          });
          const seen = new Set<string>();
          const effective =
            acceptedProposals.length > 1
              ? expanded.filter((a) => {
                  const key = canonicalJson(a);
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                })
              : expanded;
          if (effective.length > 20)
            throw new AppError(
              "BATCH_TOO_LARGE",
              "合并后超过单次20项，整批未执行；需要先缩小这批建议",
              422,
            );
          const baseVersions = new Map(
            [...registry.habits, ...registry.tasks].map((item) => [
              item.id,
              item.version,
            ]),
          );
          const ordinary = effective.filter(
            (a) =>
              !["link_diary", "project_diary", "set_period_focus"].includes(
                a.type,
              ),
          );
          const output = applyActions(registry, ordinary, context);
          // A user report naming the watched object wakes that work immediately.
          for (const id of wakeOnFeedback(registry, ordinary, this.store.now(), operation))
            if (!output.ids.includes(id)) output.ids.push(id);
          if (!acceptedProposals.length)
            for (const p of registry.proposals) {
              if (
                p.status === "pending" &&
                canonicalJson(p.actions) === canonicalJson(effective)
              ) {
                p.status = "cancelled";
                p.version++;
                p.updated_at = this.store.now();
                p.last_operation_id = operation;
              }
            }
          const coordinated = this.coordinator.afterActions(
            registry,
            loadDay,
            operation,
            context.source,
            ordinary.map((a) => {
              const key =
                a.type === "set_personal_rule"
                  ? String(a.key)
                  : ["control_rule", "undo_rule"].includes(a.type)
                    ? registry.user_rules?.find((x) => x.id === a.target_id)
                        ?.key
                    : null;
              return key?.startsWith("planning.")
                ? {
                    type: "set_planning",
                    preferences: { [key.slice(9)]: null },
                  }
                : a;
            }),
          );
          output.ids.push(...coordinated.ids);
          if (coordinated.message)
            output.message += " " + coordinated.message + "。";
          for (const action of effective.filter(
            (a) => a.type === "project_diary",
          )) {
            const version = baseVersions.get(String(action.target_id));
            if (
              version === undefined ||
              (action.expected_version !== undefined &&
                action.expected_version !== version)
            )
              throw new AppError("VERSION_CONFLICT", "事项已变化", 409);
            output.ids.push(String(action.target_id));
          }
          const created = ordinary.filter(
            (a) => a.type === "create_habit",
          ).length;
          const changedPlans = registry.plans.filter((p) =>
            output.ids.includes(p.id),
          );
          const scheduledTargets = changedPlans.map((p) => p.target_ref.id);
          if (created || changedPlans.length) {
            const today = localDate(
              this.store.clock(),
              this.store.config.timezone,
            );
            const dates = new Set([
              today,
              ...changedPlans
                .map((p) =>
                  localDate(
                    new Date(p.window_start),
                    this.store.config.timezone,
                  ),
                )
                .filter((d) => d >= today),
            ]);
            for (const date of dates)
              prepareAutomaticBindings(
                registry,
                this.store,
                date,
                [...output.ids, ...scheduledTargets],
                operation,
              );
          }
          output.ids.push(...acceptedProposals);
          for (const a of effective.filter((a) => a.type === "link_diary")) {
            const link = bind(
              registry,
              this.store,
              String(a.target_id),
              String(a.path),
              String(a.label),
              context.source,
              operation,
            );
            output.ids.push(link.target_ref.id);
          }
          const periods = effective
            .filter((a) => a.type === "set_period_focus")
            .map((a) => {
              if (!authorized)
                throw new AppError(
                  "NEEDS_CONFIRMATION",
                  "重点变更需要明确接受",
                );
              if (
                !["yearly", "quarterly", "monthly", "weekly"].includes(
                  String(a.kind),
                ) ||
                typeof a.content !== "string" ||
                !a.content.trim() ||
                a.content.length > 2000
              )
                throw new AppError("INVALID_FIELD", "需要明确周期与简短重点");
              const kind = a.kind as Period,
                date = String(a.business_date),
                p = createPeriod(this.store, kind, date).path,
                raw = this.store.files.read(p);
              if (hash(raw) !== a.base_hash)
                throw new AppError(
                  "VERSION_CONFLICT",
                  "周期笔记已变化，保留原文",
                  409,
                );
              return {
                path: p,
                heading: focusHeadings[kind],
                base_hash: hash(raw),
                target_hash: hash(
                  patchFocus(
                    raw,
                    focusHeadings[kind],
                    a.content,
                    a.replace_section === true,
                  ),
                ),
                content: a.content,
                replace: a.replace_section === true,
              };
            });
          // Work coordination is a consumer like the projections: a failure must
          // not roll back an already-validated business change, it must be retried.
          try {
            output.ids.push(...reconcileWork(this.store,registry,operation,context.source));
          } catch (error) {
            workReconcileError = (error as any)?.code ?? "WORK_RECONCILE_FAILED";
          }
          return {
            ...output,
            ...(periods.length ? { effects: { periods } } : {}),
            ...(stagedFacts ? { facts: stagedFacts } : {}),
            ...(revocations.length ? { revocations } : {}),
          };
        },
        logicalGroups,
      );
      } finally {
        try {
          if (
            this.store.db
              .prepare("SELECT 1 FROM revocations WHERE cleanup_state='pending' LIMIT 1")
              .get()
          )
            revocationCleanup = this.cleanupRevocations();
        } catch {
          /* cleanup stays pending and the next pass retries */
        }
      }
      // Revocation cleanup is part of the same responsibility: a receipt must not
      // report a finished forget while the original fragment is still readable.
      const forgotten = actions.filter((a) => a.type === "forget_fact").map((a) => String(a.target_id));
      if (forgotten.length) {
        // The finally above already ran the cleanup (once). Re-running it here
        // would report zero removals for work that just succeeded.
        const cleanup = revocationCleanup ?? this.cleanupRevocations(forgotten);
        // Rows written before the hash column existed have no marker to match by;
        // their body is still in memory for this call only.
        for (const legacy of legacyContents) cleanup.legacy_user_md_cleared += scrubLegacyUserNotes(this.store, legacy);
        (result as Record<string, unknown>).revocation_cleanup = cleanup;
      }
      this.store.db.transaction(() => {
        const workEventId = result.operation_id + ":work";
        this.store.db
          .prepare(
            "INSERT OR IGNORE INTO events(id,dedupe_key,input_id,parent_id,source,kind,payload_json,created_at,completed_at,status) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            workEventId,
            workEventId,
            input.id,
            result.operation_id,
            "core",
            "work_reconcile",
            JSON.stringify({
              target_ids: result.updated_ids,
              operation: result.operation_id,
              source: workSource,
            }),
            this.store.now(),
            workReconcileError ? null : this.store.now(),
            workReconcileError ? "prepared" : "applied",
          );
        const eventId = result.operation_id + ":projection";
        this.store.db
          .prepare(
            "INSERT OR IGNORE INTO events(id,dedupe_key,input_id,parent_id,source,kind,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            eventId,
            eventId,
            input.id,
            result.operation_id,
            "core",
            "diary_projection",
            JSON.stringify({ target_ids: result.updated_ids }),
            this.store.now(),
          );
        // Memory derivation is a consumer like any other: its failure is recorded
        // with a retry window instead of being swallowed by the rebuild.
        const memoryId = result.operation_id + ":memory";
        this.store.db
          .prepare(
            "INSERT OR IGNORE INTO events(id,dedupe_key,input_id,parent_id,source,kind,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            memoryId,
            memoryId,
            input.id,
            result.operation_id,
            "core",
            "memory_derivation",
            JSON.stringify({ target_ids: result.updated_ids }),
            this.store.now(),
          );
      })();
      if (actions.some((action) => action.type === "set_planning")) this.clearPlanningGap();
      this.flushProjections();
      this.flushPeriodProjections();
      this.flushMemoryDerivations();
      this.flushWorkReconcile();
      this.flushReminderValidity();
      const projectionWarnings: string[] = [];
      for (const a of actions.filter((x) => x.type === "report_automation"))
        this.assistant.queueReportDate(String(a.business_date));
      if (
        this.store.db
          .prepare(
            "SELECT 1 FROM events WHERE parent_id=? AND kind='period_projection' AND status='conflict'",
          )
          .get(result.operation_id)
      )
        projectionWarnings.push("周期重点尚未写入，原文已保留。");
      // Reminder invalidation is a consumer too: its failure must be retried, not
      // turned into a false failure of a commit that already applied.
      try {
        this.cancelInvalidContact();
        this.store.db
          .prepare(
            "INSERT OR IGNORE INTO events(id,dedupe_key,input_id,parent_id,source,kind,payload_json,created_at,completed_at,status) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            result.operation_id + ":reminders",
            result.operation_id + ":reminders",
            input.id,
            result.operation_id,
            "core",
            "reminder_validity",
            JSON.stringify({ operation: result.operation_id }),
            this.store.now(),
            this.store.now(),
            "applied",
          );
      } catch {
        this.store.db
          .prepare(
            "INSERT OR IGNORE INTO events(id,dedupe_key,input_id,parent_id,source,kind,payload_json,created_at,status) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            result.operation_id + ":reminders",
            result.operation_id + ":reminders",
            input.id,
            result.operation_id,
            "core",
            "reminder_validity",
            JSON.stringify({ operation: result.operation_id }),
            this.store.now(),
            "prepared",
          );
      }
      const nativeDates = new Set<string>();
      if (run && JSON.parse(run.metadata_json).agent_execution === "tools-v2") {
        const updated = new Set(result.updated_ids);
        for (const plan of this.store.registry().plans)
          if (["planned", "active"].includes(plan.status) && plan.window_end > this.store.now() &&
            (updated.has(plan.id) || updated.has(plan.target_ref.id)))
            nativeDates.add(DateTime.fromISO(plan.window_start).setZone(this.store.config.timezone).toISODate()!);
        for (const action of verificationActions) {
          if (action.type === "report_habit" && typeof action.business_date === "string") nativeDates.add(action.business_date);
          if (["create_habit", "update_habit"].includes(action.type))
            nativeDates.add(localDate(this.store.clock(), this.store.config.timezone));
        }
      }
      for (const date of new Set([
        ...nativeDates,
        ...verificationActions
          .filter((a) => a.type === "plan_day")
          .map((a) => String(a.business_date)),
        DateTime.fromJSDate(this.store.clock(), {
          zone: this.store.config.timezone,
        })
          .plus({ days: 1 })
          .toISODate()!,
      ])) {
        try {
          this.coordinator.ensureDiary(date, nativeDates.has(date));
        } catch {
          projectionWarnings.push("安排已保存，模板笔记创建或绑定尚未成功，请检查模板。");
        }
      }
      this.rebuildSummary();
      this.emit("item_changed", { ids: result.updated_ids });
      if (
        actions.some((a) =>
          [
            "set_personal_rule",
            "control_rule",
            "undo_rule",
            "create_automation",
            "update_automation",
            "control_automation",
            "report_automation",
            "start_focus",
            "pause_focus",
            "resume_focus",
            "stop_focus",
          ].includes(a.type),
        )
      )
        result.message = this.assistant.receipt(actions, result.updated_ids);
      if (projectionWarnings.length) result.message += " " + projectionWarnings.join(" ");
      const projectionRows = this.store.db.prepare(
        "SELECT status FROM events WHERE (parent_id=? OR dedupe_key=?) AND kind IN ('diary_projection','period_projection')",
      ).all(result.operation_id, result.operation_id + ":projection") as {status:string}[];
      result.projection = {
        status: projectionWarnings.length || projectionRows.some(r=>r.status === "conflict") ? "conflict"
          : projectionRows.some(r=>r.status === "prepared") ? "pending" : "applied",
        warnings:projectionWarnings,
      };
      if (this.store.config.notifications.respect_quiet_hours_for_deadlines) {
        const config = {
          ...this.store.config,
          notifications: {
            ...this.store.config.notifications,
            quiet_hours: quietHours(
              this.store.registry(),
              this.store.config.notifications.quiet_hours,
              this.store.now(),
            ),
          },
        };
        const quietPlan = this.store
          .registry()
          .plans.find(
            (plan) =>
              result.updated_ids.includes(plan.id) &&
              entirelyQuiet(plan.window_start, plan.window_end, config),
          );
        if (quietPlan)
          result.message +=
            " 安排落在静默时段（" +
            config.notifications.quiet_hours.start +
            "–" +
            config.notifications.quiet_hours.end +
            "），按当前规则不会在该窗口发送提醒。";
      }
      if(run && JSON.parse(run.metadata_json).agent_execution==="tools-v2")advanceOwnReads(this.store,input.id);
      if(input.channel==="coordinator")advanceOwnGrant(this.store,input.id,result.updated_ids);
      return result;
    });
  }
  flushProjections() {
    // Prepared work is always attempted; a conflict waits for its next retry
    // window (bounded attempts) so a repaired template is picked up on restart.
    const events = (
      this.store.db
        .prepare(
          "SELECT * FROM events WHERE kind='diary_projection' AND status IN ('prepared','conflict') ORDER BY rowid",
        )
        .all() as any[]
    ).filter((event) => {
      if (event.status === "prepared") return true;
      const payload = JSON.parse(event.payload_json ?? "{}");
      return typeof payload.next_retry_at === "string" &&
        payload.next_retry_at <= this.store.now() &&
        Number(payload.attempts ?? 0) < 3;
    });
    for (const event of events) {
      try {
        const ids = JSON.parse(event.payload_json).target_ids;
        const paths = project(this.store, ids);
        for (const path of paths) {
          const document = this.store.document(path);
          this.emit("document_changed", {
            path,
            hash: document.hash,
            version: document.version,
          });
        }
        this.store.db
          .prepare(
            "UPDATE events SET status='applied',completed_at=? WHERE id=?",
          )
          .run(this.store.now(), event.id);
      } catch {
        const payload = JSON.parse(event.payload_json ?? "{}");
        const attempts = Number(payload.attempts ?? 0) + 1;
        this.store.db
          .prepare(
            "UPDATE events SET status='conflict',error_code='PROJECTION_CONFLICT',payload_json=? WHERE id=?",
          )
          .run(
            JSON.stringify({
              ...payload,
              attempts,
              next_retry_at: new Date(Date.parse(this.store.now()) + 5 * 60000).toISOString(),
            }),
            event.id,
          );
      }
    }
  }
  /** Retry for reminder invalidation recorded as a consumer. */
  flushReminderValidity() {
    const events = (
      this.store.db
        .prepare("SELECT * FROM events WHERE kind='reminder_validity' AND status IN ('prepared','conflict') ORDER BY rowid")
        .all() as any[]
    ).filter((event) => {
      if (event.status === "prepared") return true;
      const payload = JSON.parse(event.payload_json ?? "{}");
      return typeof payload.next_retry_at === "string" &&
        payload.next_retry_at <= this.store.now() &&
        Number(payload.attempts ?? 0) < 3;
    });
    for (const event of events) {
      try {
        this.cancelInvalidContact();
        this.store.db
          .prepare("UPDATE events SET status='applied',completed_at=? WHERE id=?")
          .run(this.store.now(), event.id);
      } catch {
        const payload = JSON.parse(event.payload_json ?? "{}");
        this.store.db
          .prepare("UPDATE events SET status='conflict',error_code='REMINDER_VALIDITY_FAILED',payload_json=? WHERE id=?")
          .run(
            JSON.stringify({
              ...payload,
              attempts: Number(payload.attempts ?? 0) + 1,
              next_retry_at: new Date(Date.parse(this.store.now()) + 5 * 60000).toISOString(),
            }),
            event.id,
          );
      }
    }
  }
  /** Work coordination confirmation/retry: a failed reconcile never blocks the commit. */
  flushWorkReconcile() {
    const events = (
      this.store.db
        .prepare("SELECT * FROM events WHERE kind='work_reconcile' AND status IN ('prepared','conflict') ORDER BY rowid")
        .all() as any[]
    ).filter((event) => {
      if (event.status === "prepared") return true;
      const payload = JSON.parse(event.payload_json ?? "{}");
      return typeof payload.next_retry_at === "string" &&
        payload.next_retry_at <= this.store.now() &&
        Number(payload.attempts ?? 0) < 3;
    });
    for (const event of events) {
      const payload = JSON.parse(event.payload_json ?? "{}");
      try {
        this.store.commit(
          event.id + ":retry",
          "core",
          event.id,
          (reg) => ({
            ids: reconcileWork(this.store, reg, payload.operation ?? event.id, payload.source),
            message: "工作协调已确认",
          }),
        );
        this.store.db
          .prepare("UPDATE events SET status='applied',completed_at=? WHERE id=?")
          .run(this.store.now(), event.id);
      } catch {
        const attempts = Number(payload.attempts ?? 0) + 1;
        this.store.db
          .prepare("UPDATE events SET status='conflict',error_code='WORK_RECONCILE_FAILED',payload_json=? WHERE id=?")
          .run(
            JSON.stringify({
              ...payload,
              attempts,
              next_retry_at: new Date(Date.parse(this.store.now()) + 5 * 60000).toISOString(),
            }),
            event.id,
          );
      }
    }
  }
  /** Consumer for derived memory/state text; retries like other projections. */
  flushMemoryDerivations() {
    // Fold pending fact-usage marks in here: this point is between turns, so the
    // facts file is safe to rewrite.
    try {
      applyFactUsage(
        this.store,
        () => readFacts(this.store),
        (file) =>
          atomicWrite(
            this.store.files.resolve(".agent/context/facts.json", "internal"),
            JSON.stringify(file, null, 1),
          ),
      );
    } catch {
      /* usage marks stay pending and are applied on a later pass */
    }
    const events = (
      this.store.db
        .prepare(
          "SELECT * FROM events WHERE kind='memory_derivation' AND status IN ('prepared','conflict') ORDER BY rowid",
        )
        .all() as any[]
    ).filter((event) => {
      if (event.status === "prepared") return true;
      const payload = JSON.parse(event.payload_json ?? "{}");
      return typeof payload.next_retry_at === "string" &&
        payload.next_retry_at <= this.store.now() &&
        Number(payload.attempts ?? 0) < 3;
    });
    if (!events.length) return;
    // One derived summary serves every pending event: a backlog (first start after
    // an upgrade) must not rewrite the same file once per historical commit.
    try {
      this.rebuildSummary(true);
      const now = this.store.now();
      const apply = this.store.db.transaction(() => {
        for (const event of events)
          this.store.db
            .prepare("UPDATE events SET status='applied',completed_at=? WHERE id=?")
            .run(now, event.id);
      });
      apply();
    } catch {
      const now = this.store.now();
      const fail = this.store.db.transaction(() => {
        for (const event of events) {
          const payload = JSON.parse(event.payload_json ?? "{}");
          this.store.db
            .prepare("UPDATE events SET status='conflict',error_code='MEMORY_CONFLICT',payload_json=? WHERE id=?")
            .run(
              JSON.stringify({
                ...payload,
                attempts: Number(payload.attempts ?? 0) + 1,
                next_retry_at: new Date(Date.parse(now) + 5 * 60000).toISOString(),
              }),
              event.id,
            );
        }
      });
      fail();
    }
  }
  private flushPeriodProjections() {
    const s = this.store;
    for (const event of s.db
      .prepare(
        "SELECT id,input_id,payload_json FROM events WHERE kind='business' AND status='applied' AND json_array_length(payload_json,'$.result.effects.periods')>0",
      )
      .all() as any[]) {
      const periods = JSON.parse(event.payload_json).result.effects
        .periods as any[];
      for (const [i, p] of periods.entries()) {
        const key = event.id + ":period:" + i;
        s.db
          .prepare(
            "INSERT OR IGNORE INTO events(id,dedupe_key,input_id,parent_id,source,kind,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            key,
            key,
            event.input_id,
            event.id,
            "core",
            "period_projection",
            JSON.stringify(p),
            s.now(),
          );
      }
    }
    // Same contract as other consumers: a conflict keeps a retry window instead of
    // getting stuck forever, so a note edited mid-projection is picked up later.
    for (const row of (
      s.db
        .prepare(
          "SELECT id,status,payload_json FROM events WHERE kind='period_projection' AND status IN ('prepared','conflict') ORDER BY rowid",
        )
        .all() as any[]
    ).filter((event) => {
      if (event.status === "prepared") return true;
      const payload = JSON.parse(event.payload_json ?? "{}");
      return typeof payload.next_retry_at === "string" &&
        payload.next_retry_at <= s.now() &&
        Number(payload.attempts ?? 0) < 3;
    })) {
      try {
        const p = JSON.parse(row.payload_json),
          raw = s.files.read(p.path),
          current = hash(raw);
        if (current === p.base_hash) {
          const updated = patchFocus(raw, p.heading, p.content, p.replace);
          if (hash(updated) !== p.target_hash)
            throw new Error("Projection mismatch");
          atomicWrite(s.files.resolve(p.path), updated);
          s.index(p.path);
          this.emit("document_changed", { path: p.path });
        } else if (current !== p.target_hash)
          throw new Error("Projection conflict");
        s.db
          .prepare(
            "UPDATE events SET status='applied',completed_at=? WHERE id=?",
          )
          .run(s.now(), row.id);
      } catch {
        const payload = JSON.parse(row.payload_json ?? "{}");
        s.db
          .prepare(
            "UPDATE events SET status='conflict',error_code='PROJECTION_CONFLICT',payload_json=? WHERE id=?",
          )
          .run(
            JSON.stringify({
              ...payload,
              attempts: Number(payload.attempts ?? 0) + 1,
              next_retry_at: new Date(Date.parse(s.now()) + 5 * 60000).toISOString(),
            }),
            row.id,
          );
      }
    }
  }
  cancelInvalidContact() {
    const registry = this.store.registry(),
      now = this.store.now();
    const rows = this.store.db
      .prepare(
        "SELECT id,target_refs_json,source_versions_json FROM outbox WHERE counts_as_proactive=1 AND status IN ('pending','failed')",
      )
      .all() as any[];
    for (const row of rows) {
      const refs = JSON.parse(row.target_refs_json) as any[];
      const versions = JSON.parse(row.source_versions_json);
      const changedPlan = registry.plans.some(
        (p) => versions[p.id] !== undefined && versions[p.id] !== p.version,
      );
      // A revocation after queueing invalidates the queued candidate, even when
      // every formal object it names still looks current.
      const revocationChanged =
        typeof versions.revocation === "number" &&
        versions.revocation !== this.store.revocationRevision();
      const invalid =
        changedPlan ||
        revocationChanged ||
        refs.some((ref) => {
          if(ref.kind==="work") {
            const f=registry.followups?.find(f=>f.id===ref.id);
            return !f?.work || f.status!=="waiting_user" || registry.controls.some(c=>c.starts_at<=now && c.ends_at>now &&
              (c.scope==="global"||c.target_id===f.id||f.work!.refs?.some(r=>r.id===c.target_id)));
          }
          if(ref.kind==="planning")return !this.coordinator.notices().some(n=>n.id===ref.id);
          if (ref.kind === "proposal") {
            const proposal = registry.proposals.find((p) => p.id === ref.id);
            return (
              !proposal ||
              proposal.status !== "pending" ||
              proposal.expires_at <= now
            );
          }
          if (["automation", "focus"].includes(ref.kind)) {
            const e =
              ref.kind === "automation"
                ? registry.automations?.find((a) => a.id === ref.id)
                : this.assistant.view().focus;
            return (
              !e ||
              versions[ref.id] !== e.version ||
              registry.controls.some(
                (c) =>
                  c.starts_at <= now &&
                  c.ends_at > now &&
                  (c.scope === "global" || c.target_id === ref.id),
              )
            );
          }
          const target =
            ref.kind === "habit"
              ? registry.habits.find((h) => h.id === ref.id)
              : registry.tasks.find((t) => t.id === ref.id);
          return (
            !target ||
            !["active", "ready", "in_progress"].includes(target.status) ||
            registry.controls.some(
              (p) =>
                p.starts_at <= now &&
                p.ends_at > now &&
                (p.scope === "global" || p.target_id === ref.id),
            ) ||
            (ref.kind === "habit" &&
              this.store
                .day(ref.business_date)
                .occurrences.some(
                  (o) => o.habit_id === ref.id && o.status !== "unreported",
                ))
          );
        });
      if (invalid)
        this.store.db
          .prepare(
            "UPDATE outbox SET status='cancelled',finished_at=?,updated_at=? WHERE id=?",
          )
          .run(now, now, row.id);
    }
  }
  private recoverCheckboxes() {
    const rows = this.store.db
      .prepare(
        "SELECT * FROM events WHERE kind='checkbox_save' AND status='prepared'",
      )
      .all() as any[];
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json);
      let exists = false;
      try {
        exists =
          hash(this.store.files.read(row.document_path)) === payload.new_hash;
      } catch {}
      if (exists) {
        this.store.commit(
          row.id + ":facts",
          "web",
          row.input_id,
          (r, d, operation) =>
            applyActions(r, payload.actions, {
              operation,
              source: payload.source,
              now: this.store.now(),
              zone: this.store.config.timezone,
              loadDay: d,
              userAuthorized: true,
            }),
        );
      }
      this.store.db
        .prepare("UPDATE events SET status=?,completed_at=? WHERE id=?")
        .run(exists ? "applied" : "cancelled", this.store.now(), row.id);
    }
    this.flushProjections();
  }
  private recoverDocumentSaves() {
    const rows = this.store.db
      .prepare(
        "SELECT * FROM events WHERE kind='document_save' AND status='prepared' ORDER BY rowid",
      )
      .all() as any[];
    for (const row of rows) {
      const data = JSON.parse(row.payload_json);
      let matches = false;
      try {
        const document = this.store.document(row.document_path);
        matches = document.hash === data.new_hash;
        if (matches)
          data.result = {
            path: document.path,
            hash: document.hash,
            version: document.version,
            updated_at: document.updated_at,
          };
      } catch {}
      this.store.db
        .prepare(
          "UPDATE events SET status=?,payload_json=?,completed_at=? WHERE id=?",
        )
        .run(
          matches ? "applied" : "cancelled",
          JSON.stringify(data),
          this.store.now(),
          row.id,
        );
    }
  }
  async saveDocument(
    relative: string,
    baseHash: string,
    content: string,
    requestId: string,
    authorize?:()=>void,
    afterWrite?:()=>void,
  ) {
    return this.store.exclusive(() => {
      requireCapability(this.store,"business_write");
      authorize?.();
      if (Buffer.byteLength(content) > this.store.config.web.max_document_bytes)
        throw new AppError("DOCUMENT_TOO_LARGE", "笔记过大", 413);
      const newHash = hash(content),
        saveKey = "document-save:" + requestId;
      let journaled = true;
      let previous: any;
      try {
        previous = this.store.db
          .prepare("SELECT * FROM events WHERE dedupe_key=?")
          .get(saveKey);
      } catch {
        journaled = false;
      }
      if (previous) {
        const data = JSON.parse(previous.payload_json);
        if (previous.document_path !== relative || data.new_hash !== newHash)
          throw new AppError(
            "IDEMPOTENCY_REUSED",
            "请求标识已用于其他内容",
            409,
          );
        if (previous.status === "applied") return { ...data.result, content };
      }
      const current = this.store.document(relative);
      if (current.hash !== baseHash)
        throw new AppError("DOCUMENT_CONFLICT", "笔记已变化，草稿已保留", 409, {
          hash: current.hash,
          version: current.version,
        });
      const input: Input = {
        id: requestId,
        channel: "web",
        actor_ref: "configured_user",
        external_id: requestId,
        text: "用户修改日记复选框",
        occurred_at: this.store.now(),
      };
      const actions = checkboxActions(
          this.store,
          relative,
          current.content,
          content,
        ),
        operation = id("save");
      if (!journaled && actions.length)
        throw new AppError(
          "RUNTIME_UNAVAILABLE",
          "复选框记录暂不可用，草稿已保留",
          503,
        );
      if (actions.length) {
        const days = new Map<string, ReturnType<Store["day"]>>();
        applyActions(structuredClone(this.store.registry()), actions, {
          operation: "validation-only",
          source: this.source(input),
          now: this.store.now(),
          zone: this.store.config.timezone,
          userAuthorized: true,
          loadDay: (date) => {
            if (!days.has(date))
              days.set(date, structuredClone(this.store.day(date)));
            return days.get(date)!;
          },
        });
      }
      if (journaled) {
        try {
          const payload = JSON.stringify({
            old_hash: baseHash,
            new_hash: newHash,
          });
          this.store.db
            .prepare(
              "INSERT INTO events(id,dedupe_key,input_id,source,kind,document_path,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO UPDATE SET status='prepared',payload_json=excluded.payload_json,completed_at=NULL",
            )
            .run(
              id("doc_save"),
              saveKey,
              requestId,
              "web",
              "document_save",
              relative,
              payload,
              this.store.now(),
            );
        } catch {
          if (actions.length)
            throw new AppError(
              "RUNTIME_UNAVAILABLE",
              "复选框记录暂不可用，草稿已保留",
              503,
            );
          journaled = false;
        }
      }
      if (actions.length)
        this.store.db
          .prepare(
            "INSERT INTO events(id,dedupe_key,input_id,source,kind,document_path,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            operation,
            requestId + ":checkbox:" + baseHash + ":" + hash(content),
            input.id,
            "web",
            "checkbox_save",
            relative,
            JSON.stringify({
              new_hash: hash(content),
              actions,
              source: this.source(input),
            }),
            this.store.now(),
          );
      atomicWrite(this.store.files.resolve(relative), content);
      this.store.fault?.("document_written");
      const next = this.store.document(relative);
      if (actions.length) {
        this.store.commit(operation + ":facts", "web", input.id, (r, d, op) =>
          applyActions(r, actions, {
            operation: op,
            source: this.source(input),
            now: this.store.now(),
            zone: this.store.config.timezone,
            loadDay: d,
            userAuthorized: true,
          }),
        );
        this.store.db
          .prepare(
            "UPDATE events SET status='applied',completed_at=? WHERE id=?",
          )
          .run(this.store.now(), operation);
      }
      if (journaled) {
        try {
          this.store.db
            .prepare(
              "UPDATE events SET status='applied',completed_at=?,payload_json=? WHERE dedupe_key=?",
            )
            .run(
              this.store.now(),
              JSON.stringify({
                old_hash: baseHash,
                new_hash: newHash,
                result: {
                  path: next.path,
                  hash: next.hash,
                  version: next.version,
                  updated_at: next.updated_at,
                },
              }),
              saveKey,
            );
        } catch {
          if (actions.length)
            throw new AppError(
              "RUNTIME_UNAVAILABLE",
              "正文已保存，复选框记录等待恢复",
              503,
            );
          journaled = false;
        }
      }
      this.emit("document_changed", {
        path: relative,
        hash: next.hash,
        version: next.version,
        request_id: requestId,
      });
      afterWrite?.();
      return {
        ...next,
        runtime_degraded: !journaled,
        pending_verifications: actions
          .filter((action) => action.verification_pending === true)
          .map((action) => action.target_id),
      };
    });
  }
  async newPeriod(kind: Period, date: string,authorize?:()=>unknown,afterWrite?:()=>void) {
    return this.store.exclusive(() => {
      authorize?.();
      const result = createPeriod(this.store, kind, date);
      if (
        kind === "daily" &&
        date >= localDate(this.store.clock(), this.store.config.timezone)
      ) {
        this.store.commit(
          "bind-new-day:" + date + ":" + hash(result.path),
          "web",
          id("day"),
          (registry, _, operation) => {
            const ids = [
              ...registry.habits
                .filter(
                  (h) =>
                    h.status === "active" &&
                    h.recurrence.weekdays.includes(
                      DateTime.fromISO(date).weekday,
                    ) &&
                    h.recurrence.starts_on <= date &&
                    (!h.recurrence.ends_on || h.recurrence.ends_on >= date),
                )
                .map((h) => h.id),
              ...registry.plans
                .filter(
                  (p) =>
                    DateTime.fromISO(p.window_start, {
                      zone: this.store.config.timezone,
                    }).toISODate() === date,
                )
                .map((p) => p.target_ref.id),
            ];
            prepareAutomaticBindings(
              registry,
              this.store,
              date,
              ids,
              operation,
            );
            return { ids, message: "当天展示已绑定" };
          },
        );
      }
      const registry = this.store.registry();
      project(
        this.store,
        registry.diary_links
          .filter((x) => x.path === result.path)
          .map((x) => x.target_ref.id),
      );
      this.emit("document_changed", { path: result.path });
      afterWrite?.();
      return result;
    });
  }
  async receive(input: Input) {
    this.store.state.requireWork();
    const received=this.store.now(),stamp=Date.parse(input.occurred_at);
    const payloadHash=hash(canonicalJson([input.text,input.occurred_at,input.reply_to??null]));
    if(!Number.isFinite(stamp) || !/(Z|[+-]\d\d:\d\d)$/i.test(input.occurred_at))
      throw new AppError("INPUT_TIME_INVALID","消息缺少可靠的带时区事件时间",400);
    if(input.channel!=="web" && input.channel!=="coordinator") {
      const clock=this.store.time.read();
      if(!clock.trusted)throw new AppError("CLOCK_UNTRUSTED","时间未核实，暂不接纳外部变更",503);
      const meta=this.store.runtimeMeta(),floor=Math.max(Date.parse(meta.replay_floor??"1970-01-01T00:00:00Z"),
        Date.parse(received)-this.store.config.channel.accept_window_seconds*1000,Date.parse(meta.restore_boundary??"1970-01-01T00:00:00Z"));
      if(stamp<floor || stamp>Date.parse(received)+this.store.config.channel.future_skew_seconds*1000)
        throw new AppError("INPUT_REPLAY_SUPPRESSED","事件超出接纳窗口，需要以新的消息重新交代",409);
      this.store.updateRuntimeMeta(m=>({...m,replay_floor:new Date(floor).toISOString()}));
    }
    if (
      input.channel !== "web" &&
      this.store.recoveryStartedAt &&
      Date.parse(input.occurred_at) <
        Date.parse(this.store.recoveryStartedAt) - 1000
    )
      throw new AppError(
        "INPUT_REPLAY_SUPPRESSED",
        "恢复前的渠道消息不自动重放",
        409,
      );
    if (
      input.channel !== "web" &&
      DateTime.fromISO(input.occurred_at) <
        DateTime.fromJSDate(this.store.clock()).minus({ days: 30 })
    )
      throw new AppError("INPUT_TOO_OLD", "不自动重放30天前的渠道事件", 400);
    const old = this.store.db
      .prepare(
        "SELECT id,body,occurred_at,metadata_json FROM inbox WHERE channel=? AND actor_ref=? AND external_id=?",
      )
      .get(input.channel, input.actor_ref, input.external_id) as any;
    if (old) {
      const oldHash=JSON.parse(old.metadata_json).payload_hash??(old.body!==null?hash(canonicalJson([old.body,old.occurred_at,JSON.parse(old.metadata_json).reply_to??null])):null);
      if(oldHash!==payloadHash)throw new AppError("INPUT_ID_CONFLICT","同一事件标识对应不同内容，未重复执行",409);
      return {id:old.id,duplicate:true};
    }
    if (
      Buffer.byteLength(input.text) > this.store.config.channel.max_input_bytes
    ) {
      if (input.channel !== "qq")
        throw new AppError("INPUT_TOO_LARGE", "消息过长，请使用笔记链接", 413);
      const text = "这条消息较长，暂未记入。请用一条简短交代或笔记链接。";
      this.store.db
        .prepare(
          "INSERT INTO inbox(id,channel,actor_ref,external_id,body,metadata_json,status,received_at,occurred_at,processed_at,error_code) VALUES(?,?,?,?,NULL,?,'failed',?,?,?,'INPUT_TOO_LARGE')",
        )
        .run(
          input.id,
          input.channel,
          input.actor_ref,
          input.external_id,
          JSON.stringify({ reply: text }),
          this.store.now(),
          input.occurred_at,
          this.store.now(),
        );
      this.queueReply(input, text);
      return { id: input.id, duplicate: false };
    }
    const queued = this.store.db
      .prepare(
        "SELECT count(*) AS n FROM inbox WHERE status IN ('pending','processing') AND channel<>'coordinator'",
      )
      .get() as { n: number };
    if (queued.n >= 10)
      throw new AppError("QUEUE_FULL", "还有事项正在处理，请稍后再交代", 429);
    const seq = ((this.store.db
      .prepare("SELECT COALESCE(MAX(seq),0) AS n FROM inbox WHERE channel<>'coordinator'")
      .get() as { n: number }).n) + 1;
    this.store.db
      .prepare(
        "INSERT INTO inbox(id,channel,actor_ref,external_id,body,metadata_json,received_at,occurred_at,seq) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        input.id,
        input.channel,
        input.actor_ref,
        input.external_id,
        input.text,
        JSON.stringify({
          reply_to: input.reply_to ?? null,
          note_scope: input.note_scope ?? [],
          payload_hash:payloadHash,
        }),
        this.store.now(),
        input.occurred_at,
        seq,
      );
    // Production Agent owns language understanding. Legacy API adapters retain
    // their old protocol, but no natural-language shortcut can pre-empt this loop.
    if (this.agent?.executionMode === "tools-v2") {
      void this.processPending();
      return { id: input.id, duplicate: false };
    }
    if (
      input.channel === "qq" &&
      /^(继续|继续阅读)[。！!\s]*$/.test(input.text)
    ) {
      const previous = this.store.db
        .prepare(
          "SELECT id,metadata_json,processed_at FROM inbox WHERE channel=? AND actor_ref=? AND status='processed' ORDER BY rowid DESC LIMIT 1",
        )
        .get(input.channel, input.actor_ref) as any;
      const meta = previous ? JSON.parse(previous.metadata_json) : {};
      if (
        typeof meta.reply === "string" &&
        Number.isInteger(meta.reply_next_offset) &&
        meta.reply_next_offset > 0 &&
        meta.reply_next_offset < meta.reply.length &&
        Date.parse(previous.processed_at) >
          this.store.clock().getTime() - 3600000
      ) {
        this.store.db.transaction(() => {
          this.store.db
            .prepare(
              "UPDATE inbox SET metadata_json=json_set(metadata_json,'$.reply_next_offset',0) WHERE id=?",
            )
            .run(previous.id);
          this.finishInput(input, meta.reply.slice(meta.reply_next_offset));
        })();
        return { id: input.id, duplicate: false };
      }
    }
    if (/^(今天)?(先)?(不提醒(了)?|暂停(提醒)?)[。！!\s]*$/.test(input.text)) {
      const result = await this.execute(
        input,
        [{ type: "pause_contact" }],
        "pause",
      );
      this.finishInput(input, result.message);
      return { id: input.id, duplicate: false };
    }
    const pendingProposal = this.store
      .registry()
      .proposals.filter(
        (p) => p.status === "pending" && p.expires_at > this.store.now(),
      );
    const chosen = this.consentProposals(input);
    const accepts = chosen.length > 0;
    const rejects =
      /^(不要(了)?|不了|不接受|拒绝|取消这个方案|不按这个|算了)[。！!\s]*$/.test(
        input.text,
      );
    if (accepts || (rejects && pendingProposal.length === 1)) {
      const p = pendingProposal[0];
      try {
        const result = accepts
          ? await this.execute(
              input,
              chosen.map((p) => ({
                type: "accept_proposal",
                target_id: p.id,
                expected_version: p.version,
              })),
              "accept-batch:" +
                chosen
                  .map((p) => p.id)
                  .sort()
                  .join(":"),
              true,
            )
          : await this.execute(
              input,
              [
                {
                  type: "reject_proposal",
                  target_id: p.id,
                  expected_version: p.version,
                },
              ],
              "reject:" + p.id,
            );
        this.finishInput(
          input,
          accepts
            ? this.executionReceipt(result)
            : "好，这份建议先放下，原来的承诺不变。",
        );
      } catch (error) {
        this.finishInput(
          input,
          error instanceof AppError
            ? error.message + "，原承诺保留。"
            : "这份安排暂未执行，原承诺保留。",
        );
      }
      return { id: input.id, duplicate: false };
    }
    if (
      input.reply_to &&
      /^(做了|完成了|完成|做完了|已完成|没做|没做成|跳过|这次跳过)[。！!\s]*$/.test(
        input.text,
      )
    ) {
      const out = this.store.db
        .prepare(
          "SELECT target_refs_json FROM outbox WHERE external_id=? OR id=?",
        )
        .get(input.reply_to, input.reply_to) as any;
      const refs = out ? JSON.parse(out.target_refs_json) : [];
      if (refs.length === 1) {
        const ref = refs[0],
          registry = this.store.registry(),
          target =
            ref.kind === "habit"
              ? registry.habits.find((h) => h.id === ref.id)
              : registry.tasks.find((t) => t.id === ref.id);
        if (target) {
          let action: Action;
          if (ref.kind === "habit")
            action = {
              type: "report_habit",
              target_id: target.id,
              expected_version: target.version,
              business_date: ref.business_date,
              status: /跳过/.test(input.text)
                ? "skipped"
                : /没做/.test(input.text)
                  ? "did_not"
                  : "did",
            };
          else
            action = /没做|跳过/.test(input.text)
              ? {
                  type: "report_execution",
                  target_id: target.id,
                  expected_version: target.version,
                  execution: /^没做[。！!\s]*$/.test(input.text)
                    ? "not_started"
                    : "not_done",
                  report: "本次暂未推进。",
                }
              : {
                  type: "complete_task",
                  target_id: target.id,
                  expected_version: target.version,
                };
          try {
            const result = await this.execute(
              input,
              [action],
              "direct-feedback",
            );
            this.finishInput(input, result.message);
          } catch (error) {
            if (
              error instanceof AppError &&
              error.code === "VERIFICATION_PENDING"
            ) {
              await this.execute(
                input,
                [
                  {
                    type: "update_task_progress",
                    target_id: target.id,
                    expected_version: target.version,
                    report: "用户已自报完成，工具验收尚未通过。",
                  },
                ],
                "pending-verification",
              );
              this.finishInput(input, "完成反馈已记下，工具验收尚未通过。");
            } else {
              this.store.db
                .prepare(
                  "UPDATE inbox SET status='failed',processed_at=?,error_code=? WHERE id=?",
                )
                .run(
                  this.store.now(),
                  error instanceof AppError ? error.code : "EXECUTION_FAILED",
                  input.id,
                );
              this.emit("input_result", {
                id: input.id,
                status: "failed",
                message: "暂未记入，请稍后重试。",
              });
            }
          }
          return { id: input.id, duplicate: false };
        }
      }
    }
    void this.processPending();
    return { id: input.id, duplicate: false };
  }
  /** Completes outstanding revocation cleanup; pending work keeps the honest receipt. */
  cleanupRevocations(targetIds?: string[]) {
    return cleanupRevokedFragments(this.store, this.store.now(), targetIds);
  }

  finishInput(input: Input, text: string) {
    this.store.db
      .prepare(
        "UPDATE inbox SET status='processed',processed_at=?,metadata_json=json_set(metadata_json,'$.reply',?) WHERE id=?",
      )
      .run(this.store.now(), text, input.id);
    if (input.channel === "qq") this.queueReply(input, text);
    this.emit("input_result", {
      id: input.id,
      status: "processed",
      reply: text,
    });
  }
  queueReply(input: Input, text: string) {
    const now = this.store.now();
    const native = this.agent?.executionMode === "tools-v2";
    const chunks: string[] = [];
    while (text.length) {
      let end = Math.min(text.length, 1800);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      chunks.push(text.slice(0, end));
      text = text.slice(end);
    }
    // The channel may limit passive replies per inbound message. Keep the rest
    // in the existing reply record and continue against a fresh user message.
    const page = native ? chunks : chunks.slice(0, 4),
      consumed = page.reduce((n, s) => n + s.length, 0);
    this.store.db
      .prepare(
        "UPDATE inbox SET metadata_json=json_set(metadata_json,'$.reply_next_offset',?) WHERE id=?",
      )
      .run(!native && chunks.length > 4 ? consumed : 0, input.id);
    if (!native && chunks.length > 4) page[3] += "\n\n内容较长，回复“继续”查看余下内容。";
    this.store.db.transaction(() => {
      // The final answer supersedes an unsent progress note: never tell the user
      // "still working" after the result is ready.
      this.store.db
        .prepare(
          "UPDATE outbox SET status='cancelled',finished_at=?,updated_at=? WHERE status='pending' AND json_extract(metadata_json,'$.reply_group')=? AND json_extract(metadata_json,'$.purpose')='progress'",
        )
        .run(now, now, input.id);
      for (const [index, chunk] of page.entries()) {
        const body =
          !native && page.length > 1 ? `（${index + 1}/${page.length}）\n${chunk}` : chunk;
        this.store.db
          .prepare(
            "INSERT OR IGNORE INTO outbox(id,channel,recipient_ref,dedupe_key,target_refs_json,source_versions_json,metadata_json,message_kind,body,content_hash,scheduled_at,expires_at,counts_as_proactive,created_at,updated_at) VALUES(?,?,?,?,?,?,?, 'receipt',?,?,?,?,0,?,?)",
          )
          .run(
            id("out"),
            "qq",
            input.actor_ref,
            input.id + ":reply" + (index ? ":" + (index + 1) : ""),
            JSON.stringify(
              (
                JSON.parse(
                  (
                    this.store.db
                      .prepare("SELECT metadata_json FROM inbox WHERE id=?")
                      .get(input.id) as any
                  )?.metadata_json ?? "{}",
                ).offered_proposal_ids ?? []
              ).map((id: string) => ({ kind: "proposal", id })),
            ),
            native ? JSON.stringify({language: "llm"}) : "{}",
            JSON.stringify({ reply_group: input.id, sequence: index + 1, purpose: "reply", total: page.length }),
            body,
            hash(body),
            now,
            DateTime.fromISO(now).plus({ minutes: 10 }).toUTC().toISO(),
            now,
            now,
          );
      }
    })();
  }
  /** One bounded progress note per slow turn; ordering uses sequence 0. */
  queueProgress(input: Input, body: string) {
    const now = this.store.now();
    const row = this.store.db
      .prepare("SELECT metadata_json FROM inbox WHERE id=?")
      .get(input.id) as { metadata_json: string } | undefined;
    if (!row) return null;
    const meta = JSON.parse(row.metadata_json);
    if (meta.progress_queued) return null;
    this.store.db
      .prepare(
        "INSERT OR IGNORE INTO outbox(id,channel,recipient_ref,dedupe_key,target_refs_json,source_versions_json,metadata_json,message_kind,body,content_hash,scheduled_at,expires_at,counts_as_proactive,created_at,updated_at) VALUES(?,?,?,?,?,?,?, 'system',?,?,?,?,0,?,?)",
      )
      .run(
        id("out"),
        "qq",
        input.actor_ref,
        input.id + ":progress",
        "[]",
        JSON.stringify({ revocation: this.store.revocationRevision() }),
        JSON.stringify({ reply_group: input.id, sequence: 0, purpose: "progress", total: 0, wording: "status" }),
        body,
        hash(body),
        now,
        DateTime.fromISO(now).plus({ minutes: 10 }).toUTC().toISO()!,
        now,
        now,
      );
    this.store.db
      .prepare("UPDATE inbox SET metadata_json=json_set(metadata_json,'$.progress_queued',json('true')) WHERE id=?")
      .run(input.id);
    return { queued: true };
  }

  /** Bounded record of a background planning gap, surfaced to the next turn. */
  recordPlanningGap(message: string) {
    const entry = { at: this.store.now(), message: message.slice(0, 200) };
    this.store.updateRuntimeMeta((meta) => {
      const history = Array.isArray(meta.planning_gaps) ? meta.planning_gaps : [];
      return {
        ...meta,
        planning_gap: entry,
        // Bounded: a repeated failure must not grow the record without limit.
        planning_gaps: [...history, entry].slice(-3),
      };
    });
    this.emit("planning_gap", { message: entry.message });
  }

  /** The user changed the constraints or the work moved on: the gap is stale. */
  clearPlanningGap() {
    const meta = this.store.runtimeMeta();
    if (!meta.planning_gap) return;
    this.store.updateRuntimeMeta((current) => {
      const { planning_gap: _dropped, ...rest } = current;
      return rest;
    });
  }

  context(input: Input) {
    const r = this.store.registry();
    let targetIds: string[] = [];
    if (input.reply_to) {
      const out = this.store.db
        .prepare(
          "SELECT target_refs_json FROM outbox WHERE external_id=? OR id=?",
        )
        .get(input.reply_to, input.reply_to) as any;
      if (out)
        targetIds = JSON.parse(out.target_refs_json).map((x: any) => x.id);
    }
    const previousShown=this.store.db.prepare("SELECT metadata_json FROM inbox WHERE channel=? AND actor_ref=? AND id<>? AND json_type(metadata_json,'$.offered_proposals')='array' ORDER BY rowid DESC LIMIT 1")
      .get(input.channel,input.actor_ref,input.id) as {metadata_json:string}|undefined;
    const shown:any[]=previousShown?JSON.parse(previousShown.metadata_json).offered_proposals:[];
    const referenced=new Set((r.followups??[]).filter(f=>f.work && f.status!=="resolved").slice(-6)
      .flatMap(f=>f.work!.refs?.flatMap(ref=>ref.id?[ref.id]:[])??[]));
    const rank=(x:{id:string;title?:string;updated_at?:string})=>Number(targetIds.includes(x.id))*100+
      Number(input.text.includes(x.id))*80+Number(!!x.title && input.text.includes(x.title))*60+Number(referenced.has(x.id))*20;
    const items = [
      ...r.habits.filter((x) => x.status === "active"),
      ...r.tasks.filter(
        (x) =>
          !["done", "cancelled"].includes(x.status) || targetIds.includes(x.id),
      ),
    ].sort((a,b)=>rank(b)-rank(a)||(b.updated_at??"").localeCompare(a.updated_at??""));
    const selected = targetIds.length
      ? items.filter((x) => targetIds.includes(x.id))
      : items;
    const documents = (input.note_scope ?? []).map((ref) => {
      const raw = this.store.files.read(ref.path);
      let content = raw;
      if (ref.heading) {
        const lines = raw.split("\n"),
          start = lines.findIndex(
            (line) =>
              /^#+ /.test(line) &&
              line.replace(/^#+ /, "").trim() === ref.heading,
          );
        if (start < 0) content = "";
        else {
          const level = lines[start].match(/^#+/)![0].length;
          let end = start + 1;
          while (
            end < lines.length &&
            !new RegExp("^#{1," + level + "} ").test(lines[end])
          )
            end++;
          content = lines.slice(start + 1, end).join("\n");
        }
      }
      return {
        path: ref.path,
        hash:hash(raw),
        heading: ref.heading,
        content: content.slice(0, 5000),
        truncated: content.length > 5000,
      };
    });
    const memory = this.assistant.preferences(
      input.text,
      selected.filter((x) => "outcome" in x).map((x) => x.id),
      input.channel === "coordinator" ? "planning" : "all",
    );
    const preferences = memory.selected;
    const facts = searchFacts(this.store, input.text, this.store.now(), 8);
    // Facts handed to the model are recorded once per event, so retention can
    // tell "used" from "stored". This only touches SQLite: writing the truth file
    // here would invalidate a commit the turn is preparing.
    if (facts.items.length)
      try {
        recordFactUsage(
          this.store,
          facts.items.map((f: any) => f.id),
          "ctx:" + input.id + ":" + this.store.snapshotRevision(),
          this.store.now(),
        );
      } catch {
        /* usage tracking is best effort; it must not block a turn */
      }
    const context = {
      assistant: this.assistant.view(),
      work:(r.followups??[]).filter(f=>f.work && f.status!=="resolved").slice(-6),
      application: applicationCapabilities,
      displayed_proposals:shown.map(ref=>{const p=r.proposals.find(p=>p.id===ref.proposal_id);
        return {...ref,current_version:p?.version??null,current_hash:p?hash(canonicalJson({version:p.version,actions:p.actions})):null};}),
      planning: {
        today_status:
          this.store.day(
            localDate(this.store.clock(), this.store.config.timezone),
          ).planning?.status ?? "not_prepared",
        issues: this.coordinator
          .view(localDate(this.store.clock(), this.store.config.timezone))
          .issues.slice(0, 3),
        query:
          "secretary.planning按date查询完整安排和已确认空闲；明确交代的set_planning/configure_task/report_execution/plan_day经secretary.apply_changes执行，未定建议才保存提案。没有回复不等于没做。",
      },
      workspace: {
        available: true,
        note_root: "日记仓库",
        current_period_paths: Object.fromEntries(
          (
            ["daily", "weekly", "monthly", "quarterly", "yearly"] as Period[]
          ).map((kind) => [
            kind,
            route(
              kind,
              localDate(this.store.clock(), this.store.config.timezone),
            ),
          ]),
        ),
      },
      available_counts: { items: selected.length, plans: r.plans.length },
      truncated: {
        items: selected.length > 30,
        plans:
          r.plans.filter((x) => x.window_end >= this.store.now()).length > 20,
        controls: false,
        proposals:
          r.proposals.filter((x) => x.status === "pending" && x.expires_at > this.store.now()).length > 10,
        preferences: memory.truncated,
        documents: false,
        assistant: false,
      },
      now: this.store.now(),
      now_local: DateTime.fromISO(this.store.now())
        .setZone(this.store.config.timezone)
        .toISO(),
      tomorrow_date: DateTime.fromJSDate(this.store.clock(), {
        zone: this.store.config.timezone,
      })
        .plus({ days: 1 })
        .toISODate(),
      input_mode: input.channel === "coordinator" ? "background_proposal" : this.agent?.executionMode === "tools-v2" ? "autonomous_tools" : discussionOnly(input.text)
        ? proposalRequested(input.text) ? "proposal_only" : "discussion_read_only"
        : "interpret_request",
      business_date: localDate(this.store.clock(), this.store.config.timezone),
      timezone: this.store.config.timezone,
      items: selected.slice(0, 30),
      plans: r.plans
        .filter((x) => x.window_end >= this.store.now())
        .slice(0, 20),
      controls: r.controls.filter((x) => x.ends_at > this.store.now()),
      proposals: r.proposals
        .filter((x) => x.status === "pending" && x.expires_at > this.store.now())
        .sort((a, b) =>
          Number(shown.some((x) => x.proposal_id === b.id)) -
            Number(shown.some((x) => x.proposal_id === a.id)) ||
          b.updated_at.localeCompare(a.updated_at),
        )
        .slice(0, 10),
      reply_target_ids: targetIds,
      reply_occurrences: input.reply_to
        ? (() => {
            const row = this.store.db
              .prepare(
                "SELECT target_refs_json FROM outbox WHERE external_id=? OR id=?",
              )
              .get(input.reply_to, input.reply_to) as any;
            return row
              ? JSON.parse(row.target_refs_json).filter(
                  (x: any) => x.occurrence_id,
                )
              : [];
          })()
        : [],
      reply_business_date: input.reply_to
        ? (() => {
            const row = this.store.db
              .prepare(
                "SELECT target_refs_json FROM outbox WHERE external_id=? OR id=?",
              )
              .get(input.reply_to, input.reply_to) as any;
            return row
              ? (JSON.parse(row.target_refs_json).find(
                  (ref: any) => ref.business_date,
                )?.business_date ?? null)
              : null;
          })()
        : null,
      preferences,
      facts: facts.items,
      facts_truncated: facts.matched,
      // What is still unread is authoritative: the model sees the contiguous
      // understood watermark and the newer inputs it has not interpreted yet.
      understood_seq: understoodSeq(this.store),
      planning_gap: this.store.runtimeMeta().planning_gap ?? null,
      recent_planning_gaps: this.store.runtimeMeta().planning_gaps ?? [],
      uninterpreted_inputs: (
        this.store.db
          .prepare(
            "SELECT seq,substr(body,1,80) AS excerpt FROM inbox WHERE channel=? AND actor_ref=? AND id<>? AND classification<>'classified' AND status IN ('pending','processing') ORDER BY seq",
          )
          .all(input.channel, input.actor_ref, input.id) as { seq: number; excerpt: string }[]
      ).filter((row) => row.seq > 0),
      delivered_display_sets: (
        this.store.db
          .prepare(
            "SELECT id,metadata_json,processed_at FROM inbox WHERE json_extract(metadata_json,'$.delivered_display_set') IS NOT NULL ORDER BY rowid DESC LIMIT 3",
          )
          .all() as { id: string; metadata_json: string; processed_at: string }[]
      ).map((row) => ({
        input_id: row.id,
        delivered_at: row.processed_at,
        items: JSON.parse(row.metadata_json).delivered_display_set,
      })),
      facts_restricted: facts.restricted,
      recent_contacts: (
        this.store.db
          .prepare(
            "SELECT body,source_versions_json,target_refs_json,sent_at,status FROM outbox WHERE counts_as_proactive=1 AND status IN ('sent','unknown') AND body IS NOT NULL ORDER BY rowid DESC LIMIT 3",
          )
          .all() as any[]
      )
        .reverse()
        .map((row) => ({
          text: row.body.slice(0, 600),
          at: row.sent_at,
          delivery: row.status,
          target_refs: JSON.parse(row.target_refs_json),
        })),
      recent_interactions: (
        this.store.db
          .prepare(
            "SELECT id,body,metadata_json,received_at FROM inbox WHERE status='processed' AND body IS NOT NULL ORDER BY rowid DESC LIMIT 6",
          )
          .all() as any[]
      )
        .reverse()
        .map((row) => ({
          input_id: row.id,
          text: row.body.slice(0, this.agent?.executionMode === "tools-v2" ? 1000 : 120),
          reply: String(JSON.parse(row.metadata_json).reply ?? "").slice(0, this.agent?.executionMode === "tools-v2" ? 1800 : 80),
          at: DateTime.fromISO(row.received_at)
            .setZone(this.store.config.timezone)
            .toISO(),
        })),
      documents,
    };
    context.assistant.rules = context.assistant.rules
      .filter((x) => x.enabled)
      .slice(-12);
    context.assistant.principles = memory.principles;
    context.assistant.automations = context.assistant.automations
      .filter((x) => x.status !== "retired" || targetIds.includes(x.id))
      .sort(
        (a, b) =>
          Number(targetIds.includes(b.id)) - Number(targetIds.includes(a.id)),
      )
      .slice(0, 12);
    context.assistant.objects = [
      ...context.assistant.rules,
      ...context.assistant.automations,
      ...(context.assistant.focus ? [context.assistant.focus] : []),
    ].map((x) => ({ id: x.id, version: x.version }));
    context.assistant.board.now = context.assistant.board.now.slice(0, 1);
    context.assistant.board.blocked = context.assistant.board.blocked.slice(
      0,
      2,
    );
    context.assistant.board.needs_decision =
      context.assistant.board.needs_decision.slice(0, 2);
    // Keep the automatic bundle small; complete objects remain available through read tools.
    for (const list of [
      context.assistant.rules,
      context.assistant.principles,
      context.assistant.board.followups,
      context.assistant.automations,
      context.assistant.board.next,
      context.assistant.board.blocked,
      context.assistant.board.needs_decision,
      context.work,
    ]) {
      while (JSON.stringify(context).length > 12000 && list.length) {
        list.pop();
        context.truncated.assistant = true;
      }
    }
    if (JSON.stringify(context).length > 12000) {
      context.assistant.values = Object.fromEntries(
        Object.entries(context.assistant.values).filter(
          ([, v]) => JSON.stringify(v).length < 500,
        ),
      );
      context.assistant.planning = {
        ...context.assistant.planning,
        availability: [],
        protected: [],
        day_overrides: [],
      };
      context.truncated.assistant = true;
    }
    context.assistant.objects = [
      ...context.assistant.rules,
      ...context.assistant.automations,
      ...(context.assistant.focus ? [context.assistant.focus] : []),
    ].map((x) => ({ id: x.id, version: x.version }));
    while (JSON.stringify(context).length > 12000 && context.items.length) {
      context.items.pop();
      context.truncated.items = true;
    }
    while (JSON.stringify(context).length > 12000 && context.plans.length) {
      context.plans.pop();
      context.truncated.plans = true;
    }
    while (JSON.stringify(context).length > 12000 && context.controls.length) {
      context.controls.pop();
      context.truncated.controls = true;
    }
    while (JSON.stringify(context).length > 12000 && context.proposals.length) {
      context.proposals.pop();
      context.truncated.proposals = true;
    }
    while (
      JSON.stringify(context).length > 12000 &&
      context.recent_interactions.length
    )
      context.recent_interactions.shift();
    if (JSON.stringify(context).length > 12000) {
      context.preferences = context.preferences.slice(-500);
      context.truncated.preferences = true;
    }
    if (JSON.stringify(context).length > 12000)
      for (const doc of context.documents) {
        doc.content = doc.content.slice(0, 1000);
        doc.truncated = true;
        context.truncated.documents = true;
      }
    for (const list of [
      context.recent_contacts,
      context.documents,
      context.assistant.board.now,
      context.planning.issues,
      context.reply_occurrences,
    ])
      while (JSON.stringify(context).length > 12000 && list.length) {
        list.pop();
        context.truncated.assistant = true;
      }
    return context;
  }
  /**
   * C2 classification job: one bounded batch (<=20) of accepted-but-unread
   * inputs, cut off at acceptance time. It runs beside the turn loop so a newer
   * message stops holding older work without waiting for its own turn.
   */
  async classifyPending() {
    const agent = this.agent;
    if (!agent?.classify || this.stopping) return null;
    // Understanding is background work: a degraded or draining runtime must not
    // spend model budget on it (the gate stays fail-closed meanwhile).
    if (!this.store.state.acceptsBackground()) return null;
    const rows = this.store.db
      .prepare(
        "SELECT id,body,metadata_json,seq FROM inbox WHERE status='pending' AND channel<>'coordinator' AND classification='unclassified' AND body IS NOT NULL ORDER BY seq,rowid LIMIT 20",
      )
      .all() as { id: string; body: string; metadata_json: string; seq: number }[];
    if (!rows.length) return null;
    const cutoff = rows[rows.length - 1].seq;
    const mark = this.store.db.prepare("UPDATE inbox SET classification=? WHERE id=?");
    // At most two attempts per input: an unreadable message becomes an explicit
    // needs_clarification responsibility instead of an endless retry loop.
    const exhausted = rows.filter((row) => Number(JSON.parse(row.metadata_json).classify_attempts ?? 0) >= 2);
    for (const row of exhausted) mark.run("needs_clarification", row.id);
    const attemptRows = rows.filter((row) => !exhausted.includes(row));
    if (!attemptRows.length) return { batch: rows.length, cutoff_seq: cutoff, published: 0, exhausted: exhausted.length };
    rows.length = 0;
    rows.push(...attemptRows);
    for (const row of rows) {
      const meta = JSON.parse(row.metadata_json);
      this.store.db
        .prepare("UPDATE inbox SET metadata_json=json_set(metadata_json,'$.classify_attempts',?) WHERE id=?")
        .run(Number(meta.classify_attempts ?? 0) + 1, row.id);
    }
    for (const row of rows) mark.run("classifying", row.id);
    const retry = (status: string) => {
      for (const row of rows) {
        const live = this.store.db.prepare("SELECT classification FROM inbox WHERE id=?").get(row.id) as any;
        if (live?.classification === "classifying") mark.run(status, row.id);
      }
    };
    let outcome;
    try {
      outcome = await withDeadline("classify", 30_000, () =>
        agent.classify!(rows.map((row) => ({ id: row.id, text: row.body, occurred_at: this.store.now() }))),
      );
    } catch {
      // Fail closed and keep a recoverable responsibility instead of guessing.
      retry("needs_clarification");
      return { batch: rows.length, cutoff_seq: cutoff, published: 0, failed: rows.length };
    }
    if (outcome === null) {
      // The adapter does not offer classification yet: leave the rows unread so
      // the gate keeps its fail-closed behaviour instead of inventing a result.
      retry("unclassified");
      return { batch: rows.length, cutoff_seq: cutoff, published: 0, unsupported: true };
    }
    let published = 0;
    for (const item of outcome.items ?? []) {
      const row = rows.find((candidate) => candidate.id === item.input_id);
      if (!row) continue;
      try {
        const interpretation = validateInterpretation(item.interpretation, row.body);
        const payloadHash = JSON.parse(row.metadata_json).payload_hash as string | undefined;
        publishInterpretation(this.store, row.id, interpretation, payloadHash ?? "");
        published++;
      } catch {
        mark.run("needs_clarification", row.id);
      }
    }
    // Nothing published for a row means the model could not be trusted here.
    retry("needs_clarification");
    return { batch: rows.length, cutoff_seq: cutoff, published, failed: rows.length - published };
  }

  async processPending() {
    if (!this.agent || this.stopping) return;
    // An expired lease is taken over instead of waiting for a dead holder. Its
    // abandoned row is closed as failed so nothing stays "processing" forever.
    if (this.turnLease.expired) {
      const live = this.store.db
        .prepare("SELECT id FROM inbox WHERE status='processing'")
        .all() as { id: string }[];
      for (const row of live)
        this.store.db
          .prepare(
            "UPDATE inbox SET status='failed',processed_at=?,error_code='TURN_TIMEOUT' WHERE id=?",
          )
          .run(this.store.now(), row.id);
      this.emit("runtime_degraded", {
        code: "PROCESSING_GUARD_RECOVERED",
        elapsed_ms: this.turnLease.ageMs(),
        abandoned: live.length,
      });
    }
    const lease = this.turnLease.tryAcquire();
    if (lease === null) return;
    this.idle = new Promise((resolve) => {
      this.releaseIdle = resolve;
    });
    try {
      for (;;) {
        if (this.stopping) return;
        if(this.foregroundStreak>=3) {
          this.foregroundStreak=0;
          this.assistant.startPlanning(true);
          // Planning may be slow, but it can never hold the message queue open.
          await withDeadline("planning-drain", 120_000, () => this.assistant.drain())
            .catch(() => { this.foregroundStreak = 0; });
        }
        const row = this.store.db
          .prepare(
            "SELECT * FROM inbox WHERE status='pending' AND channel<>'coordinator' ORDER BY rowid LIMIT 1",
          )
          .get() as any;
        if (!row) break;
        this.foregroundStreak++;
        const metadata = JSON.parse(row.metadata_json),
          input: Input = {
            id: row.id,
            channel: row.channel,
            actor_ref: row.actor_ref,
            external_id: row.external_id,
            text: row.body,
            occurred_at: row.occurred_at,
            reply_to: metadata.reply_to ?? undefined,
            note_scope: metadata.note_scope,
          };
        this.store.db
          .prepare(
            "UPDATE inbox SET status='processing',attempts=attempts+1 WHERE id=?",
          )
          .run(input.id);
        try {
          if (this.agent.executionMode === "tools-v2") {
            // One turn may not hold the queue longer than a model budget. On
            // timeout the row is closed and the loop moves to the next message
            // immediately; the abandoned work cannot hold anyone else.
            await withDeadline("turn:" + input.id, this.turnDeadlineMs, () =>
              processNativeInput(this, input),
            );
            continue;
          }
          const r = this.store.registry(),
            pending = r.proposals.filter(
              (x) => x.status === "pending" && x.expires_at > this.store.now(),
            );
          const readOnly = discussionOnly(input.text);
          this.store.db
            .prepare(
              "UPDATE inbox SET metadata_json=json_set(metadata_json,'$.read_only',json(?)) WHERE id=?",
            )
            .run(JSON.stringify(readOnly), input.id);
          const last = this.store.db
            .prepare(
              "SELECT metadata_json FROM inbox WHERE status='processed' AND channel=? AND actor_ref=? ORDER BY rowid DESC LIMIT 1",
            )
            .get(input.channel, input.actor_ref) as any;
          const lastMeta = last ? JSON.parse(last.metadata_json) : {};
          const continuation =
            !readOnly &&
            lastMeta.awaiting_execution?.expires_at > this.store.now() &&
            input.text.length <= 160 &&
            /(?:\d|[一二三四五六七八九十]点|每天|工作日|周末|周[一二三四五六日天]|星期|上午|下午|晚上|分钟|小时)/u.test(
              input.text,
            )
              ? lastMeta.awaiting_execution
              : null;
          const chosen = this.consentProposals(input);
          if (chosen.length) {
            const outcome = await this.execute(
              input,
              chosen.map((p) => ({
                type: "accept_proposal",
                target_id: p.id,
                expected_version: p.version,
              })),
              "accept-batch:" +
                chosen
                  .map((p) => p.id)
                  .sort()
                  .join(":"),
              true,
            );
            this.finishInput(input, this.executionReceipt(outcome));
            continue;
          }
          if (/^(好|好的|可以|就这样|同意)[。！!\s]*$/u.test(input.text)) {
            if (pending.length > 1) {
              const shown = pending.slice(0, 8);
              this.store.db.prepare("UPDATE inbox SET metadata_json=json_set(metadata_json,'$.offered_proposal_ids',json(?)) WHERE id=?")
                .run(JSON.stringify(shown.map((p) => p.id)), input.id);
              this.finishInput(input, "还有多份待定安排，暂未执行：\n" + shown.map((p, i) =>
                (i + 1) + ". " + p.actions.map((a) => this.actionLabel(a)).join("、")).join("\n") +
                "\n可以回复某一份消息确认，或明确说这些都提交。");
            } else this.finishInput(input, "好。");
            continue;
          }
          if (
            readOnly &&
            pending.length &&
            /(?:列|复述).*(?:创建|安排|要做)|要创建什么/u.test(input.text)
          ) {
            this.store.db
              .prepare(
                "UPDATE inbox SET metadata_json=json_set(metadata_json,'$.offered_proposal_ids',json(?),'$.reviewed_proposal_ids',json(?)) WHERE id=?",
              )
              .run(JSON.stringify(pending.map((p) => p.id)), JSON.stringify(pending.map((p) => p.id)), input.id);
            this.finishInput(
              input,
              "待你决定的安排：\n" +
                pending
                  .map(
                    (p, i) =>
                      i +
                      1 +
                      ". " +
                      p.actions.map((a) => this.actionLabel(a)).join("、"),
                  )
                  .join("\n") +
                "\n这些变更尚未执行，可以一次确认整批。",
            );
            continue;
          }
          if (
            /^(不要(了)?|不了|不接受|拒绝|取消这个方案|不按这个|算了)[。！!\s]*$/.test(
              input.text,
            ) &&
            pending.length === 1
          ) {
            const p = pending[0];
            await this.execute(
              input,
              [
                {
                  type: "reject_proposal",
                  target_id: p.id,
                  expected_version: p.version,
                },
              ],
              "reject:" + p.id,
            );
            this.finishInput(input, "好，这份建议先放下，原来的承诺不变。");
            continue;
          }
          const bundle = this.context(input);
          const policy = policyStamp(this.store);
          this.store.db.prepare("UPDATE inbox SET metadata_json=json_set(metadata_json,'$.policy_stamp',?) WHERE id=?")
            .run(policy, input.id);
          const result = await this.agent.interpret(input, bundle);
          if (this.stopping) return;
          if (result.action_groups.some((g) => g.actions.length) && policy !== policyStamp(this.store))
            throw new AppError("VERSION_CONFLICT", "个人规则或可用时间已变化，本轮旧方案未执行", 409);
          if (result.action_groups.length > 20)
            throw new AppError("AGENT_INVALID", "提案过多");
          // A model inventing actions during a question must not manufacture a
          // pending commitment that a later casual “好” could accidentally accept.
          const suppressed = readOnly && !proposalRequested(input.text) && result.action_groups.some((g) => g.actions.length);
          if (suppressed) result.action_groups = [];
          let reply = "";
          const groupErrors: string[] = [];
          let acceptedGroups = 0;
          const deferred: Action[] = [];
          const groupResults: {
            status: string;
            operation_id?: string;
            reason?: string;
          }[] = [];
          const groups =
            (explicitCommitment(input.text) ||
              (continuation &&
                result.action_groups
                  .flatMap((g) => g.actions)
                  .every((a) => continuation.action_types.includes(a.type)))) &&
            result.action_groups.flatMap((g) => g.actions).length <= 20
              ? [
                  {
                    action_identity: "user-batch:" + input.id,
                    actions: result.action_groups.flatMap((g) => g.actions),
                  },
                ].filter((g) => g.actions.length)
              : result.action_groups;
          for (const group of groups) {
            try {
              if (!Array.isArray(group.actions))
                throw new AppError("AGENT_INVALID", "提案结构不正确");
              const access = this.store.db
                .prepare("SELECT metadata_json FROM inbox WHERE id=?")
                .get(input.id) as any;
              const known = [
                ...bundle.items,
                ...bundle.plans,
                ...bundle.proposals,
                ...bundle.assistant.objects,
                ...(JSON.parse(access.metadata_json).observed_refs ?? []),
              ];
              for (const action of group.actions) {
                const excludedKind =
                  action.type === "create_task"
                    ? "任务"
                    : action.type === "create_habit"
                      ? "习惯"
                      : null;
                if (
                  excludedKind &&
                  input.text
                    .split(/[，,。；;！!\n]/u)
                    .some(
                      (clause) =>
                        /不(?:要)?(?:再)?(?:新建|创建|建立|新增|建)/u.test(
                          clause,
                        ) && clause.includes(excludedKind),
                    )
                )
                  throw new AppError(
                    "USER_RESTRICTION",
                    "这部分包含你明确不创建的事项，未执行",
                  );
                if (
                  [
                    "accept_proposal",
                    "unlink_diary",
                    "pending_diary_binding",
                  ].includes(action.type)
                )
                  throw new AppError("AGENT_INVALID", "此操作不由模型直接调用");
                if (
                  action.target_id &&
                  !["pause_contact", "resume_contact"].includes(action.type)
                ) {
                  const item = [...known]
                    .reverse()
                    .find((x) => x.id === action.target_id);
                  if (!item || action.expected_version !== item.version)
                    throw new AppError(
                      "VERSION_CONFLICT",
                      "事项或版本不在本次上下文中",
                      409,
                    );
                }
              }
              const newCommitment =
                /^(?:\/讨论 |(?:帮我|请)?(?:分析|研究|讨论|比较))/.test(
                  input.text,
                ) ||
                group.actions.some((a) =>
                  [
                    "create_habit",
                    "create_task",
                    "update_habit",
                    "update_task",
                    "schedule",
                    "cancel_item",
                    "remember_fact",
                    "link_diary",
                    "set_planning",
                    "configure_task",
                    "plan_day",
                    "set_personal_rule",
                    "control_rule",
                    "undo_rule",
                    "create_automation",
                    "update_automation",
                    "control_automation",
                    "start_focus",
                    "pause_focus",
                    "resume_focus",
                    "stop_focus",
                    "set_period_focus",
                  ].includes(a.type),
                ) ||
                group.actions.some((a) => {
                  if (a.type !== "reschedule") return false;
                  const plan = bundle.plans.find((p) => p.id === a.target_id);
                  return (
                    !plan ||
                    plan.kind === "fixed" ||
                    a.available_windows !== undefined ||
                    typeof a.window_start !== "string" ||
                    typeof a.window_end !== "string" ||
                    Date.parse(a.window_start) <
                      Date.parse(plan.window_start) ||
                    Date.parse(a.window_end) > Date.parse(plan.window_end)
                  );
                });
              const explicit =
                explicitCommitment(input.text) ||
                (continuation &&
                  group.actions.every((a) =>
                    continuation.action_types.includes(a.type),
                  )) ||
                (group.actions.every(
                  (a) =>
                    a.type === "set_personal_rule" &&
                    (a.key === "contact.style" ||
                      a.key === "support.style" ||
                      String(a.key).startsWith("working.")),
                ) &&
                  !/(?:如果|假如|比如|是否)/u.test(input.text) &&
                  /(?:不要|别|以后|下次|往后|简短|称呼|叫我|温和|直接)/u.test(
                    input.text,
                  ));
              if (readOnly || (newCommitment && !explicit)) {
                deferred.push(...group.actions);
                groupResults.push({ status: "needs_confirmation" });
              } else {
                const outcome = await this.execute(
                  input,
                  group.actions,
                  group.action_identity,
                  true,
                );
                reply = [reply, this.executionReceipt(outcome)].filter(Boolean).join("\n");
                acceptedGroups++;
                groupResults.push({
                  status: "accepted",
                  operation_id: outcome.operation_id,
                });
              }
            } catch (error) {
              groupErrors.push(
                error instanceof AppError ? error.message : "这部分暂未处理",
              );
              groupResults.push({
                status:
                  error instanceof AppError && error.status === 409
                    ? "conflict"
                    : "rejected",
                reason:
                  error instanceof AppError ? error.code : "EXECUTION_FAILED",
              });
            }
          }
          if (deferred.length) {
            const saved = await this.store.exclusive(() =>
              this.store.commit(
                input.id + ":proposal-batch",
                input.channel,
                input.id,
                (registry, _load, op) => {
                  if (deferred.length > 20)
                    throw new AppError(
                      "BATCH_TOO_LARGE",
                      "这批变更超过单次20项，尚未保存，请缩小本次范围",
                    );
                  const signature = canonicalJson(deferred);
                  const prior = registry.proposals.find(
                    (p) =>
                      p.status === "pending" &&
                      p.expires_at > this.store.now() &&
                      canonicalJson(p.actions) === signature,
                  );
                  const proposal = prior ?? {
                    id: id("proposal"),
                    version: 1,
                    created_at: this.store.now(),
                    updated_at: this.store.now(),
                    last_operation_id: op,
                    summary: (result.summary ?? "安排建议").slice(0, 500),
                    actions: deferred,
                    expires_at: DateTime.fromISO(this.store.now())
                      .plus({ hours: 24 })
                      .toUTC()
                      .toISO()!,
                    status: "pending" as const,
                    source: this.source(input),
                  };
                  if (!prior) registry.proposals.push(proposal);
                  return { ids: [proposal.id], message: "整批建议已保存" };
                },
              ),
            );
            this.store.db
              .prepare(
                "UPDATE inbox SET metadata_json=json_set(metadata_json,'$.offered_proposal_ids',json(?)) WHERE id=?",
              )
              .run(JSON.stringify(saved.updated_ids), input.id);
            reply =
              (reply ? reply + "\n" : "") +
              (readOnly ? "尚未创建任务或设置提醒；" : "") +
              "待你决定的整批建议：" +
              deferred
                .map((a) => this.actionLabel(a))
                .slice(0, 8)
                .join("、") +
              "。这些变更尚未执行，可以一次确认整批。";
            this.emit("item_changed", { ids: [] });
          }
          this.store.db
            .prepare(
              "UPDATE inbox SET metadata_json=json_set(metadata_json,'$.groups',json(?)) WHERE id=?",
            )
            .run(JSON.stringify(groupResults), input.id);
          if (groupErrors.length)
            reply =
              (reply ? reply + "\n未处理部分：" : "暂未改动：") +
              groupErrors.slice(0, 5).join("；") +
              "。";
          // Core receipts preserve exact execution facts and avoid a second model call.
          if (this.stopping) return;
          const clarification =
            result.reply_intent === "clarification"
              ? result.clarification
              : null;
          if (
            clarification &&
            !readOnly &&
            (explicitCommitment(input.text) || continuation)
          ) {
            const authorization = continuation ?? {
              request_id: input.id,
              action_types: requestActionTypes(input.text),
              expires_at: DateTime.fromISO(this.store.now())
                .plus({ hours: 24 })
                .toUTC()
                .toISO(),
            };
            this.store.db
              .prepare(
                "UPDATE inbox SET metadata_json=json_set(metadata_json,'$.awaiting_execution',json(?)) WHERE id=?",
              )
              .run(JSON.stringify(authorization), input.id);
          }
          // A model often repeats the same question in discussion and
          // clarification. With no executed change, send the one self-contained
          // question. Keep file-operation facts when a write already happened.
          const fileWrites =
            clarification && !reply
              ? (JSON.parse(
                  (
                    this.store.db
                      .prepare("SELECT metadata_json FROM inbox WHERE id=?")
                      .get(input.id) as any
                  ).metadata_json,
                ).workspace_operations ?? [])
              : [];
          // A syntactically valid answer is not proof of an operation. In
          // particular an empty receipt must not resurrect the old "已建好"
          // failure when the model forgot to submit its business actions.
          if (!reply && !clarification && !readOnly &&
            (result.reply_intent === "receipt" || explicitCommitment(input.text) || continuation)) {
            const effects = this.inputEffects(input.id);
            reply = effects.applied.length
              ? "已处理：" + effects.applied.join("；") + "。"
              : effects.uncertain
                ? "有操作尚未取得最终回执，请先核对实际状态，未确认全部完成。"
                : "本轮没有保存或执行变更，原有记录保留。";
          }
          this.finishInput(
            input,
            [
              (suppressed ? "本轮只查询和讨论，没有创建或修改事项。\n" + (result.discussion || "") : reply) ||
                (clarification && !fileWrites.length
                  ? null
                  : result.discussion || result.summary),
              clarification,
            ]
              .filter((v, index, all) => v && all.indexOf(v) === index)
              .join("\n") ||
              result.clarification ||
              "已收到。",
          );
        } catch (error) {
          if (this.stopping || this.store.closed) return;
          const code =
            error instanceof AppError ? error.code : "AGENT_UNAVAILABLE";
          const runtime = this.store.db
            .prepare("SELECT metadata_json FROM inbox WHERE id=?")
            .get(input.id) as any;
          const writes = runtime
            ? (JSON.parse(runtime.metadata_json).workspace_operations ?? [])
            : [];
          const effects = this.inputEffects(input.id);
          const failureMessage = effects.applied.length || effects.uncertain
            ? "处理未全部完成。" +
              (effects.applied.length ? "已保存：" + effects.applied.join("；") + "。" : "") +
              (effects.uncertain ? "另有文件操作未取得最终回执，请先查询当前状态，避免重复。" : "其余部分未执行。")
            : writes.length
            ? "部分文件操作已完成，但回复生成失败。已操作：" +
              writes
                .map((w: any) => w.path)
                .slice(0, 3)
                .join("、") +
              "。请先检查，避免重复修改。"
            : error instanceof AppError ? error.message + "；原有记录保留。" : "暂未处理成功，可稍后重试。";
          this.store.db
            .prepare(
              "UPDATE inbox SET status='failed',processed_at=?,error_code=?,metadata_json=json_set(metadata_json,'$.reply',?) WHERE id=?",
            )
            .run(this.store.now(), code, failureMessage, input.id);
          this.emit("input_result", {
            id: input.id,
            status: "failed",
            error: code,
            message: failureMessage,
          });
          // Native language failures remain observable in status/logs. Never
          // send a canned fallback or replay already successful business work.
          if (input.channel === "qq" && this.agent.executionMode !== "tools-v2") this.queueReply(input, failureMessage);
        }
      }
    } finally {
      this.turnLease.release(lease);
      this.releaseIdle?.();
    }
  }
  async stop() {
    this.stopping = true;
    this.agent?.close?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.idle,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 15000);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
  async acceptProposal(proposalId: string, expected: number, input: Input) {
    return this.execute(
      input,
      [
        {
          type: "accept_proposal",
          target_id: proposalId,
          expected_version: expected,
        },
      ],
      "accept:" + proposalId,
      true,
    );
  }
  private executionReceipt(outcome: Execution) {
    const r = this.store.registry(),
      ids = new Set(outcome.updated_ids);
    const plans = r.plans.filter(
      (p) => ids.has(p.id) && ["planned", "active"].includes(p.status),
    );
    const habits = r.habits.filter((h) => ids.has(h.id));
    const autos = (r.automations ?? []).filter(
      (a) => ids.has(a.id) && a.status === "active",
    );
    return [
      outcome.message,
      plans.length
        ? "已保存安排：" +
          plans
            .slice(0, 3)
            .map(
              (p) =>
                DateTime.fromISO(p.window_start)
                  .setZone(this.store.config.timezone)
                  .toFormat("yyyy-MM-dd HH:mm") +
                "—" +
                DateTime.fromISO(p.window_end)
                  .setZone(this.store.config.timezone)
                  .toFormat("HH:mm") +
                " " +
                p.next_action,
            )
            .join("；") +
          "。"
        : "",
      habits.length
        ? "习惯记录已更新" + habits.length + "项；提醒按各项设置执行。"
        : "",
      autos.length
        ? "自动化记录已更新：" +
          autos
            .slice(0, 3)
            .map((a) => a.title)
            .join("、") +
          "。"
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  private consentProposals(input: Input): Proposal[] {
    const consent = confirmation(input.text);
    if (!consent) return [];
    const pending = this.store
      .registry()
      .proposals.filter(
        (p) => p.status === "pending" && p.expires_at > this.store.now(),
      );
    const last = this.store.db
      .prepare(
        "SELECT metadata_json,received_at FROM inbox WHERE status='processed' AND channel=? AND actor_ref=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(input.channel, input.actor_ref) as any;
    const meta = last ? JSON.parse(last.metadata_json) : {};
    let offered: string[] = meta.offered_proposal_ids ?? [];
    if (consent === "yes" && pending.length > 1 && !input.reply_to)
      return pending.filter((p) => (meta.reviewed_proposal_ids ?? []).includes(p.id));
    if (consent === "latest")
      return pending.filter((p) => offered.includes(p.id)).slice(-1);
    const contact = input.reply_to
      ? (this.store.db
          .prepare(
            "SELECT target_refs_json,created_at FROM outbox WHERE external_id=? OR id=?",
          )
          .get(input.reply_to, input.reply_to) as any)
      : (this.store.db
          .prepare(
            "SELECT target_refs_json,created_at FROM outbox WHERE recipient_ref=? AND status IN ('sent','unknown') ORDER BY rowid DESC LIMIT 1",
          )
          .get(input.actor_ref) as any);
    if (
      contact &&
      (input.reply_to || contact.created_at > (last?.received_at ?? ""))
    )
      offered = JSON.parse(contact.target_refs_json)
        .filter((x: any) => x.kind === "proposal")
        .map((x: any) => x.id);
    if (
      !offered.length &&
      pending.length === 1 &&
      /回复[“"']?好/.test(meta.reply ?? ""))
      offered = [pending[0].id];
    if (consent === "all" && !offered.length)
      return input.text.length < 80 && /全部|所有|[一二三四五六七八九十\d]+份/u.test(input.text) ? pending : [];
    return pending.filter((p) => offered.includes(p.id));
  }
  private actionLabel(a: Action) {
    const r = this.store.registry();
    const labels: Record<string, string> = {
      create_task: "任务",
      create_habit: "习惯",
      create_automation: "消息安排",
      schedule: "时间安排",
      reschedule: "改期",
      set_planning: "可用时间",
      configure_task: "任务下一步",
      update_task: "任务调整",
      update_habit: "习惯调整",
      set_personal_rule: "个人规则",
      start_focus: "专注计时",
      link_diary: "日记关联",
    };
    const title =
      a.title ??
      [...r.tasks, ...r.habits, ...(r.automations ?? [])].find(
        (x) => x.id === a.target_id,
      )?.title;
    return (labels[a.type] ?? "事项变更") + (title ? "：" + String(title) : "");
  }
  items(date: string) {
    const r = this.store.registry(),
      d = this.store.day(date);
    return {
      assistant: this.assistant.view(),
      planning: this.coordinator.view(date),
      tomorrow: this.coordinator.view(
        DateTime.fromISO(date).plus({ days: 1 }).toISODate()!,
      ),
      habits: r.habits.map((h) => ({
        ...h,
        occurrence: d.occurrences.find((o) => o.habit_id === h.id) ?? null,
      })),
      tasks: r.tasks,
      plans: r.plans,
      controls: r.controls,
      proposals: r.proposals.filter(
        (x) => x.status === "pending" && x.expires_at > this.store.now(),
      ),
    };
  }
}
