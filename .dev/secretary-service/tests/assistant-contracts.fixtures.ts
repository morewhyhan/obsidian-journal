import { expect } from "vitest";
import { harness } from "./helpers.js";
import type { Action, Input } from "../packages/contracts/types.js";

const roots: ReturnType<typeof harness>[] = [];

/** Shared fixture for ARCHITECTURE chapter 6 contract tests (S1-S6, E01-E14). */
export function setup(date = "2026-10-26T08:00:00Z") {
  const h = harness(date);
  roots.push(h);
  return h;
}

export async function closeContracts() {
  for (const h of roots.splice(0)) {
    try {
      await h.core.stop();
    } finally {
      await h.close();
    }
  }
}

export const reply = (text: string) => ({
  action_groups: [],
  clarification: null,
  reply_intent: "discussion",
  discussion: text,
});

type Handle = ReturnType<typeof harness>;

/** Injects a model stub that runs inside the real tool loop (businessCall entry). */
export function useModel(
  h: Handle,
  run: (input: Input, context: any) => Promise<any>,
) {
  h.core.agent = { executionMode: "tools-v2", interpret: run };
}

/** One user turn whose model stub is injected for that turn only. */
export async function modelTurn(
  h: Handle,
  text: string,
  run: (input: Input, context: any) => Promise<any>,
) {
  useModel(h, run);
  return turn(h, text);
}

export async function turn(h: Handle, text: string) {
  const input = h.input(text);
  await h.core.receive(input);
  await expect
    .poll(() =>
      h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id),
    )
    .toMatchObject({ status: "processed" });
  return input;
}

export function task(n: number, extra: Partial<Action> = {}): Action {
  return {
    type: "create_task",
    title: "事项" + n,
    outcome: "完成事项" + n,
    due_at: "2026-10-29T10:00:00Z",
    acceptance: [
      { id: "done", kind: "check", description: "完成第" + n + "件" },
    ],
    ...extra,
  } as Action;
}
