/**
 * Saying "已经写进去了" when the write actually failed is the worst failure mode
 * here: the person stops checking. The receipts already record the truth, so the
 * sentence is corrected before it leaves.
 */
const SUCCESS_CLAIM = /(已经|已)(写|改|保存|更新|建|同步|录)(好|入|进|下|完)?|写进去了|改好了|已经同步|已经记下/;

export function guardSuccessClaim(
  text: string,
  receipts: { status?: string }[],
): { text: string; corrected: boolean } {
  if (!receipts.length) return { text, corrected: false };
  const applied = receipts.some((r) => r.status === "applied" || r.status === "already_applied");
  if (applied) return { text, corrected: false };
  if (!SUCCESS_CLAIM.test(text)) return { text, corrected: false };
  return {
    text: text + "\n\n（更正：这次没有真正写入，文件还是旧的，我再说一遍要改什么。）",
    corrected: true,
  };
}
