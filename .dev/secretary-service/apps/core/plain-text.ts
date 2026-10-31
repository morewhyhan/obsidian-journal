/**
 * QQ renders plain text only, so Markdown syntax arrives as literal garbage
 * ("**重点**" shows the asterisks). This keeps the meaning and drops the syntax.
 * It is deliberately conservative: only unambiguous Markdown is touched.
 */
export function plainText(body: string) {
  const out = body
    // Fenced code: keep the content, drop the fences.
    .replace(/^\s*```[^\n]*$/gm, "")
    // Headings: keep the words, drop the hashes.
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    // Bold / italic markers.
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, "$1")
    // Inline code.
    .replace(/`([^`\n]+)`/g, "$1")
    // Images then links.
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1（$2）")
    // Table rows: "| a | b |" -> "a · b".
    .replace(/^\s*\|(.+)\|\s*$/gm, (_m, cells: string) =>
      cells.split("|").map((c) => c.trim()).filter(Boolean).join(" · "),
    )
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, "")
    // Horizontal rules.
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, "")
    // Bullets become a lighter dot, ordered lists keep their numbers.
    .replace(/^\s*[-*+]\s+/gm, "· ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out || body.trim();
}
