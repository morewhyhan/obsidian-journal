import fs from "node:fs";
import { DateTime } from "luxon";
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
import {
  bind,
  checkboxActions,
  createPeriod,
  project,
  prepareAutomaticBindings,
} from "./journal.js";
export type AgentResult = {
  action_groups: { action_identity: string; actions: Action[] }[];
  clarification: string | null;
  reply_intent: string;
  summary?: string;
  discussion?: string;
};
export interface AgentAdapter {
  interpret(input: Input, context: unknown): Promise<AgentResult>;
  compose?(facts: unknown): Promise<{ text: string }>;
  close?(): void;
}
export class Core {
  documents: DocumentOperations;
  subscribers = new Set<(event: { type: string; data: unknown }) => void>();
  agent?: AgentAdapter;
  summaryError: string | null = null;
  private processing = false;
  private stopping = false;
  private idle: Promise<void> = Promise.resolve();
  private releaseIdle?: () => void;
  get working() {
    return this.processing;
  }
  constructor(public store: Store) {
    this.documents = new DocumentOperations(store);
    this.recoverPending();
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
    for (const event of unprojected) {
      const ids = JSON.parse(event.payload_json).result?.updated_ids ?? [];
      const projectionId = event.id + ":projection";
      store.db
        .prepare(
          "INSERT OR IGNORE INTO events(id,dedupe_key,input_id,parent_id,source,kind,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          projectionId,
          projectionId,
          event.input_id,
          event.id,
          "core",
          "diary_projection",
          JSON.stringify({ target_ids: ids }),
          store.now(),
        );
    }
    this.flushProjections();
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
  rebuildSummary() {
    try {
      const registry = this.store.registry(),
        date = localDate(this.store.clock(), this.store.config.timezone),
        record = this.store.day(date),
        source =
          "registry:" +
          registry.revision +
          ";day:" +
          date +
          ":" +
          record.revision,
        file = this.store.files.resolve(
          ".agent/context/current.md",
          "internal",
        );
      if (
        fs.existsSync(file) &&
        fs.readFileSync(file, "utf8").includes("<!-- " + source + " -->")
      )
        return;
      const active = registry.habits.filter((h) => h.status === "active"),
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
          " 次。\n" +
          (pause ? "当前暂停主动联系，至 " + pause.ends_at + "。\n" : "") +
          "\n来源：`.agent/state/registry.json`" +
          (record.revision ? "、`" + this.store.dayPath(date) + "`" : "") +
          "。\n此文件为可重建摘要，具体事实以来源文件为准。\n",
      );
      this.summaryError = null;
    } catch {
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
    return {
      input_id: input.id,
      channel: input.channel,
      external_id: input.external_id,
      accepted_at: this.store.now(),
      summary: input.text.slice(0, 250),
    };
  }
  async execute(
    input: Input,
    actions: Action[],
    identity: string,
    authorized = true,
  ): Promise<Execution> {
    const identities = actions
      .map((a) =>
        [
          a.type,
          a.target_id ?? a.title ?? "",
          a.business_date ?? "",
          a.criterion_id ?? "",
          a.path ?? "",
        ].join(":"),
      )
      .sort()
      .join("|");
    return this.store.exclusive(() => {
      this.recoverPending();
      const verified = new Map<string, Source>();
      const verificationActions = actions.flatMap((action) =>
        action.type === "accept_proposal"
          ? (this.store
              .registry()
              .proposals.find((p) => p.id === action.target_id)?.actions ?? [])
          : [action],
      );
      for (const action of verificationActions) {
        if (action.type !== "complete_task") continue;
        const task = this.store
          .registry()
          .tasks.find((t) => t.id === action.target_id);
        for (const criterion of task?.acceptance ?? []) {
          if (
            criterion.verification !== "tool" ||
            criterion.kind !== "artifact" ||
            !criterion.artifact_ref
          )
            continue;
          try {
            const file = this.store.files.resolve(
              criterion.artifact_ref,
              criterion.artifact_ref.startsWith("Attachment/")
                ? "attachment"
                : "document",
            );
            const stat = fs.statSync(file);
            if (
              stat.isFile() &&
              stat.size > 0 &&
              stat.size <= this.store.config.web.max_attachment_bytes
            )
              verified.set(verificationKey(task!.id, criterion), {
                input_id: input.id,
                channel: "tool:artifact_exists",
                external_id: hash(fs.readFileSync(file)),
                accepted_at: this.store.now(),
                summary: "已核验库内交付物存在且非空",
              });
          } catch {
            /* Only the registered workspace artifact checker can grant verification. */
          }
        }
      }
      const result = this.store.commit(
        input.id + ":" + hash(identities),
        input.channel,
        input.id,
        (registry, loadDay, operation, rememberFact) => {
          if (actions.length > 20)
            throw new AppError("BATCH_TOO_LARGE", "一次最多20个动作");
          const context = {
            operation,
            source: this.source(input),
            now: this.store.now(),
            zone: this.store.config.timezone,
            loadDay,
            userAuthorized: authorized,
            rememberFact,
            verified,
            validateNoteRef: (relative: string) => {
              this.store.files.read(relative);
            },
          };
          const acceptedProposals: string[] = [];
          const effective = actions.flatMap((action) => {
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
            if (proposal.actions.some((a) => a.type === "accept_proposal"))
              throw new AppError("AGENT_INVALID", "不允许嵌套接受提案");
            proposal.status = "accepted";
            proposal.version++;
            proposal.last_operation_id = operation;
            acceptedProposals.push(proposal.id);
            return proposal.actions;
          });
          const baseVersions = new Map(
            [...registry.habits, ...registry.tasks].map((item) => [
              item.id,
              item.version,
            ]),
          );
          const ordinary = effective.filter(
            (a) => !["link_diary", "project_diary"].includes(a.type),
          );
          const output = applyActions(registry, ordinary, context);
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
          const scheduledTargets = ordinary
            .filter((a) => a.type === "schedule")
            .map((a) => String(a.target_id));
          if (created || scheduledTargets.length) {
            const date = localDate(
              this.store.clock(),
              this.store.config.timezone,
            );
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
          return output;
        },
      );
      this.store.db.transaction(() => {
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
      })();
      this.flushProjections();
      this.cancelInvalidContact();
      this.rebuildSummary();
      this.emit("item_changed", { ids: result.updated_ids });
      return result;
    });
  }
  flushProjections() {
    const events = this.store.db
      .prepare(
        "SELECT * FROM events WHERE kind='diary_projection' AND status='prepared' ORDER BY rowid",
      )
      .all() as any[];
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
        this.store.db
          .prepare(
            "UPDATE events SET status='conflict',error_code='PROJECTION_CONFLICT' WHERE id=?",
          )
          .run(event.id);
      }
    }
  }
  private cancelInvalidContact() {
    const registry = this.store.registry(),
      now = this.store.now();
    const rows = this.store.db
      .prepare(
        "SELECT id,target_refs_json FROM outbox WHERE counts_as_proactive=1 AND status IN ('pending','failed')",
      )
      .all() as any[];
    for (const row of rows) {
      const refs = JSON.parse(row.target_refs_json) as any[];
      const invalid = refs.some((ref) => {
        const target =
          ref.kind === "habit"
            ? registry.habits.find((h) => h.id === ref.id)
            : registry.tasks.find((t) => t.id === ref.id);
        return (
          !target ||
          !["active", "ready", "in_progress", "blocked"].includes(
            target.status,
          ) ||
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
  ) {
    return this.store.exclusive(() => {
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
      return {
        ...next,
        runtime_degraded: !journaled,
        pending_verifications: actions
          .filter((action) => action.verification_pending === true)
          .map((action) => action.target_id),
      };
    });
  }
  async newPeriod(kind: Period, date: string) {
    return this.store.exclusive(() => {
      const result = createPeriod(this.store, kind, date);
      if (
        kind === "daily" &&
        result.created.includes(result.path) &&
        date === localDate(this.store.clock(), this.store.config.timezone)
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
      return result;
    });
  }
  async receive(input: Input) {
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
        "SELECT id FROM inbox WHERE channel=? AND actor_ref=? AND external_id=?",
      )
      .get(input.channel, input.actor_ref, input.external_id) as any;
    if (old) return { id: old.id, duplicate: true };
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
        "SELECT count(*) AS n FROM inbox WHERE status IN ('pending','processing')",
      )
      .get() as { n: number };
    if (queued.n >= 10 && !/不提醒|暂停/.test(input.text))
      throw new AppError("QUEUE_FULL", "还有事项正在处理，请稍后再交代", 429);
    this.store.db
      .prepare(
        "INSERT INTO inbox(id,channel,actor_ref,external_id,body,metadata_json,received_at,occurred_at) VALUES(?,?,?,?,?,?,?,?)",
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
        }),
        this.store.now(),
        input.occurred_at,
      );
    if (/^(今天)?(先)?(不提醒(了)?|暂停(提醒)?)[。！!\s]*$/.test(input.text)) {
      const result = await this.execute(
        input,
        [{ type: "pause_contact" }],
        "pause",
      );
      this.finishInput(input, result.message);
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
                  type: "update_task_progress",
                  target_id: target.id,
                  expected_version: target.version,
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
    this.store.db
      .prepare(
        "INSERT OR IGNORE INTO outbox(id,channel,recipient_ref,dedupe_key,target_refs_json,source_versions_json,message_kind,body,content_hash,scheduled_at,expires_at,counts_as_proactive,created_at,updated_at) VALUES(?,?,?,?,?,?, 'receipt',?,?,?,?,0,?,?)",
      )
      .run(
        id("out"),
        "qq",
        input.actor_ref,
        input.id + ":reply",
        "[]",
        "{}",
        text.slice(0, 2000),
        hash(text.slice(0, 2000)),
        now,
        DateTime.fromISO(now).plus({ minutes: 10 }).toUTC().toISO(),
        now,
        now,
      );
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
    const items = [
      ...r.habits.filter((x) => x.status === "active"),
      ...r.tasks.filter(
        (x) =>
          !["done", "cancelled"].includes(x.status) || targetIds.includes(x.id),
      ),
    ];
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
        heading: ref.heading,
        content: content.slice(0, 5000),
        truncated: content.length > 5000,
      };
    });
    const userPath = this.store.files.resolve(
      ".agent/context/user.md",
      "internal",
    );
    const preferences = fs.existsSync(userPath)
      ? fs.readFileSync(userPath, "utf8").slice(-2000)
      : "";
    const context = {
      now: this.store.now(),
      business_date: localDate(this.store.clock(), this.store.config.timezone),
      timezone: this.store.config.timezone,
      items: selected.slice(0, 30),
      plans: r.plans
        .filter((x) => x.window_end >= this.store.now())
        .slice(0, 20),
      controls: r.controls.filter((x) => x.ends_at > this.store.now()),
      proposals: r.proposals.filter(
        (x) => x.status === "pending" && x.expires_at > this.store.now(),
      ),
      reply_target_ids: targetIds,
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
          text: row.body.slice(0, 120),
          reply: String(JSON.parse(row.metadata_json).reply ?? "").slice(0, 80),
          at: row.received_at,
        })),
      documents,
    };
    if (JSON.stringify(context).length > 12000)
      throw new AppError("CONTEXT_TOO_LARGE", "相关事项较多，请指定一个事项");
    return context;
  }
  async processPending() {
    if (this.processing || !this.agent || this.stopping) return;
    this.processing = true;
    this.idle = new Promise((resolve) => {
      this.releaseIdle = resolve;
    });
    try {
      for (;;) {
        if (this.stopping) return;
        const row = this.store.db
          .prepare(
            "SELECT * FROM inbox WHERE status='pending' ORDER BY rowid LIMIT 1",
          )
          .get() as any;
        if (!row) break;
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
          const r = this.store.registry(),
            pending = r.proposals.filter(
              (x) => x.status === "pending" && x.expires_at > this.store.now(),
            );
          if (
            /^(好|好的|可以|就这样|同意)[。！!\s]*$/.test(input.text) &&
            pending.length > 1
          ) {
            this.finishInput(
              input,
              "你指哪份安排：" +
                pending
                  .slice(-2)
                  .map((p) => p.summary.slice(0, 35))
                  .join("，还是") +
                "？",
            );
            continue;
          }
          if (
            /^(好|好的|可以|就这样|同意)[。！!\s]*$/.test(input.text) &&
            pending.length === 1
          ) {
            await this.acceptProposal(pending[0].id, pending[0].version, input);
            this.finishInput(input, "已按刚才的安排记下。");
            continue;
          }
          const bundle = this.context(input);
          const result = await this.agent.interpret(input, bundle);
          if (this.stopping) return;
          if (result.action_groups.length > 20)
            throw new AppError("AGENT_INVALID", "提案过多");
          let reply = "";
          const groupErrors: string[] = [];
          let acceptedGroups = 0;
          const groupResults: {
            status: string;
            operation_id?: string;
            reason?: string;
          }[] = [];
          for (const group of result.action_groups) {
            try {
              if (!Array.isArray(group.actions))
                throw new AppError("AGENT_INVALID", "提案结构不正确");
              const known = [...bundle.items, ...bundle.plans];
              for (const action of group.actions) {
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
                  const item = known.find((x) => x.id === action.target_id);
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
                /提醒我|帮我(?:安排|记录|记下|创建|新增|取消)|请(?:安排|记录|记下|创建|新增)|^(?:记住|创建|新增|取消|改成|改到|把)/.test(
                  input.text,
                ) &&
                !/(?:要不要|是否|是不是|该不该|考虑|也许|可能|不想|不要|不需要)/.test(
                  input.text,
                );
              if (newCommitment && !explicit) {
                await this.store.exclusive(() =>
                  this.store.commit(
                    input.id +
                      ":proposal:" +
                      hash(canonicalJson(group.actions)),
                    input.channel,
                    input.id,
                    (registry, _, op) => {
                      registry.proposals.push({
                        id: id("proposal"),
                        version: 1,
                        created_at: this.store.now(),
                        updated_at: this.store.now(),
                        last_operation_id: op,
                        summary: result.summary ?? "建议安排如下",
                        actions: group.actions,
                        expires_at: DateTime.fromISO(this.store.now())
                          .plus({ hours: 24 })
                          .toUTC()
                          .toISO()!,
                        status: "pending",
                        source: this.source(input),
                      });
                      return { ids: [], message: "提案已保存" };
                    },
                  ),
                );
                groupResults.push({ status: "needs_confirmation" });
                this.emit("item_changed", { ids: [] });
                reply = result.summary ?? "这份安排先留作建议，接受后再执行。";
              } else {
                const outcome = await this.execute(
                  input,
                  group.actions,
                  group.action_identity,
                  true,
                );
                reply = outcome.message;
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
          this.store.db
            .prepare(
              "UPDATE inbox SET metadata_json=json_set(metadata_json,'$.groups',json(?)) WHERE id=?",
            )
            .run(JSON.stringify(groupResults), input.id);
          if (groupErrors.length)
            reply =
              (acceptedGroups ? "明确的部分已记下；" : "暂未改动：") +
              groupErrors.slice(0, 1).join("；") +
              "。";
          if (
            reply &&
            !result.clarification &&
            !groupErrors.length &&
            acceptedGroups > 0 &&
            this.agent.compose
          ) {
            try {
              reply = (
                await this.agent.compose({
                  kind: "receipt",
                  message: reply,
                  groups: groupResults,
                  executed: true,
                })
              ).text;
            } catch {
              /* The saved execution is authoritative; composition failure keeps the factual receipt. */
            }
          }
          if (this.stopping) return;
          this.finishInput(
            input,
            result.clarification ?? (reply || result.discussion || "已收到。"),
          );
        } catch (error) {
          if (this.stopping || this.store.closed) return;
          const code =
            error instanceof AppError ? error.code : "AGENT_UNAVAILABLE";
          this.store.db
            .prepare(
              "UPDATE inbox SET status='failed',processed_at=?,error_code=? WHERE id=?",
            )
            .run(this.store.now(), code, input.id);
          this.emit("input_result", {
            id: input.id,
            status: "failed",
            error: code,
            message: "暂未记入，可稍后重试。",
          });
        }
      }
    } finally {
      this.processing = false;
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
  items(date: string) {
    const r = this.store.registry(),
      d = this.store.day(date);
    return {
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
