/**
 * People text in short bursts: one thought per bubble, 1-3 bubbles per reply.
 * QQ shows each outbox row as a separate message, so the split happens here,
 * before queueing, and only at sentence boundaries — never mid-sentence.
 */
const SENTENCE_END = /(?<=[。！？!?…])|(?<=[.](?=\s|$))/;

export function splitMessages(
  text: string,
  options: { maxChars?: number; maxBubbles?: number } = {},
) {
  const maxChars = options.maxChars ?? 55;
  const maxBubbles = options.maxBubbles ?? 3;
  const body = (text ?? "").trim();
  if (!body) return [];
  // A block that already carries its own structure (a list or a document the user
  // asked for) is kept as one message: splitting a list line by line spams.
  const listLines = body.split(/\r?\n/).filter((line) => /^\s*(\d+[.、]|·|[-*])\s+/.test(line));
  if (listLines.length >= 3) return [body];
  if (body.length <= maxChars) return [body];

  const sentences = body
    .split(SENTENCE_END)
    .map((part) => part.trim())
    .filter(Boolean);
  const bubbles: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const candidate = current ? current + sentence : sentence;
    if (candidate.length > maxChars && current) {
      bubbles.push(current);
      current = sentence;
    } else current = candidate;
  }
  if (current) bubbles.push(current);
  if (bubbles.length <= maxBubbles) return bubbles;
  // Too many small bubbles is as noisy as one wall of text: fold the tail in.
  return [...bubbles.slice(0, maxBubbles - 1), bubbles.slice(maxBubbles - 1).join("")];
}
