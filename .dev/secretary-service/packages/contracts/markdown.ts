/** Byte-preserving ranges for ordinary Markdown links. Code and frontmatter are data. */
export type LinkToken = {
  start: number;
  end: number;
  target: string;
  wiki: boolean;
};
export function visibleLines(content: string) {
  const lines: { text: string; offset: number; visible: boolean }[] = [];
  let offset = 0,
    fence = "",
    length = 0,
    frontmatter = false;
  for (const [index, text] of content.split("\n").entries()) {
    const plain = text.replace(/\r$/, "");
    if (index === 0 && plain === "---") frontmatter = true;
    let visible = !frontmatter && !fence;
    if (frontmatter) {
      visible = false;
      if (index > 0 && /^(---|\.\.\.)$/.test(plain)) frontmatter = false;
    } else {
      const marker = plain.match(/^ {0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) {
          fence = marker[1][0];
          length = marker[1].length;
        } else if (
          marker[1][0] === fence &&
          marker[1].length >= length &&
          /^ {0,3}(`+|~+)\s*$/.test(plain)
        )
          fence = "";
        visible = false;
      }
      if (/^( {4}|\t)/.test(plain)) visible = false;
    }
    lines.push({ text, offset, visible });
    offset += text.length + 1;
  }
  return lines;
}
export function markdownLinks(content: string): LinkToken[] {
  const result: LinkToken[] = [];
  for (const line of visibleLines(content)) {
    if (!line.visible) continue;
    const code: { start: number; end: number }[] = [];
    for (const match of line.text.matchAll(/(`+)[\s\S]*?\1(?!`)/g))
      code.push({ start: match.index!, end: match.index! + match[0].length });
    const safe = (start: number, end: number) =>
      !code.some((c) => c.start < end && c.end > start) &&
      !(start > 0 && line.text[start - 1] === "\\");
    for (const match of line.text.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
      const at = match.index! + (match[0].startsWith("!") ? 3 : 2),
        target = match[1].split(/[|#]/)[0];
      if (target && safe(match.index!, match.index! + match[0].length))
        result.push({
          start: line.offset + at,
          end: line.offset + at + target.length,
          target,
          wiki: true,
        });
    }
    for (const match of line.text.matchAll(
      /!?\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g,
    )) {
      const at =
          match.index! +
          match[0].indexOf("](") +
          2 +
          (match[0].includes("](<") ? 1 : 0),
        target = match[1].split("#")[0];
      if (target && safe(match.index!, match.index! + match[0].length))
        result.push({
          start: line.offset + at,
          end: line.offset + at + target.length,
          target,
          wiki: false,
        });
    }
  }
  return result.sort((a, b) => a.start - b.start);
}
export function replaceLinkTargets(
  content: string,
  edits: { start: number; end: number; before: string; after: string }[],
) {
  let next = content;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    if (next.slice(edit.start, edit.end) !== edit.before)
      throw new Error("Link edit conflict");
    next = next.slice(0, edit.start) + edit.after + next.slice(edit.end);
  }
  return next;
}
