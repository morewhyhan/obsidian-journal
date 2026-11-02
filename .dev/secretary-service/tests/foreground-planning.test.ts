import { expect, it, vi } from "vitest";
import { harness } from "./helpers.js";

it("a slow planning pass does not hold up the next foreground message", async () => {
  const h = harness();
  let finishPlanning!: () => void;
  const planning = new Promise<void>(resolve => { finishPlanning = resolve; });
  vi.spyOn(h.core.assistant, "startPlanning").mockImplementation(() => {});
  vi.spyOn(h.core.assistant, "drain").mockImplementation(() => planning);
  const seen: string[] = [];
  h.core.agent = {
    executionMode: "tools-v2",
    interpret: async input => {
      seen.push(input.text);
      return { action_groups: [], clarification: null, reply_intent: "discussion", discussion: "回答" };
    },
  };
  try {
    for (const text of ["问题一", "问题二", "问题三"]) {
      const input = h.input(text);
      await h.core.receive(input);
      await expect.poll(() => seen.includes(text)).toBe(true);
      await expect.poll(() => (h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id) as any)?.status).toBe("processed");
    }
    await h.core.receive(h.input("问题四"));
    await expect.poll(() => seen.includes("问题四"), { timeout: 300 }).toBe(true);
  } finally {
    finishPlanning();
    await h.core.stop();
    await h.close();
    vi.restoreAllMocks();
  }
});
