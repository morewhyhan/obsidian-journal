import { expect, it } from "vitest";
import { plainText } from "../apps/core/plain-text.js";

it("QQ gets plain text: markdown syntax never reaches the chat", () => {
  const input = [
    "## 今天的安排",
    "",
    "**重点**：背单词",
    "",
    "| 时间 | 事项 |",
    "| --- | --- |",
    "| 8:00 | 背单词 |",
    "",
    "- 午睡 13:00",
    "- 早睡 21:50",
    "",
    "详见 [周计划](https://example.com/a_b)。",
    "",
    "```",
    "08:00-10:00 背单词",
    "```",
  ].join("\n");
  const out = plainText(input);
  expect(out).not.toMatch(/[#*|`]/);
  expect(out).toContain("今天的安排");
  expect(out).toContain("重点：背单词");
  expect(out).toContain("8:00 · 背单词");
  expect(out).toContain("· 午睡 13:00");
  expect(out).toContain("周计划（https://example.com/a_b）");
  expect(out).toContain("08:00-10:00 背单词");
});

it("ordinary text survives untouched", () => {
  const text = "今天8点到10点背单词。\n\n午睡还是13点。";
  expect(plainText(text)).toBe(text);
});
