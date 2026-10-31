import type { Store } from "./store.js";

/**
 * Observable proxies for "did the assistant make the person repeat themselves".
 * These read existing records only; they are not a success rate and must be read
 * next to a human sample, which is why every number carries its own definition.
 */
export function burdenMetrics(store: Store, days = 7) {
  const since = new Date(Date.parse(store.now()) - days * 86400000).toISOString();
  const rows = store.db
    .prepare(
      "SELECT body FROM inbox WHERE channel='qq' AND body IS NOT NULL AND received_at>=? ORDER BY rowid",
    )
    .all(since) as { body: string }[];
  const normalize = (text: string) =>
    text.toLowerCase().replace(/[\s，。！？、,.!?~～]+/g, "").slice(0, 80);
  const seen = new Map<string, number>();
  let repeats = 0;
  for (const row of rows) {
    const key = normalize(row.body);
    if (!key) continue;
    if (seen.has(key)) repeats++;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const corrections = rows.filter((row) =>
    /(不是|错了|不对|重新|再说一遍|我说的是)/.test(row.body),
  ).length;
  const questions = (
    store.db
      .prepare(
        "SELECT count(*) n FROM outbox WHERE message_kind='receipt' AND status IN ('sent','unknown') AND created_at>=? AND body LIKE '%？%'",
      )
      .get(since) as { n: number }
  ).n;
  const failed = (
    store.db
      .prepare("SELECT count(*) n FROM inbox WHERE status='failed' AND received_at>=?")
      .get(since) as { n: number }
  ).n;
  const retried = (
    store.db
      .prepare(
        "SELECT count(*) n FROM outbox WHERE attempts>0 AND created_at>=?",
      )
      .get(since) as { n: number }
  ).n;
  return {
    window_days: days,
    user_messages: rows.length,
    repeated_statements: repeats,
    correction_messages: corrections,
    questions_asked: questions,
    failed_inputs: failed,
    retried_deliveries: retried,
    definitions: {
      repeated_statements: "同一句原话（忽略标点空白）在窗口内出现两次以上，且不是同一条事件",
      correction_messages: "原话里出现“不是/错了/不对/重新/再说一遍/我说的是”",
      questions_asked: "已发出的回执里带问号的条数",
      failed_inputs: "状态 failed 的入件（模型/渠道失败）",
      retried_deliveries: "尝试次数大于 0 的出件",
    },
    caveat: "代理指标，不是成功率；需要配合人工抽样",
  };
}
