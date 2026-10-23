import { useEffect, useMemo, useState } from "react";
import MarkdownIt from "markdown-it";
import { api, type Document } from "./api";
import {
  markdownLinks,
  replaceLinkTargets,
} from "../../../packages/contracts/markdown";
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
export function resolveWiki(target: string, paths: string[]) {
  const raw = target.split("|")[0].split("#")[0];
  const p = raw.endsWith(".md") ? raw : raw + ".md";
  if (paths.includes(p)) return p;
  const found = paths.filter((x) => x.endsWith("/" + p));
  return found.length === 1 ? found[0] : p;
}
function section(content: string, heading?: string) {
  if (!heading) return content;
  const lines = content.split("\n"),
    start = lines.findIndex(
      (l) => /^#+ /.test(l) && l.replace(/^#+ /, "").trim() === heading,
    );
  if (start < 0) return "";
  const level = lines[start].match(/^#+/)![0].length;
  let end = start + 1;
  while (
    end < lines.length &&
    !new RegExp("^#{1," + level + "} ").test(lines[end])
  )
    end++;
  return lines.slice(start + 1, end).join("\n");
}
function render(text: string, paths: string[]) {
  const edits: { start: number; end: number; before: string; after: string }[] =
    [];
  for (const link of markdownLinks(text).filter((x) => x.wiki)) {
    let start = link.start - 2;
    const image = start > 0 && text[start - 1] === "!";
    if (image) start--;
    const end = text.indexOf("]]", link.end) + 2;
    if (end < 2) continue;
    const raw = text.slice(link.start, end - 2),
      [target, label] = raw.split("|");
    const after =
      image && target.startsWith("Attachment/")
        ? "![](/api/v1/attachments?path=" + encodeURIComponent(target) + ")"
        : "[" +
          (label ?? target.split("/").at(-1)!).replace(/[\[\]]/g, "") +
          "](/notes?path=" +
          encodeURIComponent(resolveWiki(target, paths)) +
          ")";
    edits.push({ start, end, before: text.slice(start, end), after });
  }
  return md.render(
    replaceLinkTargets(text, edits).replace(
      /^```(?:dataviewjs|dataview|templater)[^\n]*\n[\s\S]*?^```/gm,
      "> 此动态区块在 Obsidian 中运行。",
    ),
  );
}
function Embed({
  raw,
  paths,
  onOpen,
  ancestors,
  depth,
}: {
  raw: string;
  paths: string[];
  onOpen: (p: string) => void;
  ancestors: string[];
  depth: number;
}) {
  const target = resolveWiki(raw, paths),
    heading = raw.split("|")[0].split("#")[1];
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (depth >= 3 || ancestors.includes(target)) return;
    api<Document>("/documents?path=" + encodeURIComponent(target))
      .then((doc) => {
        if (active) setContent(section(doc.content, heading));
      })
      .catch(() => {
        if (active) setContent(null);
      });
    return () => {
      active = false;
    };
  }, [target, heading, depth]);
  return (
    <aside className="parent-reference">
      <button onClick={() => onOpen(target)}>
        {raw.split("|")[1] ?? heading ?? "父级计划"} <span>↗</span>
      </button>
      {depth >= 3 || ancestors.includes(target) ? (
        <small>已省略循环引用</small>
      ) : content === null ? (
        <small>还未创建，点击打开</small>
      ) : (
        <Preview
          content={content}
          paths={paths}
          onOpen={onOpen}
          ancestors={[...ancestors, target]}
          depth={depth + 1}
        />
      )}
    </aside>
  );
}
export function Preview({
  content,
  paths,
  onOpen,
  ancestors = [],
  depth = 0,
}: {
  content: string;
  paths: string[];
  onOpen: (p: string) => void;
  ancestors?: string[];
  depth?: number;
}) {
  const parts = useMemo(() => {
    const chunks: { text?: string; embed?: string }[] = [];
    let last = 0;
    const ordinary = new Set(
      markdownLinks(content)
        .filter((x) => x.wiki)
        .map((x) => x.start),
    );
    for (const match of content.matchAll(
      /!\[\[((?!Attachment\/)[^\]]+)\]\]/g,
    )) {
      if (!ordinary.has(match.index! + 3)) continue;
      chunks.push(
        { text: content.slice(last, match.index) },
        { embed: match[1] },
      );
      last = match.index! + match[0].length;
    }
    chunks.push({ text: content.slice(last) });
    return chunks;
  }, [content]);
  return (
    <div
      className="markdown-preview"
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest("a");
        if (anchor?.getAttribute("href")?.startsWith("/notes?")) {
          event.preventDefault();
          onOpen(new URL(anchor.href).searchParams.get("path")!);
        }
      }}
    >
      {parts.map((part, i) =>
        part.embed ? (
          <Embed
            key={i}
            raw={part.embed}
            paths={paths}
            onOpen={onOpen}
            ancestors={ancestors}
            depth={depth}
          />
        ) : (
          <div
            key={i}
            dangerouslySetInnerHTML={{ __html: render(part.text ?? "", paths) }}
          />
        ),
      )}
    </div>
  );
}
