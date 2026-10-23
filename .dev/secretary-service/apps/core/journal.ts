import fs from "node:fs";
import path from "node:path";
import {
  AppError,
  type DiaryLink,
  type Registry,
  type Source,
  type Action,
} from "../../packages/contracts/types.js";
import {
  context,
  route,
  type Period,
  day,
  localDate,
} from "../../packages/calendar/index.js";
import { hash, id, atomicWrite } from "./files.js";
import { resource } from "./config.js";
import type { Store } from "./store.js";
import { visibleLines } from "../../packages/contracts/markdown.js";
export type Checkbox = {
  line: number;
  heading: string;
  checked: boolean;
  label: string;
  fingerprint: string;
  start: number;
};
export function checkboxes(content: string): Checkbox[] {
  const found: Checkbox[] = [];
  let heading = "";
  for (const [lineNumber, record] of visibleLines(content).entries()) {
    const { text: line, offset, visible } = record;
    if (visible && /^# /.test(line)) heading = line.slice(2).trim();
    const box =
      visible &&
      ["习惯", "任务"].includes(heading) &&
      line.match(/^( {0,3}[-*+] \[)([ xX])(\] )(.*?)(\r?)$/);
    if (box) {
      const label = box[4].trim();
      found.push({
        line: lineNumber,
        heading,
        checked: box[2].toLowerCase() === "x",
        label,
        fingerprint: hash(heading + "\n" + label),
        start: offset + box[1].length,
      });
    }
  }
  return found;
}
export const templateNames: Record<Period, string> = {
  daily: "日记模版",
  weekly: "周记模版",
  monthly: "月度反思模版",
  quarterly: "季度计划模版",
  yearly: "年度反思模版",
};
export function renderTemplate(template: string, kind: Period, date: string) {
  const c = context(kind, date);
  let output = template.replace(
    /^<%\*\s*const c = tp\.app\.plugins\.plugins\['light-okr'\]\.engine\.context\('[a-z]+', tp\.config\.target_file\.path\);\s*%>/,
    "",
  );
  output = output.replace(/<%\s*c\.(\w+)\s*%>/g, (_, key: string) => {
    if (!(key in c))
      throw new AppError("UNSUPPORTED_TEMPLATE", "模板包含未知字段");
    return String(c[key as keyof typeof c]);
  });
  if (output.includes("<%"))
    throw new AppError(
      "UNSUPPORTED_TEMPLATE",
      "模板含不支持的表达式，未执行",
      422,
    );
  return output;
}
export function createPeriod(store: Store, kind: Period, date: string) {
  const parents: Record<Period, Period[]> = {
    daily: ["monthly", "weekly"],
    weekly: ["monthly"],
    monthly: ["quarterly"],
    quarterly: ["yearly"],
    yearly: [],
  };
  if (!(kind in parents)) throw new AppError("INVALID_PERIOD", "未知周期", 400);
  const needed = new Map<string, { kind: Period; date: string }>();
  function visit(k: Period, value: string) {
    const c = context(k, value),
      p = route(k, c.date);
    if (needed.has(p)) return;
    for (const parent of parents[k]) visit(parent, c.date);
    needed.set(p, { kind: k, date: c.date });
  }
  visit(kind, date);
  const created: string[] = [];
  const pending: { path: string; file: string; content: string }[] = [];
  for (const [canonical, { kind: k, date: periodDate }] of needed) {
    const p = store.files.actualPath(canonical),
      file = store.files.resolve(p);
    if (fs.existsSync(file)) continue;
    const custom = store.files.resolve("Template/" + templateNames[k] + ".md");
    const template = fs.readFileSync(
      fs.existsSync(custom)
        ? custom
        : resource("templates/" + templateNames[k] + ".md"),
      "utf8",
    );
    const rendered = renderTemplate(template, k, periodDate).replace(
      /\[\[([^#|\]]+)(#[^|\]]+)?(\|[^\]]+)?\]\]/g,
      (all, p, heading = "", alias = "") => {
        const canonical = p.endsWith(".md") ? p : p + ".md",
          actual = store.files.actualPath(canonical);
        return actual === canonical
          ? all
          : "[[" + actual.replace(/\.md$/, "") + heading + alias + "]]";
      },
    );
    pending.push({ path: p, file, content: rendered });
  }
  // Validate every needed template before writing any parent or child note.
  for (const entry of pending) {
    if (fs.existsSync(entry.file)) continue;
    atomicWrite(entry.file, entry.content);
    store.index(entry.path);
    created.push(entry.path);
  }
  return { path: store.files.actualPath(route(kind, date)), created };
}
export function bind(
  registry: Registry,
  store: Store,
  targetId: string,
  relative: string,
  label: string,
  source: Source,
  operation: string,
) {
  const entity =
    registry.habits.find((x) => x.id === targetId) ??
    registry.tasks.find((x) => x.id === targetId);
  if (!entity) throw new AppError("ITEM_NOT_FOUND", "事项不存在", 404);
  const heading = "min_behavior" in entity ? "习惯" : "任务";
  const content = store.files.read(relative),
    matches = checkboxes(content).filter(
      (x) => x.heading === heading && x.label === label,
    );
  if (matches.length !== 1)
    throw new AppError("BINDING_AMBIGUOUS", "无法唯一定位该事项", 409);
  const now = store.now(),
    box = matches[0];
  const link: DiaryLink = {
    id: id("link"),
    version: 1,
    created_at: now,
    updated_at: now,
    last_operation_id: operation,
    target_ref: { kind: heading === "习惯" ? "habit" : "task", id: targetId },
    path: relative,
    business_date: relative.match(/(\d{4}-\d{2}-\d{2})\.md$/)?.[1],
    heading,
    line_fingerprint: box.fingerprint,
    position_hint: box.line,
    last_hash: hash(content),
    last_item_version: entity.version,
  };
  registry.diary_links = registry.diary_links.filter(
    (x) => !(x.path === relative && x.target_ref.id === targetId),
  );
  registry.diary_links.push(link);
  return link;
}
export function checkboxActions(
  store: Store,
  relative: string,
  before: string,
  after: string,
): Action[] {
  const registry = store.registry(),
    old = checkboxes(before),
    next = checkboxes(after),
    actions: Action[] = [];
  for (const link of registry.diary_links.filter((x) => x.path === relative)) {
    if (link.status === "pending") continue;
    const prior = old.filter((x) => x.fingerprint === link.line_fingerprint),
      matches = next.filter((x) => x.fingerprint === link.line_fingerprint);
    if (prior.length === 1 && matches.length === 0) {
      actions.push({
        type:
          next.filter((box) => box.heading === link.heading).length <
          old.filter((box) => box.heading === link.heading).length
            ? "unlink_diary"
            : "pending_diary_binding",
        target_id: link.target_ref.id,
        link_id: link.id,
      });
      continue;
    }
    if (matches.length > 1) {
      actions.push({
        type: "pending_diary_binding",
        target_id: link.target_ref.id,
        link_id: link.id,
      });
      continue;
    }
    if (
      matches.length !== 1 ||
      prior.length !== 1 ||
      matches[0].checked === prior[0].checked
    )
      continue;
    const date =
      link.business_date ?? relative.match(/(\d{4}-\d{2}-\d{2})\.md$/)?.[1];
    if (link.target_ref.kind === "habit" && date)
      actions.push({
        type: "report_habit",
        target_id: link.target_ref.id,
        business_date: date,
        status: matches[0].checked ? "did" : "unreported",
      });
    if (link.target_ref.kind === "task") {
      const t = registry.tasks.find((x) => x.id === link.target_ref.id);
      if (
        t?.acceptance.some((condition) => condition.verification === "tool") &&
        matches[0].checked
      ) {
        actions.push({
          type: "update_task_progress",
          target_id: t.id,
          report: "用户已勾选完成，等待工具验收。",
          verification_pending: true,
        });
        continue;
      }
      actions.push({
        type: matches[0].checked ? "complete_task" : "reopen_task",
        target_id: link.target_ref.id,
      });
    }
  }
  return actions;
}
export function project(store: Store, targetIds: string[]) {
  const registry = store.registry();
  const changed: string[] = [];
  for (const link of registry.diary_links.filter((x) =>
    targetIds.includes(x.target_ref.id),
  )) {
    if (link.status === "pending") continue;
    const p = store.files.resolve(link.path);
    if (!fs.existsSync(p)) continue;
    let content = fs.readFileSync(p, "utf8");
    let boxes = checkboxes(content).filter(
      (x) => x.fingerprint === link.line_fingerprint,
    );
    if (boxes.length === 0 && link.allow_append) {
      const target =
        link.target_ref.kind === "habit"
          ? registry.habits.find((x) => x.id === link.target_ref.id)
          : registry.tasks.find((x) => x.id === link.target_ref.id);
      if (!target) continue;
      const lines = content.split("\n"),
        headings = lines
          .map((text, index) => ({ text, index }))
          .filter((x) => x.text.replace(/\r$/, "") === "# " + link.heading);
      if (headings.length !== 1) continue;
      const newline = content.includes("\r\n") ? "\r\n" : "\n";
      let offset = 0;
      for (let i = 0; i <= headings[0].index; i++)
        offset += lines[i].length + 1;
      const prefix = content.slice(0, offset);
      content =
        prefix +
        (prefix.endsWith("\n") ? "" : newline) +
        "- [ ] " +
        target.title +
        newline +
        content.slice(offset);
      atomicWrite(p, content);
      store.index(link.path);
      changed.push(link.path);
      boxes = checkboxes(content).filter(
        (x) => x.fingerprint === link.line_fingerprint,
      );
    }
    if (boxes.length !== 1) continue;
    let checked = false;
    if (link.target_ref.kind === "habit") {
      const date =
        link.business_date ?? link.path.match(/(\d{4}-\d{2}-\d{2})\.md$/)?.[1];
      if (!date) continue;
      checked =
        store
          .day(date)
          .occurrences.find((x) => x.habit_id === link.target_ref.id)
          ?.status === "did";
    } else {
      const t = registry.tasks.find((x) => x.id === link.target_ref.id);
      if (!t) continue;
      checked = t.status === "done" || t.progress.verification_pending === true;
    }
    const box = boxes[0];
    if (box.checked !== checked) {
      const updated =
        content.slice(0, box.start) +
        (checked ? "x" : " ") +
        content.slice(box.start + 1);
      atomicWrite(p, updated);
      store.index(link.path);
      changed.push(link.path);
    }
    const target =
        link.target_ref.kind === "habit"
          ? registry.habits.find((x) => x.id === link.target_ref.id)
          : registry.tasks.find((x) => x.id === link.target_ref.id),
      finalHash = hash(fs.readFileSync(p));
    if (
      link.allow_append ||
      link.last_hash !== finalHash ||
      link.position_hint !== box.line ||
      link.last_item_version !== target?.version
    ) {
      store.commit(
        "binding-meta:" + link.id + ":" + finalHash + ":" + target?.version,
        "core",
        link.id,
        (r, _, operation) => {
          const current = r.diary_links.find((x) => x.id === link.id);
          if (current) {
            current.allow_append = false;
            current.last_hash = finalHash;
            current.position_hint = box.line;
            current.last_item_version =
              target?.version ?? current.last_item_version;
            current.version++;
            current.updated_at = store.now();
            current.last_operation_id = operation;
          }
          return { ids: [], message: "展示行已建立" };
        },
      );
    }
  }
  return [...new Set(changed)];
}
export function prepareAutomaticBindings(
  registry: Registry,
  store: Store,
  date: string,
  targetIds: string[],
  operation: string,
  allowAppend = true,
) {
  const relative = store.files.actualPath(route("daily", date));
  const file = store.files.resolve(relative);
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, "utf8"),
    boxes = checkboxes(content),
    now = store.now();
  for (const targetId of targetIds) {
    if (
      registry.diary_links.some(
        (x) => x.target_ref.id === targetId && x.path === relative,
      )
    )
      continue;
    const target =
      registry.habits.find((h) => h.id === targetId && h.status === "active") ??
      registry.tasks.find(
        (t) => t.id === targetId && !["draft", "cancelled"].includes(t.status),
      );
    if (!target || !target.approval) continue;
    const heading = "min_behavior" in target ? "习惯" : "任务",
      matches = boxes.filter(
        (x) => x.heading === heading && x.label === target.title,
      );
    if (matches.length > 1) continue;
    if (!matches.length && !allowAppend) continue;
    if ("min_behavior" in target) {
      if (
        !target.recurrence.weekdays.includes(day(date).weekday) ||
        target.recurrence.starts_on > date ||
        (target.recurrence.ends_on && target.recurrence.ends_on < date)
      )
        continue;
    } else if (
      !matches.length &&
      !registry.plans.some(
        (p) =>
          p.target_ref.id === target.id &&
          p.status !== "cancelled" &&
          localDate(new Date(p.window_start), store.config.timezone) === date,
      )
    )
      continue;
    const found = matches[0];
    registry.diary_links.push({
      id: id("link"),
      version: 1,
      created_at: now,
      updated_at: now,
      last_operation_id: operation,
      target_ref: { kind: heading === "习惯" ? "habit" : "task", id: targetId },
      path: relative,
      business_date: date,
      heading,
      line_fingerprint:
        found?.fingerprint ?? hash(heading + "\n" + target.title),
      position_hint: found?.line ?? -1,
      last_hash: hash(content),
      last_item_version: target.version,
      allow_append: !found,
    });
  }
}
