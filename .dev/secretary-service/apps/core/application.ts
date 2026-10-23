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
    read: "secretary.state/day 按需查询所有习惯、任务、安排和历史事实；空的预载上下文不等于没有记录",
    write: "submit_proposal 业务动作，带读取到的id/version",
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
    | "preferences"
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
};
export async function applicationCall(
  core: Core,
  args: ApplicationCall,
  extra: { status: () => unknown; backup: GitWorker },
) {
  const s = core.store;
  const session = s.db
    .prepare("SELECT status FROM inbox WHERE id=?")
    .get(args.input_id) as any;
  if (session?.status !== "processing")
    throw new AppError(
      "APPLICATION_SESSION_EXPIRED",
      "不属于正在处理的用户请求",
      403,
    );
  const offset = args.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0)
    throw new AppError("INVALID_OFFSET", "无效分页位置");
  const date = args.date ?? localDate(s.clock(), s.config.timezone);
  const key = args.input_id + ":application:" + args.call_id;
  if (args.operation === "capabilities") return applicationCapabilities;
  if (args.operation === "preferences") {
    const p = s.files.resolve(".agent/context/user.md", "internal"),
      content = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
    return {
      content: content.slice(offset, offset + 4000),
      next_offset: offset + 4000 < content.length ? offset + 4000 : null,
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
    const result = await core.newPeriod(args.kind ?? "daily", date);
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
    const prior = JSON.parse(meta.metadata_json).authorized_objects ?? [];
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
        "UPDATE inbox SET metadata_json=json_set(metadata_json,'$.authorized_objects',json(?)) WHERE id=?",
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
    return core.saveDocument(args.path, args.base_hash ?? "", content, key);
  throw new AppError("INVALID_OPERATION", "不支持此应用操作");
}
