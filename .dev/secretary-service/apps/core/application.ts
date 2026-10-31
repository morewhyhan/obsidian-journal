import fs from "node:fs";
import type { Core } from "./core.js";
import type { GitWorker } from "./git.js";
import {
  localDate,
  route,
  type Period,
  day,
} from "../../packages/calendar/index.js";
import { AppError } from "../../packages/contracts/types.js";
import { toolMutation,assertToolSession } from "./tool-effects.js";
import { requireCapability } from "./policy.js";
import { businessCall, type BusinessCall } from "./agent-runtime.js";
import { checkGrant } from "./background-grant.js";
import { recordQuery,queryStamp,advanceOwnReads } from "./read-stamps.js";
import { searchFacts } from "./facts.js";
import { actionSchema } from "../../packages/contracts/api.js";
import { actionFields } from "../../packages/contracts/action-fields.js";

export const applicationCapabilities = {
  period_creation: {
    tool: "secretary",
    operation: "create_period",
    kinds: ["daily", "weekly", "monthly", "quarterly", "yearly"],
    defaults: "daily、服务器业务日期",
    templates:
      "优先使用仓库Template中的五类模板；缺失时使用服务自带底模。目录为空也能说明和调用现有引擎，不需要用户定义字段。",
    behavior:
      "使用Template现有模板和统一日历引擎渲染，自动补齐缺失父计划；不覆盖现有笔记，不执行任意Templater脚本。不要手写日期元数据/父链接，不需要用户解释规则或打开Obsidian。",
  },
  business: {
    personal:
      "rules/automations/focus/board/planning_context按需读取；自主工具模式用apply_changes执行规则、自动化和计时动作，纯消息提醒用create_automation。",
    planning:
      "secretary.planning按日期读取真实安排、待决冲突、准备资料入口和已确认可用时间；自主工具模式用apply_changes办理plan_day/set_planning/configure_task/report_execution。",
    read: "secretary.state/day 按需查询所有习惯、任务、安排和历史事实；空的预载上下文不等于没有记录",
    write: "secretary.apply_changes直接执行，带读取到的id/version；save_proposals保留未定建议；resolve_proposals决定原建议，不重复新建",
  },
  files: {
    tool: "workspace",
    operations: ["list", "search", "read", "write", "edit", "rename", "delete"],
    root: "list不填path或path为.均表示根目录；支持分页；普通读取不需要确认",
    period_rule:
      "首次创建日/周/月/季/年笔记必须使用secretary.create_period，现有正文可以通过workspace编辑",
  },
  recovery: {
    tool: "secretary",
    operations: [
      "trash",
      "restore_note",
      "history",
      "history_content",
      "restore_version",
    ],
    limits: "删除保留7天；Git历史取决于实际备份配置，不能凭空承诺云备份",
  },
  status: {
    tool: "secretary",
    operation: "status",
    includes: ["模型", "QQ", "调度", "备份", "清理", "恢复状态"],
  },
  privacy:
    "读取日记只按用户请求；不把模板占位目录当作真实年份记录；不把日记正文复制到业务台账或记忆。",
};

export type ApplicationCall = {
  input_id: string;
  call_id: string;
  operation:
    | "apply_changes" | "save_proposals" | "resolve_proposals" | "conversation"
    | "rules"
    | "automations"
    | "focus"
    | "board"
    | "planning_context"
    | "preferences"
    | "followups"
    | "planning"
    | "capabilities"
    | "periods"
    | "create_period"
    | "state"
    | "day"
    | "status"
    | "trash"
    | "restore_note"
    | "history"
    | "history_content"
    | "restore_version";
  kind?: Period;
  date?: string;
  scope?: "habits" | "tasks" | "plans" | "controls" | "proposals" | "all";
  query?: string;
  ids?: string[];
  offset?: number;
  path?: string;
  recovery_id?: string;
  commit?: string;
  base_hash?: string;
  summary?: string;
  commit_mode?: BusinessCall["commit_mode"];
  action_groups?: BusinessCall["action_groups"];
  decisions?: BusinessCall["decisions"];
};
export async function applicationCall(
  core: Core,
  args: ApplicationCall,
  extra: { status: () => unknown; backup: GitWorker },
) {
  if (["apply_changes", "save_proposals", "resolve_proposals"].includes(args.operation))
    return businessCall(core, args as BusinessCall);
  if (["create_period", "restore_note", "restore_version"].includes(args.operation))
    return toolMutation(core, args, () => applicationOperation(core, args, extra));
  const snapshot=core.store.registry(),stamp=queryStamp(core.store,args,snapshot);
  const result=await applicationOperation(core,args,extra);
  recordQuery(core.store,args.input_id,args,snapshot,stamp);
  // Query results carry the view they were read from, so a later commit is detectable.
  return result && typeof result==="object" && !Array.isArray(result)
    ? {...result,snapshot_revision:core.store.snapshotRevision()} : result;
}
async function applicationOperation(
  core: Core,
  args: ApplicationCall,
  extra: { status: () => unknown; backup: GitWorker },
) {
  const s = core.store;
  const session = s.db
    .prepare("SELECT status,channel,metadata_json FROM inbox WHERE id=?")
    .get(args.input_id) as any;
  if (session?.status !== "processing")
    throw new AppError(
      "APPLICATION_SESSION_EXPIRED",
      "不属于正在处理的用户请求",
      403,
    );
  if (
    JSON.parse(session.metadata_json ?? "{}").read_only &&
    ["create_period", "restore_note", "restore_version"].includes(
      args.operation,
    )
  )
    throw new AppError("DISCUSSION_ONLY", "本轮只讨论或查询，不执行变更", 403);
  if (
    session.channel === "coordinator" &&
    ![
      "capabilities",
      "rules",
      "preferences",
      "followups",
      "automations",
      "focus",
      "board",
      "planning_context",
      "planning",
      "state",
      "day",
      "periods",
    ].includes(args.operation)
  )
    throw new AppError(
      "PLANNING_SCOPE",
      "周期作业不能修改文件或读取私人叙述",
      403,
    );
  const offset = args.offset ?? 0;
  if(session.channel==="coordinator" && JSON.parse(session.metadata_json).background_grant) {
    const g=checkGrant(s,args.input_id);
    if(args.operation==="state") {
      const r=s.registry(),wanted=args.ids??g.object_ids;
      if(wanted.some(id=>!g.object_ids.includes(id)))throw new AppError("BACKGROUND_SCOPE","查询对象超出委托范围",403);
      const all=[...r.tasks,...r.habits,...r.plans,...r.proposals,...r.user_rules??[]].filter(x=>wanted.includes(x.id));
      return {items:all.slice(offset,offset+20),total:all.length,next_offset:offset+20<all.length?offset+20:null};
    }
    if(args.operation==="followups")return {items:[s.registry().followups!.find(f=>f.id===g.work_id)],next_offset:null};
    if(args.operation!=="capabilities")throw new AppError("BACKGROUND_SCOPE","当前委托仅允许相关事项和固定路径查询",403);
  }
  if (!Number.isInteger(offset) || offset < 0)
    throw new AppError("INVALID_OFFSET", "无效分页位置");
  const date = args.date ?? localDate(s.clock(), s.config.timezone);
  day(date);
  const key = args.input_id + ":application:" + args.call_id;
  if (args.operation === "capabilities") {
    if(args.query && actionFields[args.query]) {
      const type=args.query,source:any=actionSchema;
      const restrictions=source.allOf.filter((rule:any)=>rule.if?.properties?.type?.const===type || rule.if?.properties?.type?.enum?.includes(type)).map((rule:any)=>rule.then);
      return {action:type,schema:{type:"object",additionalProperties:false,required:["type"],
        properties:Object.fromEntries(actionFields[type].filter(k=>k in source.properties).map(k=>[k,k==="type"?{const:type}:source.properties[k]])),
        allOf:restrictions},authority:"生成源契约的动作投影，实际提交仍经过完整双端校验"};
    }
    return applicationCapabilities;
  }
  if (args.operation === "conversation") {
    const caller = s.db.prepare("SELECT channel,actor_ref FROM inbox WHERE id=?").get(args.input_id) as any;
    const rows = s.db.prepare("SELECT id,body,metadata_json,status,received_at FROM inbox WHERE channel=? AND actor_ref=? AND id<>? ORDER BY rowid DESC LIMIT 8 OFFSET ?")
      .all(caller.channel, caller.actor_ref, args.input_id, offset) as any[];
    return { items: rows.reverse().map(row => ({
      id: row.id, text: String(row.body ?? "").slice(0, 6000),
      reply: String(JSON.parse(row.metadata_json).reply ?? "").slice(0, 6000),
      status: row.status, at: row.received_at,
      proposals: JSON.parse(row.metadata_json).offered_proposal_ids ?? [],
    })), next_offset: rows.length === 8 ? offset + 8 : null };
  }
  if (args.operation === "followups") {
    const found = (s.registry().followups ?? []).filter(
      (f) =>
        (!args.ids?.length ||
          args.ids.includes(f.id) ||
          args.ids.includes(f.issue.task_id ?? f.issue.habit_id ?? "")) &&
        (!args.query ||
          JSON.stringify(f).toLowerCase().includes(args.query.toLowerCase())),
    );
    const selected=found.slice(offset,offset+10);
    const row=s.db.prepare("SELECT metadata_json FROM inbox WHERE id=?").get(args.input_id) as any;
    const access=JSON.parse(row.metadata_json).observed_refs??[];
    s.db.prepare("UPDATE inbox SET metadata_json=json_set(metadata_json,'$.observed_refs',json(?)) WHERE id=?")
      .run(JSON.stringify([...new Map([...access,...selected.map(f=>({id:f.id,version:f.version}))].map(x=>[x.id,x])).values()]),args.input_id);
    return {
      items: selected,
      next_offset: offset + 10 < found.length ? offset + 10 : null,
    };
  }
  if (
    ["rules", "automations", "focus", "board", "planning_context"].includes(
      args.operation,
    )
  ) {
    const view = core.assistant.view();
    const meta = s.db
      .prepare("SELECT metadata_json FROM inbox WHERE id=?")
      .get(args.input_id) as any;
    const previous = JSON.parse(meta.metadata_json).observed_refs ?? [];
    s.db
      .prepare(
        "UPDATE inbox SET metadata_json=json_set(metadata_json,'$.observed_refs',json(?)) WHERE id=?",
      )
      .run(
        JSON.stringify([
          ...new Map(
            [...previous, ...view.objects].map((x) => [x.id, x]),
          ).values(),
        ]),
        args.input_id,
      );
    if (args.operation === "rules") {
      const matching = view.rules.filter((x) => !args.query || x.key.includes(args.query));
      return {
        revision: view.rules_revision,
        items: matching.slice(offset, offset + 20),
        next_offset: offset + 20 < matching.length ? offset + 20 : null,
        values: view.values,
        planning: view.planning,
      };
    }
    if (args.operation === "automations")
      return {
        items: view.automations.slice(offset, offset + 20),
        next_offset: offset + 20 < view.automations.length ? offset + 20 : null,
        occurrences: (s.day(date).automation_occurrences ?? [])
          .slice(offset, offset + 20)
          .map((x) => ({ ...x, business_date: date })),
      };
    if (args.operation === "planning_context")
      return core.assistant.context(date);
    return args.operation === "focus" ? { focus: view.focus } : view.board;
  }
  if (args.operation === "planning") {
    const view = core.coordinator.view(date);
    const r = s.registry();
    const grants = [...r.tasks, ...r.habits, ...view.plans].map((e) => ({
      id: e.id,
      version: e.version,
    }));
    const meta = s.db
      .prepare("SELECT metadata_json FROM inbox WHERE id=?")
      .get(args.input_id) as any;
    const previous = JSON.parse(meta.metadata_json).observed_refs ?? [];
    s.db
      .prepare(
        "UPDATE inbox SET metadata_json=json_set(metadata_json,'$.observed_refs',json(?)) WHERE id=?",
      )
      .run(
        JSON.stringify([
          ...new Map([...previous, ...grants].map((x) => [x.id, x])).values(),
        ]),
        args.input_id,
      );
    return view;
  }
  if (args.operation === "preferences") {
    const purpose =
      session.channel === "coordinator"
        ? JSON.parse(session.metadata_json ?? "{}").planning_job
          ? "planning"
          : "support"
        : "all";
    const memory = core.assistant.preferences(
      args.query,
      args.ids ?? [],
      purpose,
    );
    const content = args.query
      ? memory.content
          .split(/\r?\n/)
          .filter((x) => x.toLowerCase().includes(args.query!.toLowerCase()))
          .join("\n")
      : memory.content;
    // Facts are paged by their own offset: the memory text offset below is a
    // character cursor and must not be reused as a row index.
    const facts = searchFacts(core.store, args.query ?? "", core.store.now(), 20, offset, true);
    return {
      content: content.slice(offset, offset + 4000),
      next_offset: offset + 4000 < content.length ? offset + 4000 : null,
      facts: facts.items,
      facts_total: facts.total,
      facts_next_offset: facts.next_offset,
      principles: memory.principles.slice(offset, offset + 10),
      principles_next_offset:
        offset + 10 < memory.principles.length ? offset + 10 : null,
      authority: "仅用户明确确认的事实与工作原则；不授予文件、权限或外部承诺。",
    };
  }
  if (args.operation === "status") return extra.status();
  if (args.operation === "periods") {
    day(date);
    return {
      date,
      periods: Object.fromEntries(
        (["yearly", "quarterly", "monthly", "weekly", "daily"] as Period[]).map(
          (kind) => {
            const p = s.files.actualPath(route(kind, date));
            return [
              kind,
              { path: p, exists: fs.existsSync(s.files.resolve(p)) },
            ];
          },
        ),
      ),
    };
  }
  if (args.operation === "create_period") {
    const result = await core.newPeriod(args.kind ?? "daily", date,()=>{assertToolSession(s,args);requireCapability(s,"business_write");},()=>advanceOwnReads(s,args.input_id));
    return {
      ...result,
      template_applied: result.created.includes(result.path),
      existing: !result.created.includes(result.path),
      hash: s.document(result.path).hash,
    };
  }
  if (args.operation === "state") {
    const r = s.registry();
    const scopes =
      args.scope && args.scope !== "all"
        ? [args.scope]
        : (["habits", "tasks", "plans", "controls", "proposals"] as const);
    const all = scopes.flatMap((scope) =>
      (r[scope] as any[]).map((entity) => ({ scope, ...entity })),
    );
    const found = all.filter(
      (e) =>
        (!args.ids?.length || args.ids.includes(e.id)) &&
        (!args.query ||
          JSON.stringify(e)
            .toLocaleLowerCase()
            .includes(args.query.toLocaleLowerCase())),
    );
    const selected: any[] = [];
    let size = 0;
    for (const e of found.slice(offset, offset + 20)) {
      const n = JSON.stringify(e).length;
      if (selected.length && size + n > 14000) break;
      selected.push(e);
      size += n;
    }
    const meta = s.db
      .prepare("SELECT metadata_json FROM inbox WHERE id=?")
      .get(args.input_id) as any;
    const prior = JSON.parse(meta.metadata_json).observed_refs ?? [];
    const grants = [
      ...new Map(
        [
          ...prior,
          ...selected.map((e) => ({ id: e.id, version: e.version })),
        ].map((e) => [e.id, e]),
      ).values(),
    ];
    s.db
      .prepare(
        "UPDATE inbox SET metadata_json=json_set(metadata_json,'$.observed_refs',json(?)) WHERE id=?",
      )
      .run(JSON.stringify(grants), args.input_id);
    return {
      items: selected,
      total: found.length,
      next_offset:
        offset + selected.length < found.length
          ? offset + selected.length
          : null,
    };
  }
  if (args.operation === "day") {
    day(date);
    const record = s.day(date);
    return {
      date,
      revision: record.revision,
      occurrences: record.occurrences.slice(offset, offset + 20),
      corrections: record.corrections.slice(offset, offset + 20),
      next_offset:
        offset + 20 <
        Math.max(record.occurrences.length, record.corrections.length)
          ? offset + 20
          : null,
    };
  }
  if (args.operation === "trash") {
    const all = core.documents.listTrash();
    return {
      entries: all.slice(offset, offset + 20),
      total: all.length,
      next_offset: offset + 20 < all.length ? offset + 20 : null,
    };
  }
  if (args.operation === "restore_note") {
    if (!args.recovery_id)
      throw new AppError("INVALID_RECOVERY", "需要恢复标识");
    return s.exclusive(() => {
      assertToolSession(s,args);requireCapability(s,"business_write");
      const result = core.documents.restoreTrash(args.recovery_id!, key);
      core.emit("document_changed", { path: result.path });
      return result;
    });
  }
  if (!args.path) throw new AppError("INVALID_PATH", "需要笔记路径");
  s.files.resolve(args.path);
  if (!extra.backup.options.enabled)
    throw new AppError(
      "BACKUP_DISABLED",
      "Git备份当前未启用，没有可用的自动备份历史",
      409,
    );
  if (args.operation === "history")
    return { entries: await extra.backup.history(args.path) };
  if (!args.commit) throw new AppError("INVALID_COMMIT", "需要历史版本标识");
  const content = await extra.backup.content(args.path, args.commit);
  if (args.operation === "history_content")
    return {
      path: args.path,
      commit: args.commit,
      content: content.slice(offset, offset + 10000),
      next_offset: offset + 10000 < content.length ? offset + 10000 : null,
    };
  if (args.operation === "restore_version")
    return core.saveDocument(args.path, args.base_hash ?? "", content, key,()=>assertToolSession(s,args));
  throw new AppError("INVALID_OPERATION", "不支持此应用操作");
}
