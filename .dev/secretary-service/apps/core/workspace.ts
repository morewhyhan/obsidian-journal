import fs from "node:fs";
import path from "node:path";
import type { Core } from "./core.js";
import { atomicWrite, hash } from "./files.js";
import { checkboxActions } from "./journal.js";
import { AppError } from "../../packages/contracts/types.js";

export type WorkspaceCall = {
  input_id: string;
  call_id: string;
  operation:
    "list" | "search" | "read" | "write" | "edit" | "rename" | "delete";
  path?: string;
  query?: string;
  content?: string;
  old_text?: string;
  new_text?: string;
  new_path?: string;
  base_hash?: string;
  offset?: number;
};

// The Agent chooses operations, not host paths. All I/O remains with the single
// Core writer and the same path guards used by the editor. No shell exists.
export async function workspaceCall(core: Core, args: WorkspaceCall) {
  const s = core.store;
  const input = s.db
    .prepare("SELECT status FROM inbox WHERE id=?")
    .get(args.input_id) as any;
  if (!input || input.status !== "processing")
    throw new AppError(
      "WORKSPACE_SESSION_EXPIRED",
      "工作区调用不属于正在处理的用户请求",
      403,
    );
  const key = args.input_id + ":workspace:" + args.call_id;
  const offset = args.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0)
    throw new AppError("INVALID_OFFSET", "无效分页位置");
  if (args.operation === "list" || args.operation === "search") {
    const paths = s.files.list();
    if (fs.existsSync(s.files.resolve(".agent/context/memory.md")))
      paths.push(".agent/context/memory.md");
    const directories = new Set(
      fs
        .readdirSync(s.files.root, { withFileTypes: true })
        .filter(
          (d) =>
            d.isDirectory() && !d.isSymbolicLink() && !d.name.startsWith("."),
        )
        .map((d) => d.name),
    );
    for (const p of paths.filter((p) => !p.startsWith("."))) {
      let parent = path.posix.dirname(p);
      while (parent !== ".") {
        directories.add(parent);
        parent = path.posix.dirname(parent);
      }
    }
    const prefix = !args.path || args.path === "." ? "" : args.path;
    if (
      prefix &&
      !directories.has(prefix.replace(/\/$/, "")) &&
      !paths.some(
        (p) => p === prefix || p.startsWith(prefix.replace(/\/$/, "") + "/"),
      )
    )
      throw new AppError("NOT_FOUND", "未找到可访问的笔记目录", 404);
    const all = paths.filter(
      (p) =>
        !prefix ||
        p === prefix ||
        p.startsWith(prefix.replace(/\/$/, "") + "/"),
    );
    if (args.operation === "list")
      return {
        paths: all.slice(offset, offset + 100),
        directories: [...directories]
          .filter(
            (d) => !prefix || d.startsWith(prefix.replace(/\/$/, "") + "/"),
          )
          .sort()
          .slice(offset, offset + 100),
        total: all.length,
        next_offset:
          offset + 100 <
          Math.max(
            all.length,
            [...directories].filter(
              (d) => !prefix || d.startsWith(prefix.replace(/\/$/, "") + "/"),
            ).length,
          )
            ? offset + 100
            : null,
      };
    const q = (args.query ?? "").toLocaleLowerCase();
    if (!q || q.length > 200)
      throw new AppError("INVALID_QUERY", "搜索词需为1至200字符");
    const matches = all.flatMap((p) => {
      let body = "";
      try {
        body = s.files.read(p);
      } catch (e) {
        if (!(e instanceof AppError) || e.code !== "DOCUMENT_TOO_LARGE")
          throw e;
      }
      const at = body.toLocaleLowerCase().indexOf(q);
      return p.toLocaleLowerCase().includes(q) || at >= 0
        ? [
            {
              path: p,
              snippet:
                at >= 0
                  ? body.slice(Math.max(0, at - 40), Math.max(0, at - 40) + 180)
                  : "",
            },
          ]
        : [];
    });
    return {
      results: matches.slice(offset, offset + 20),
      total: matches.length,
      next_offset: offset + 20 < matches.length ? offset + 20 : null,
    };
  }
  if (!args.path) throw new AppError("INVALID_PATH", "需要库内相对路径");
  const file = s.files.resolve(args.path);
  if (args.operation === "read") {
    const document = s.document(args.path);
    return {
      path: document.path,
      hash: document.hash,
      content: document.content.slice(offset, offset + 10000),
      total_chars: document.content.length,
      next_offset:
        offset + 10000 < document.content.length ? offset + 10000 : null,
    };
  }
  if (args.operation === "write" || args.operation === "edit") {
    if (!fs.existsSync(file)) {
      if (
        /^01\. Daily\/\d{4}年\//.test(args.path) &&
        /(?:\d{4}-\d{2}-\d{2}|年度计划|年计划|季度计划|月度计划|月计划|周计划|周记)\.md$/.test(
          args.path,
        )
      )
        throw new AppError(
          "PERIOD_CREATION_REQUIRED",
          "日/周/月/季/年笔记须使用secretary.create_period调用现有模板引擎，再读取和编辑正文；不能手工创建。",
          409,
        );
      if (
        args.operation !== "write" ||
        typeof args.content !== "string" ||
        args.base_hash
      )
        throw new AppError("NOT_FOUND", "笔记不存在", 404);
      if (Buffer.byteLength(args.content) > s.config.web.max_document_bytes)
        throw new AppError("DOCUMENT_TOO_LARGE", "笔记过大", 413);
      return s.exclusive(() => {
        // Recheck after the writer lock: an intervening Web create wins.
        if (fs.existsSync(file))
          throw new AppError("PATH_EXISTS", "目标文件已存在，请先读取", 409);
        atomicWrite(file, args.content!);
        core.emit("document_changed", { path: args.path });
        return { path: args.path, hash: hash(args.content!), written: true };
      });
    }
    const current = s.document(args.path);
    if (current.hash !== args.base_hash)
      throw new AppError(
        "DOCUMENT_CONFLICT",
        "请先读取当前文件并使用返回的hash",
        409,
      );
    let content = args.content;
    if (args.operation === "edit") {
      if (
        !args.old_text ||
        typeof args.new_text !== "string" ||
        current.content.split(args.old_text).length !== 2
      )
        throw new AppError(
          "EDIT_AMBIGUOUS",
          "替换原文必须在文件中恰好出现一次",
        );
      content = current.content.replace(args.old_text, () => args.new_text!);
    }
    if (typeof content !== "string")
      throw new AppError("INVALID_CONTENT", "缺少笔记正文");
    if (checkboxActions(s, args.path, current.content, content).length)
      throw new AppError(
        "BUSINESS_TOOL_REQUIRED",
        "绑定的习惯任务状态须通过业务提案更新，不能直接编辑复选框",
        403,
      );
    const result = await core.saveDocument(
      args.path,
      args.base_hash!,
      content,
      key,
    );
    return { path: result.path, hash: result.hash, written: true };
  }
  return s.exclusive(() => {
    if (args.operation === "rename") {
      if (!args.new_path) throw new AppError("INVALID_PATH", "需要新路径");
      const result = core.documents.rename(
        args.path!,
        args.new_path,
        args.base_hash!,
        key,
      );
      core.emit("document_changed", {
        path: args.path,
        renamed_to: result.path,
      });
      core.emit("document_changed", { path: result.path });
      return {
        path: result.path,
        hash: result.hash,
        warnings: result.warnings,
      };
    }
    if (args.operation === "delete") {
      const result = core.documents.delete(args.path!, args.base_hash!, key);
      core.emit("document_changed", { path: args.path, deleted: true });
      return result;
    }
    throw new AppError("INVALID_OPERATION", "不支持此工作区操作");
  });
}
