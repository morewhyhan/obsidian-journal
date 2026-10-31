import fs from "node:fs";

import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { businessCall } from "../apps/core/agent-runtime.js";
import { applicationCall } from "../apps/core/application.js";
import { workspaceCall } from "../apps/core/workspace.js";
import { Scheduler } from "../apps/core/scheduler.js";
import {
  closeContracts,
  modelTurn,
  reply,
  setup,
  task,
  turn,
  useModel,
} from "./assistant-contracts.fixtures.js";
import { temporary } from "./helpers.js";
import { atomicWrite, hash } from "../apps/core/files.js";
import { patchFocus } from "../apps/core/journal.js";
import { activeFacts, readFacts } from "../apps/core/facts.js";
import { route } from "../packages/calendar/index.js";

afterEach(closeContracts);

describe("E01 a group whose second action breaks a domain rule changes nothing", () => {
  it("E01 no file, index or applied effect survives a rejected group", async () => {
    const h = setup();
    useModel(h, async (input) => {
      const before = fs.readFileSync(h.store.files.resolve(".agent/state/registry.json", "internal"), "utf8");
      const result = await businessCall(h.core, {
        input_id: input.id,
        call_id: "atomic-group",
        operation: "apply_changes",
        action_groups: [
          {
            action_identity: "pair",
            actions: [
              {
                type: "create_task",
                title: "会失败的一组",
                outcome: "拿到结果",
                due_at: "2026-10-24T10:00:00Z",
                acceptance: [{ id: "done", kind: "check", description: "拿到结果" }],
              },
              // A task that would leave the active state without acceptance is refused.
              { type: "create_task", title: "缺少验收", outcome: "无", due_at: "2026-10-24T10:00:00Z", status: "ready" },
            ],
          },
        ],
      } as any);
      expect(result.results[0].status).toBe("rejected");
      // Nothing was written: the registry file is byte-identical and no task exists.
      expect(fs.readFileSync(h.store.files.resolve(".agent/state/registry.json", "internal"), "utf8")).toBe(before);
      expect(h.store.registry().tasks).toHaveLength(0);
      expect(
        h.store.db
          .prepare("SELECT count(*) n FROM events WHERE kind='business' AND status='applied'")
          .get(),
      ).toMatchObject({ n: 0 });
      return reply("这组没办成。");
    });
    await turn(h, "建两个任务");
  });
});

describe("E02 independent groups survive a partial failure exactly once", () => {
  it("E02 retrying a corrected batch does not repeat the group that already succeeded", async () => {
    const h = setup();
    const seen: any = {};
    useModel(h, async (input) => {
      const batch = (callId: string, second: any) => ({
        input_id: input.id,
        call_id: callId,
        operation: "apply_changes" as const,
        commit_mode: "independent_groups" as const,
        action_groups: [
          {
            action_identity: "good",
            actions: [
              {
                type: "create_task",
                title: "好的一组",
                outcome: "拿到结果",
                due_at: "2026-10-24T10:00:00Z",
                acceptance: [{ id: "done", kind: "check", description: "拿到结果" }],
              },
            ],
          },
          { action_identity: "bad", actions: [second] },
        ],
      });
      const broken = { type: "create_task", title: "坏的一组", outcome: "无", due_at: "2026-10-24T10:00:00Z", status: "ready" };
      seen.first = await businessCall(h.core, batch("split-batch", broken) as any);
      seen.replay = await businessCall(h.core, batch("split-batch", broken) as any);
      seen.fixed = await businessCall(h.core, batch("split-batch-fixed", {
        type: "create_task", title: "坏的一组", outcome: "拿到结果", due_at: "2026-10-24T10:00:00Z",
        acceptance: [{ id: "done", kind: "check", description: "拿到结果" }],
      }) as any);
      return reply("两组都办好了。");
    });
    await turn(h, "办两件事");
    expect(seen.first.results[0].status).toBe("applied");
    expect(seen.first.results[1].status).toBe("rejected");
    expect(seen.replay.results.map((r: any) => r.status)).toEqual(["applied", "rejected"]);
    expect(seen.fixed.results[0]).toMatchObject({ status: "applied", already_applied: true });
    expect(seen.fixed.results[1].status).toBe("applied");
    expect(h.store.registry().tasks.map((t) => t.title).sort()).toEqual(["坏的一组", "好的一组"]);
  });
});

describe("E13 atomic proposal saving", () => {
  it("E13 all_or_nothing saves no proposal when the second group is invalid", async () => {
    const h = setup();
    useModel(h, async (input) => {
      const result = await businessCall(h.core, {
        input_id: input.id,
        call_id: "atomic-save",
        operation: "save_proposals",
        commit_mode: "all_or_nothing",
        action_groups: [
          { action_identity: "one", actions: [task(1)] },
          { action_identity: "two", actions: [{ type: "not_a_real_action" }] },
        ],
      });
      expect(result.results.map((r: any) => r.status)).toEqual([
        "rejected",
        "rejected",
      ]);
      return reply("这一批有一项不合法，整批都没有保存。");
    });
    await turn(h, "这两项先都存成建议。");
    expect(h.store.registry().proposals).toHaveLength(0);
    expect(h.store.registry().tasks).toHaveLength(0);
  });

  it("E13 independent mode keeps the valid group and reports the invalid one", async () => {
    const h = setup();
    useModel(h, async (input) => {
      const result = await businessCall(h.core, {
        input_id: input.id,
        call_id: "independent-save",
        operation: "save_proposals",
        commit_mode: "independent_groups",
        action_groups: [
          { action_identity: "one", actions: [task(1)] },
          { action_identity: "two", actions: [{ type: "not_a_real_action" }] },
        ],
      });
      expect(result.results.map((r: any) => r.status)).toEqual([
        "pending_decision",
        "rejected",
      ]);
      return reply("第一项存成建议，第二项格式不合法没有保存。");
    });
    await turn(h, "这两项先都存成建议。");
    expect(h.store.registry().proposals).toHaveLength(1);
    expect(h.store.registry().proposals[0].actions[0].title).toBe("事项1");
  });
});

describe("D01 request contract strictness", () => {
  it("D01 rejects an unknown operation instead of silently treating it as a decision", async () => {
    const h = setup();
    useModel(h, async (input) => {
      await expect(
        businessCall(h.core, {
          input_id: input.id,
          call_id: "unknown-op",
          operation: "delete_everything" as any,
          action_groups: [{ action_identity: "one", actions: [task(1)] }],
        }),
      ).rejects.toMatchObject({ code: "INVALID_COMMAND" });
      return reply("这个命令不受支持，没有执行。");
    });
    await turn(h, "随便试试");
    expect(h.store.registry().tasks).toHaveLength(0);
    expect(h.store.registry().proposals).toHaveLength(0);
  });

  it("D01 rejects an unsupported contract version and mixed decisions", async () => {
    const h = setup();
    useModel(h, async (input) => {
      await expect(
        businessCall(h.core, {
          input_id: input.id,
          call_id: "bad-version",
          operation: "apply_changes",
          contract_version: 2 as any,
          action_groups: [{ action_identity: "one", actions: [task(1)] }],
        }),
      ).rejects.toMatchObject({ code: "INVALID_COMMAND" });
      await expect(
        businessCall(h.core, {
          input_id: input.id,
          call_id: "mixed",
          operation: "apply_changes",
          action_groups: [{ action_identity: "one", actions: [task(1)] }],
          decisions: [
            { target_id: "p1", expected_version: 1, decision: "accept" },
          ],
        }),
      ).rejects.toMatchObject({ code: "INVALID_COMMAND" });
      return reply("命令不合法，没有执行。");
    });
    await turn(h, "随便试试");
    expect(h.store.registry().tasks).toHaveLength(0);
  });

  it("D01 every group receipt carries identity, changed_refs, projection and error stage", async () => {
    const h = setup();
    useModel(h, async (input) => {
      const result = await businessCall(h.core, {
        input_id: input.id,
        call_id: "receipts",
        operation: "apply_changes",
        action_groups: [
          { action_identity: "good", actions: [task(1)] },
          {
            action_identity: "bad",
            actions: [{ ...task(2), acceptance: [] } as any],
          },
        ],
      });
      const [good, bad] = result.results as any[];
      expect(good).toMatchObject({
        identity: "good",
        status: "applied",
        already_applied: false,
        projection: { status: "applied" },
      });
      expect(good.changed_refs).toEqual([
        expect.objectContaining({ kind: "task", id: expect.any(String) }),
      ]);
      expect(bad).toMatchObject({
        identity: "bad",
        status: "rejected",
        changed_refs: [],
        already_applied: false,
        error: { code: "INVALID_ACCEPTANCE", stage: "validation", retry: "none" },
      });
      return reply("第一件已保存，第二件验收为空没有保存。");
    });
    await turn(h, "这两件都办一下。");
    expect(h.store.registry().tasks).toHaveLength(1);
  });
});

describe("D04b accepted input order", () => {
  it("D04b each accepted input takes the next seq and a duplicate takes none", async () => {
    const h = setup();
    useModel(h, async () => reply("收到。"));
    const first = await turn(h, "第一件事。");
    const second = await turn(h, "第二件事。");
    const row = (id: string) =>
      h.store.db.prepare("SELECT seq FROM inbox WHERE id=?").get(id) as { seq: number };
    expect(row(first.id).seq).toBeGreaterThan(0);
    expect(row(second.id).seq).toBe(row(first.id).seq + 1);
    const before = row(second.id).seq;
    const duplicate = await h.core.receive(second);
    expect(duplicate.duplicate).toBe(true);
    expect(row(second.id).seq).toBe(before);
    expect(
      (h.store.db.prepare("SELECT MAX(seq) AS n FROM inbox").get() as any).n,
    ).toBe(before);
  });
});

describe("D08 delivered display set", () => {
  it("D08 a proposal is recorded as displayed only after the channel accepted it", async () => {
    const h = setup();
    useModel(h, async (input) => {
      await businessCall(h.core, {
        input_id: input.id,
        call_id: "offer",
        operation: "save_proposals",
        summary: "四项草案",
        action_groups: [{ action_identity: "one", actions: [task(1)] }],
      });
      return reply("草案在这里，等你决定。");
    });
    const input = { ...h.input("先给建议"), channel: "qq" };
    await h.core.receive(input);
    await expect
      .poll(() => h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id))
      .toMatchObject({ status: "processed" });
    const proposal = h.store.registry().proposals[0];
    const before = JSON.parse(
      (h.store.db.prepare("SELECT metadata_json FROM inbox WHERE id=?").get(input.id) as any)
        .metadata_json,
    );
    expect(before.delivered_display_set ?? []).toEqual([]);

    const sent: string[] = [];
    const channel = {
      health: () => ({ connected: true, lastEventAt: null }),
      send: async (message: any) => {
        sent.push(message.body);
        return { status: "sent" as const, externalId: "sent-1" };
      },
    };
    h.core.agent = {
      executionMode: "tools-v2",
      interpret: async () => reply(""),
      compose: async () => ({ text: "补充" }),
    } as any;
    const scheduler = new Scheduler(h.core, channel as any, "user");
    try {
      await scheduler.tick();
    } finally {
      scheduler.close();
    }
    expect(sent).toHaveLength(1);
    const after = JSON.parse(
      (h.store.db.prepare("SELECT metadata_json FROM inbox WHERE id=?").get(input.id) as any)
        .metadata_json,
    );
    expect(after.delivered_display_set).toHaveLength(1);
    expect(after.delivered_display_set[0]).toMatchObject({
      id: proposal.id,
      sequence: 1,
    });
    expect(after.delivered_display_set[0].outbox_id).toBeTruthy();
    expect(after.delivered_display_set[0].sent_at).toBeTruthy();
    // The model sees what was actually accepted by the channel.
    const context = h.core.context(h.input("刚才那几项怎么安排？")) as any;
    const sets = context.delivered_display_sets as any[];
    expect(sets).toHaveLength(1);
    expect(sets[0].input_id).toBe(input.id);
    expect(sets[0].items.map((item: any) => item.id)).toEqual([proposal.id]);
  });
});

describe("E12d reminder invalidation is a consumer", () => {
  it("E12d a cancelled or unconfirmed reminder check is recorded and retried", async () => {
    const h = setup();
    useModel(h, async (input) => {
      const result = await businessCall(h.core, {
        input_id: input.id,
        call_id: "reminder-consumer",
        operation: "apply_changes",
        action_groups: [
          {
            action_identity: "task",
            actions: [
              {
                type: "create_task",
                title: "整理桌面",
                outcome: "桌面干净",
                due_at: "2026-10-28T10:00:00Z",
                acceptance: [{ id: "done", kind: "check", description: "桌面干净" }],
              },
            ],
          },
        ],
      } as any);
      expect(result.results[0].status).toBe("applied");
      return reply("记下了。");
    });
    await turn(h, "提醒我整理桌面");
    const event = () =>
      h.store.db
        .prepare("SELECT id,status,payload_json FROM events WHERE kind='reminder_validity' ORDER BY rowid DESC LIMIT 1")
        .get() as any;
    expect(event().status).toBe("applied");
    // A crash before the reminder check leaves it prepared; the consumer finishes it.
    h.store.db.prepare("UPDATE events SET status='prepared',completed_at=NULL WHERE id=?").run(event().id);
    (h.core as any).flushReminderValidity();
    expect(event().status).toBe("applied");
    expect(h.store.db.prepare("SELECT completed_at FROM events WHERE id=?").get(event().id)).toMatchObject({
      completed_at: h.store.now(),
    });
  });
});

describe("E12c work coordination is a confirmed consumer", () => {
  it("E12c every commit records one work consumer, and an unconfirmed one is retried", async () => {
    const h = setup();
    useModel(h, async (input) => {
      const result = await businessCall(h.core, {
        input_id: input.id,
        call_id: "work-consumer",
        operation: "apply_changes",
        action_groups: [
          {
            action_identity: "task",
            actions: [
              {
                type: "create_task",
                title: "交材料",
                outcome: "材料到位",
                due_at: "2026-10-27T10:00:00Z",
                acceptance: [{ id: "done", kind: "check", description: "材料到位" }],
              },
            ],
          },
        ],
      } as any);
      expect(result.results[0].status).toBe("applied");
      return reply("记下了。");
    });
    await turn(h, "周五前把材料交给我");
    const event = () =>
      h.store.db
        .prepare("SELECT id,status,payload_json FROM events WHERE kind='work_reconcile' ORDER BY rowid DESC LIMIT 1")
        .get() as any;
    expect(event().status).toBe("applied");
    const payload = JSON.parse(event().payload_json);
    expect(payload.operation).toBeTruthy();
    expect(payload.source).toBeTruthy();

    // A crash before confirmation leaves it prepared; the consumer finishes it later.
    h.store.db.prepare("UPDATE events SET status='prepared' WHERE id=?").run(event().id);
    (h.core as any).flushWorkReconcile();
    expect(event().status).toBe("applied");
    expect(
      h.store.db.prepare("SELECT count(*) n FROM events WHERE kind='work_reconcile'").get(),
    ).toMatchObject({ n: 1 });
  });
});

describe("E12 consumer recovery", () => {
  it("E12 a business commit whose projection was never registered is completed once after restart", async () => {
    const h = setup("2026-10-26T08:00:00Z");
    await modelTurn(h, "今天按这个安排。", async (input) => {
      await businessCall(h.core, {
        input_id: input.id,
        call_id: "create",
        operation: "apply_changes",
        action_groups: [
          {
            action_identity: "create",
            actions: [
              {
                ...task(1),
                initial_plan: {
                  kind: "fixed",
                  window_start: "2026-10-26T08:00:00Z",
                  window_end: "2026-10-26T09:00:00Z",
                  duration_minutes: 60,
                  next_action: "打开资料A",
                },
              },
            ],
          },
        ],
      });
      return reply("已经安排进今天。");
    });
    const op = (
      h.store.db
        .prepare("SELECT id FROM events WHERE kind='business' AND status='applied' ORDER BY rowid DESC LIMIT 1")
        .get() as { id: string }
    ).id;
    // Simulate a crash right after the business files were applied and before
    // the projection consumer was registered.
    h.store.db.prepare("DELETE FROM events WHERE kind='diary_projection'").run();
    expect(
      h.store.db.prepare("SELECT count(*) n FROM events WHERE kind='diary_projection'").get(),
    ).toMatchObject({ n: 0 });
    expect(h.store.registry().diary_links.length).toBeGreaterThan(0);
    const linksBefore = h.store.registry().diary_links.length;

    await h.restart();
    h.core.recoverPending();

    const pendingBusiness = (
      h.store.db
        .prepare(
          "SELECT count(*) n FROM events WHERE kind='business' AND status='applied' AND json_array_length(payload_json,'$.result.updated_ids')>0",
        )
        .get() as { n: number }
    ).n;
    const projections = h.store.db
      .prepare("SELECT status,parent_id FROM events WHERE kind='diary_projection'")
      .all() as { status: string; parent_id: string }[];
    // One consumer per applied operation, each confirmed once.
    expect(projections).toHaveLength(pendingBusiness);
    expect(projections.every((row) => row.status === "applied")).toBe(true);
    expect(new Set(projections.map((row) => row.parent_id)).size).toBe(projections.length);
    // Business work is not repeated and the diary binding is not duplicated.
    expect(h.store.registry().tasks).toHaveLength(1);
    expect(h.store.registry().diary_links.length).toBe(linksBefore);
    h.core.recoverPending();
    expect(
      h.store.db.prepare("SELECT count(*) n FROM events WHERE kind='diary_projection'").get(),
    ).toMatchObject({ n: pendingBusiness });
  });
});

describe("E12b period projection keeps a retry window", () => {
  it("E12b a period note edited during projection is retried after its window", async () => {
    const h = setup();
    const notePath = "02. Areas/2026 年.md";
    const original = "# 2026 年\n\n# 年度重点\n旧内容\n\n# 其他\n保留\n";
    atomicWrite(h.store.files.resolve(notePath, "internal"), original);
    const updated = patchFocus(original, "年度重点", "年度重点：稳住节奏");
    const payload = (extra: object = {}) => ({
      path: notePath,
      heading: "年度重点",
      content: "年度重点：稳住节奏",
      replace: false,
      base_hash: hash(original),
      target_hash: hash(updated),
      ...extra,
    });
    const insert = (status: string, body: object) =>
      h.store.db
        .prepare("INSERT INTO events(id,dedupe_key,input_id,source,kind,payload_json,created_at,status) VALUES(?,?,?,?,?,?,?,?)")
        .run("period-1", "period-1", "input-fixture", "core", "period_projection", JSON.stringify(body), h.store.now(), status);
    insert("prepared", payload());
    (h.core as any).flushPeriodProjections();
    const state = () =>
      h.store.db.prepare("SELECT status,payload_json FROM events WHERE id='period-1'").get() as any;
    expect(state().status).toBe("applied");
    expect(fs.readFileSync(h.store.files.resolve(notePath, "internal"), "utf8")).toBe(updated);

    // The note is edited while a second projection is pending: a conflict with a window.
    h.store.db.prepare("DELETE FROM events WHERE id='period-1'").run();
    atomicWrite(h.store.files.resolve(notePath, "internal"), updated);
    insert("prepared", payload({ base_hash: hash(original) }));
    // The person keeps editing the note while the projection is pending.
    const edited = original + "手写补充\n";
    atomicWrite(h.store.files.resolve(notePath, "internal"), edited);
    (h.core as any).flushPeriodProjections();
    expect(state().status).toBe("conflict");
    const failed = JSON.parse(state().payload_json);
    expect(failed.attempts).toBe(1);
    expect(Date.parse(failed.next_retry_at)).toBeGreaterThan(Date.parse(h.store.now()));

    // Once the note is back to the expected base and the window passes, it finishes.
    atomicWrite(h.store.files.resolve(notePath, "internal"), original);
    h.advance(6 * 60000);
    (h.core as any).flushPeriodProjections();
    expect(state().status).toBe("applied");
    expect(fs.readFileSync(h.store.files.resolve(notePath, "internal"), "utf8")).toBe(updated);
  });
});

describe("E04 projection conflict retry", () => {
  it("E04 a conflicted projection retries only after its window and keeps the user text", async () => {
    const h = setup("2026-10-26T08:00:00Z");
    await modelTurn(h, "今天按这个安排。", async (input) => {
      await businessCall(h.core, {
        input_id: input.id,
        call_id: "create",
        operation: "apply_changes",
        action_groups: [
          {
            action_identity: "create",
            actions: [
              {
                ...task(1),
                initial_plan: {
                  kind: "fixed",
                  window_start: "2026-10-26T08:00:00Z",
                  window_end: "2026-10-26T09:00:00Z",
                  duration_minutes: 60,
                  next_action: "打开资料A",
                },
              },
            ],
          },
        ],
      });
      return reply("已经安排进今天。");
    });
    const daily = h.store.files.list().find((p) => p.endsWith("2026-10-26.md"))!;
    atomicWrite(h.store.files.resolve(daily), h.store.files.read(daily) + "\n用户原文\n");
    // Simulate a projection that conflicted and is not yet due for retry.
    h.store.db
      .prepare(
        "UPDATE events SET status='conflict',error_code='PROJECTION_CONFLICT',payload_json=json_set(payload_json,'$.attempts',1,'$.next_retry_at',?) WHERE kind='diary_projection'",
      )
      .run("2026-10-26T09:00:00Z");
    h.core.flushProjections();
    expect(
      h.store.db.prepare("SELECT status FROM events WHERE kind='diary_projection'").all(),
    ).toEqual([{ status: "conflict" }]);
    // Once the window passes, the consumer retries and the user's text survives.
    h.store.db
      .prepare(
        "UPDATE events SET payload_json=json_set(payload_json,'$.next_retry_at',?) WHERE kind='diary_projection'",
      )
      .run("2026-10-26T07:00:00Z");
    h.core.flushProjections();
    expect(
      h.store.db.prepare("SELECT status FROM events WHERE kind='diary_projection'").all(),
    ).toEqual([{ status: "applied" }]);
    expect(h.store.files.read(daily)).toContain("用户原文");
    expect(h.store.registry().tasks).toHaveLength(1);
  });
});

describe("D05 outbox grouping and order", () => {
  it("D05 a long reply keeps one group and a stable part order", async () => {
    const h = setup();
    useModel(h, async () => reply("甲".repeat(2000)));
    const input = { ...h.input("把这件事说清楚。"), channel: "qq" };
    await h.core.receive(input);
    await expect
      .poll(() =>
        h.store.db.prepare("SELECT status FROM inbox WHERE id=?").get(input.id),
      )
      .toMatchObject({ status: "processed" });
    const rows = h.store.db
      .prepare("SELECT dedupe_key,metadata_json FROM outbox ORDER BY rowid")
      .all() as { dedupe_key: string; metadata_json: string }[];
    expect(rows.map((r) => r.dedupe_key)).toEqual([
      input.id + ":reply",
      input.id + ":reply:2",
    ]);
    const metas = rows.map((r) => JSON.parse(r.metadata_json));
    expect(metas.map((m) => m.sequence)).toEqual([1, 2]);
    expect(metas.every((m) => m.reply_group === input.id && m.purpose === "reply")).toBe(true);

    const sent: string[] = [];
    const channel = {
      health: () => ({ connected: true, lastEventAt: null }),
      send: async (message: any) => {
        sent.push(message.body);
        return { status: "sent" as const, externalId: "sent-" + sent.length };
      },
    };
    h.core.agent = {
      executionMode: "tools-v2",
      interpret: async () => reply(""),
      compose: async () => ({ text: "补充说明" }),
    } as any;
    const scheduler = new Scheduler(h.core, channel as any, "user");
    try {
      await scheduler.tick();
      expect(sent).toHaveLength(1);
      await scheduler.tick();
      expect(sent).toHaveLength(2);
      // Parts go out in sequence: the second chunk is the tail of the same text.
      expect(sent[0].length).toBeGreaterThan(0);
      expect(sent[0] + sent[1]).toContain("甲甲");
    } finally {
      scheduler.close();
    }
  });
});

describe("S2 remembered facts", () => {
  it("S2 a reported fact is found by other wording, and a correction supersedes it", async () => {
    const h = setup();
    await modelTurn(h, "记一下：我说小蓝指那本蓝封面词汇本。", async (input) => {
      const result = await businessCall(h.core, {
        input_id: input.id,
        call_id: "remember-blue",
        operation: "apply_changes",
        action_groups: [
          {
            action_identity: "remember",
            actions: [
              {
                type: "remember_fact",
                fact: "我说小蓝指那本蓝封面词汇本。",
                kind: "user_confirmed",
                fact_subject: "小蓝",
                fact_scope: ["学习"],
              },
            ],
          },
        ],
      });
      expect(result.results[0].status).toBe("applied");
      return reply("记下了。");
    });
    const factsPath = h.store.files.resolve(".agent/context/facts.json", "internal");
    const stored = JSON.parse(fs.readFileSync(factsPath, "utf8"));
    expect(stored.facts).toHaveLength(1);
    const first = stored.facts[0];
    expect(first).toMatchObject({
      kind: "user_reported",
      subject: "小蓝",
      scope: ["学习"],
      status: "active",
    });
    expect(first.source).toMatchObject({ kind: "input" });
    expect(first.source.id).toBeTruthy();
    expect(Array.isArray(first.used_event_ids)).toBe(true);

    let found: any[] = [];
    await modelTurn(h, "先拿小蓝接着学", async (input) => {
      const prefs: any = await applicationCall(
        h.core,
        { input_id: input.id, call_id: "prefs", operation: "preferences", query: "蓝封面词汇本" },
        {} as any,
      );
      found = prefs.facts;
      const context = h.core.context(input) as any;
      expect(context.facts.map((f: any) => f.id)).toContain(first.id);
      // Internal facts are not a note path the model may open directly.
      await expect(
        workspaceCall(h.core, {
          input_id: input.id,
          call_id: "peek-facts",
          operation: "read",
          path: ".agent/context/facts.json",
        } as any),
      ).rejects.toMatchObject({ code: "PATH_FORBIDDEN" });
      return reply("就是那本蓝封面的词汇本。");
    });
    // Different wording still finds the stored explanation.
    expect(found.map((f) => f.id)).toContain(first.id);
    expect(found.find((f) => f.id === first.id).source.id).toBe(first.source.id);

    await modelTurn(h, "小蓝现在指新词汇本，旧称不用了", async (input) => {
      const result = await businessCall(h.core, {
        input_id: input.id,
        call_id: "correct-blue",
        operation: "apply_changes",
        action_groups: [
          {
            action_identity: "correct",
            actions: [
              {
                type: "remember_fact",
                fact: "小蓝现在指新词汇本。",
                kind: "user_confirmed",
                fact_subject: "小蓝",
                fact_scope: ["学习"],
                supersedes: first.id,
              },
            ],
          },
        ],
      });
      expect(result.results[0].status).toBe("applied");
      return reply("好，小蓝改成新词汇本。");
    });
    const corrected = JSON.parse(fs.readFileSync(factsPath, "utf8"));
    const old = corrected.facts.find((f: any) => f.id === first.id);
    const fresh = corrected.facts.find((f: any) => f.content === "小蓝现在指新词汇本。");
    expect(old.status).toBe("superseded");
    expect(old.superseded_by).toBe(fresh.id);
    expect(fresh.status).toBe("active");
    expect(fresh.supersedes).toEqual([first.id]);

    await modelTurn(h, "小蓝是哪一本", async (input) => {
      const prefs: any = await applicationCall(
        h.core,
        { input_id: input.id, call_id: "prefs2", operation: "preferences", query: "小蓝" },
        {} as any,
      );
      found = prefs.facts;
      const context = h.core.context(input) as any;
      expect(context.facts.some((f: any) => f.id === first.id)).toBe(false);
      return reply("现在指新词汇本。");
    });
    expect(found.some((f: any) => f.id === first.id)).toBe(false);
    expect(found.some((f: any) => f.content === "小蓝现在指新词汇本。")).toBe(true);
  });
});

describe("E10 a broken fact file is refused instead of silently falling back", () => {
  it("E10 an interrupted fact write is reported and never answered from the old copy", async () => {
    const h = setup();
    useModel(h, async (input) => {
      await businessCall(h.core, {
        input_id: input.id,
        call_id: "remember",
        operation: "apply_changes",
        action_groups: [
          {
            action_identity: "remember",
            actions: [
              {
                type: "remember_fact",
                fact: "我一般周日晚上整理下周安排。",
                kind: "user_confirmed",
                fact_subject: "周日晚整理",
                fact_scope: ["安排"],
              },
            ],
          },
        ],
      } as any);
      return reply("记下了。");
    });
    await turn(h, "记住：周日晚上我整理下周安排");
    const file = h.store.files.resolve(".agent/context/facts.json", "internal");
    const good = fs.readFileSync(file, "utf8");
    expect(good).toContain("整理下周安排");

    // A half-finished write leaves broken JSON on disk.
    fs.writeFileSync(file, good.slice(0, Math.floor(good.length / 2)), "utf8");
    expect(() => readFacts(h.store)).toThrow("不是有效 JSON");
    // No silent fallback to an older copy or to user.md: retrieval refuses.
    expect(() => activeFacts(h.store, h.store.now())).toThrow();
    // Once the file is repaired the same fact is readable again, exactly once.
    fs.writeFileSync(file, good, "utf8");
    expect(activeFacts(h.store, h.store.now())).toHaveLength(1);
  });
});

describe("D07 forgetting a fact", () => {
  const remember = (text: string) => ({
    type: "remember_fact",
    fact: text,
    kind: "user_confirmed",
    fact_subject: "小蓝",
    fact_scope: ["学习"],
  });

  it("D07 leaves only an opaque marker, stops retrieval and keeps unrelated work", async () => {
    const h = setup();
    await h.run(task(1));
    await modelTurn(h, "记一下：小蓝指蓝封面词汇本。", async (input) => {
      await businessCall(h.core, {
        input_id: input.id,
        call_id: "remember",
        operation: "apply_changes",
        action_groups: [{ action_identity: "remember", actions: [remember("小蓝指蓝封面词汇本。")] }],
      });
      return reply("记下了。");
    });
    const factsPath = h.store.files.resolve(".agent/context/facts.json", "internal");
    const stored = JSON.parse(fs.readFileSync(factsPath, "utf8")).facts;
    const fact = stored[0];
    const before = h.store.revocationRevision();
    const stampBefore = h.store.runtimeMeta().revocation_revision ?? 0;

    await modelTurn(h, "忘记小蓝这个叫法。", async (input) => {
      const result = await businessCall(h.core, {
        input_id: input.id,
        call_id: "forget",
        operation: "apply_changes",
        action_groups: [
          {
            action_identity: "forget",
            actions: [
              { type: "forget_fact", target_id: fact.id, expected_version: fact.version },
            ],
          },
        ],
      });
      expect(result.results[0].status).toBe("applied");
      return reply("这条叫法已经不再使用。");
    });

    const after = JSON.parse(fs.readFileSync(factsPath, "utf8")).facts;
    const tombstone = after.find((f: any) => f.id === fact.id);
    expect(tombstone.status).toBe("revoked");
    expect(tombstone.content).toBe("");
    expect(tombstone.scope).toEqual(["学习"]);
    expect(h.store.revocationRevision()).toBe(before + 1);
    expect(h.store.runtimeMeta().recovery_guard?.active).toBeFalsy();
    expect(stampBefore + 1).toBe(h.store.runtimeMeta().revocation_revision);
    const marker = h.store.db
      .prepare("SELECT kind,target_id,reason_code FROM revocations WHERE target_id=?")
      .get(fact.id) as any;
    expect(marker).toMatchObject({ kind: "fact", reason_code: "user_forgot" });
    // The marker row keeps no deleted body.
    expect(JSON.stringify(marker)).not.toContain("蓝封面");

    await modelTurn(h, "小蓝是哪一本？", async (input) => {
      const prefs: any = await applicationCall(
        h.core,
        { input_id: input.id, call_id: "prefs", operation: "preferences", query: "小蓝 词汇本" },
        {} as any,
      );
      expect(prefs.facts).toEqual([]);
      const context = h.core.context(input) as any;
      expect(context.facts).toEqual([]);
      return reply("这个叫法已经不用了。");
    });
    // Unrelated task work survives a forgotten fact.
    expect(h.store.registry().tasks).toHaveLength(1);
  });

  it("D07 forgotten facts clear the original chat fragment without claiming a full erase", async () => {
    const h = setup();
    await h.run(task(1));
    const factsPath = h.store.files.resolve(".agent/context/facts.json", "internal");
    let sourceId = "";
    await modelTurn(h, "记一下：小蓝指蓝封面词汇本。", async (input) => {
      sourceId = input.id;
      await businessCall(h.core, {
        input_id: input.id,
        call_id: "remember",
        operation: "apply_changes",
        action_groups: [{ action_identity: "remember", actions: [remember("小蓝指蓝封面词汇本。")] }],
      });
      return reply("记下了。");
    });
    const fact = JSON.parse(fs.readFileSync(factsPath, "utf8")).facts[0];
    const sourceRow = () =>
      h.store.db.prepare("SELECT body,status,metadata_json FROM inbox WHERE id=?").get(sourceId) as any;
    // The original chat fragment is still readable material before the revocation.
    expect(sourceRow().status).toBe("processed");
    expect(sourceRow().body).toContain("蓝封面");

    const receipt = await modelTurn(h, "忘记小蓝这个叫法。", async (input) => {
      const result = await businessCall(h.core, {
        input_id: input.id,
        call_id: "forget",
        operation: "apply_changes",
        action_groups: [
          {
            action_identity: "forget",
            actions: [{ type: "forget_fact", target_id: fact.id, expected_version: fact.version }],
          },
        ],
      });
      expect(result.results[0].status).toBe("applied");
      // The source fragment is already terminal, so cleanup finishes inside the receipt.
      expect(result.results[0].revocation_cleanup).toMatchObject({ state: "done", pending: [] });
      expect(result.results[0].projection.warnings ?? []).not.toContain("已停用，清理待完成");
      return reply("这条叫法已经停用，原消息也清理了。");
    });

    // The fragment body is gone; only an opaque pointer remains.
    expect(sourceRow().body).toBeNull();
    expect(JSON.parse(sourceRow().metadata_json).body_cleared).toBe("revocation");
    const marker = h.store.db
      .prepare("SELECT kind,target_id,cleanup_state,cleaned_at FROM revocations WHERE target_id=?")
      .get(fact.id) as any;
    expect(marker).toMatchObject({ kind: "fact", cleanup_state: "done" });
    expect(marker.cleaned_at).toBeTruthy();
    expect(JSON.stringify(marker)).not.toContain("蓝封面");
    // Nothing in the receipt claims a physical erase beyond what was verified.
    expect(JSON.stringify(receipt)).not.toContain("彻底");
    // The tombstone still resolves the next cleanup if the process restarts.
    const tombstone = JSON.parse(fs.readFileSync(factsPath, "utf8")).facts.find((f: any) => f.id === fact.id);
    expect(tombstone.source).toMatchObject({ kind: "input", id: sourceId });
  });

  it("D07 a forgotten or corrected fact makes the derived summary stale instead of current", async () => {
    const h = setup();
    const summaryPath = h.store.files.resolve(".agent/context/current.md", "internal");
    const readSummary = () => fs.readFileSync(summaryPath, "utf8");
    const marker = (text: string) => (text.match(/<!-- (.*?) -->/) ?? [])[1] ?? "";
    await h.run(task(1));
    const baseline = readSummary();
    expect(marker(baseline)).toContain("facts:");
    expect(marker(baseline)).toContain("revocations:0");
    expect(baseline).toContain("有效长期事实 0 条");

    const factsPath = h.store.files.resolve(".agent/context/facts.json", "internal");
    await h.run({ ...remember("小蓝指蓝封面词汇本。") } as any);
    const afterRemember = readSummary();
    expect(marker(afterRemember)).not.toBe(marker(baseline));
    expect(afterRemember).toContain("有效长期事实 1 条");

    const fact = JSON.parse(fs.readFileSync(factsPath, "utf8")).facts[0];
    await h.run({ type: "forget_fact", target_id: fact.id, expected_version: fact.version } as any);
    const afterForget = readSummary();
    // The revocation is part of the summary's source set, so it is rebuilt.
    expect(marker(afterForget)).not.toBe(marker(afterRemember));
    expect(marker(afterForget)).toContain("revocations:1");
    expect(afterForget).toContain("有效长期事实 0 条");
    expect(afterForget).toContain("已撤销的不再计入");
    // Nothing from the forgotten body survives in the derivative.
    expect(afterForget).not.toContain("蓝封面");
    // Rebuilding an unchanged state does not keep rewriting the file.
    h.core.rebuildSummary();
    expect(readSummary()).toBe(afterForget);
  });

  it("C6 a backlog of memory derivations is rebuilt once, not once per event", async () => {
    const h = setup();
    await h.run(task(7));
    const before = fs.readFileSync(h.store.files.resolve(".agent/context/current.md", "internal"), "utf8");
    // Simulate the backlog a first start after an upgrade can create.
    const insert = h.store.db.prepare(
      "INSERT INTO events(id,dedupe_key,input_id,source,kind,payload_json,created_at,status) VALUES(?,?,?,?,?,?,?,'prepared')",
    );
    for (let i = 0; i < 25; i++)
      insert.run("backlog-" + i, "backlog-" + i, "input-fixture", "core", "memory_derivation", JSON.stringify({}), h.store.now());
    let rebuilds = 0;
    const original = (h.core as any).rebuildSummary.bind(h.core);
    (h.core as any).rebuildSummary = (strict?: boolean) => { rebuilds++; return original(strict); };
    (h.core as any).flushMemoryDerivations();
    expect(rebuilds).toBe(1);
    expect(
      h.store.db.prepare("SELECT count(*) n FROM events WHERE kind='memory_derivation' AND status='prepared'").get(),
    ).toMatchObject({ n: 0 });
    expect(fs.readFileSync(h.store.files.resolve(".agent/context/current.md", "internal"), "utf8")).toBe(before);
  });

  it("C6 a failed memory derivation is recorded with a retry window instead of vanishing", async () => {
    const h = setup();
    await h.run(task(1));
    const current = h.store.files.resolve(".agent/context/current.md", "internal");
    // Block the derived file by occupying its name with a directory.
    fs.rmSync(current, { force: true });
    fs.mkdirSync(current);
    await h.run(task(2));
    const pending = () =>
      h.store.db
        .prepare("SELECT status,error_code,payload_json FROM events WHERE kind='memory_derivation' ORDER BY rowid DESC LIMIT 1")
        .get() as any;
    expect(pending().status).toBe("conflict");
    expect(pending().error_code).toBe("MEMORY_CONFLICT");
    const payload = JSON.parse(pending().payload_json);
    expect(payload.attempts).toBe(1);
    expect(typeof payload.next_retry_at).toBe("string");

    // A repaired destination is picked up by the consumer retry, not by luck.
    fs.rmdirSync(current);
    h.advance(6 * 60000);
    h.core.recoverPending();
    expect(pending().status).toBe("applied");
    expect(fs.readFileSync(current, "utf8")).toContain("有效习惯");
  });

  it("D07 forgetting also clears the legacy preference line that repeated it", async () => {
    const h = setup();
    const legacy = h.store.files.resolve(".agent/context/user.md", "internal");
    atomicWrite(legacy, "- 小蓝指蓝封面词汇本。\n- 每周日整理一次书架。\n");
    const factsPath = h.store.files.resolve(".agent/context/facts.json", "internal");
    await h.run(remember("小蓝指蓝封面词汇本。"));
    const fact = JSON.parse(fs.readFileSync(factsPath, "utf8")).facts[0];
    expect(fact.id).toBeTruthy();

    let lastInput: any = null;
    const receipt = await modelTurn(h, "别再用小蓝这个叫法了。", async (input) => {
      lastInput = input;
      const result = await businessCall(h.core, {
        input_id: input.id,
        call_id: "forget-legacy",
        operation: "apply_changes",
        action_groups: [
          {
            action_identity: "forget",
            actions: [{ type: "forget_fact", target_id: fact.id, expected_version: fact.version }],
          },
        ],
      });
      expect(result.results[0].status).toBe("applied");
      expect(result.results[0].revocation_cleanup).toMatchObject({ legacy_user_md_cleared: 1 });
      return reply("这条叫法已经停用了。");
    });
    // Only the exactly matching legacy line is gone; the rest of the file stays.
    expect(fs.readFileSync(legacy, "utf8")).toBe("- 每周日整理一次书架。\n");
    const context = h.core.context(lastInput);
    expect(JSON.stringify(context)).not.toContain("蓝封面");
    expect(JSON.stringify(context)).toContain("书架");
    // The marker still never stores the removed body.
    const marker = h.store.db
      .prepare("SELECT kind,target_id FROM revocations WHERE target_id=?")
      .get(fact.id) as any;
    expect(JSON.stringify(marker)).not.toContain("蓝封面");
    expect(JSON.stringify(receipt)).not.toContain("蓝封面");
  });

  it("D07 an older reader cannot keep using a fact that was just forgotten", async () => {
    const h = setup();
    await h.run(remember("小蓝指蓝封面词汇本。"));
    const fact = JSON.parse(
      fs.readFileSync(h.store.files.resolve(".agent/context/facts.json", "internal"), "utf8"),
    ).facts[0];
    let oldStamp = "";
    const first = await modelTurn(h, "先读小蓝。", async (input) => {
      const meta = JSON.parse(
        (h.store.db.prepare("SELECT metadata_json FROM inbox WHERE id=?").get(input.id) as any)
          .metadata_json,
      );
      oldStamp = meta.policy_stamp;
      return reply("先确认这条叫法。");
    });
    expect(oldStamp).toBeTruthy();
    await modelTurn(h, "忘记小蓝这个叫法。", async (input) => {
      await businessCall(h.core, {
        input_id: input.id,
        call_id: "forget",
        operation: "apply_changes",
        action_groups: [
          {
            action_identity: "forget",
            actions: [{ type: "forget_fact", target_id: fact.id, expected_version: fact.version }],
          },
        ],
      });
      return reply("已停用这条叫法。");
    });
    // The older job still holds the pre-revocation policy stamp.
    h.store.db
      .prepare(
        "UPDATE inbox SET status='processing', metadata_json=json_set(metadata_json,'$.policy_stamp',?) WHERE id=?",
      )
      .run(oldStamp, first.id);
    await expect(
      businessCall(h.core, {
        input_id: first.id,
        call_id: "old-job-write",
        operation: "apply_changes",
        action_groups: [{ action_identity: "old", actions: [task(2)] }],
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(h.store.registry().tasks).toHaveLength(0);
  });

  it("D07 a restored runtime does not auto-load stored facts", async () => {
    const h = setup();
    await h.run(remember("小蓝指蓝封面词汇本。"));
    h.store.updateRuntimeMeta((meta) => ({
      ...meta,
      recovery_guard: { active: true, reason: "RESTORED_SNAPSHOT", created_at: h.store.now() },
    }));
    await modelTurn(h, "小蓝是哪一本？", async (input) => {
      const prefs: any = await applicationCall(
        h.core,
        { input_id: input.id, call_id: "prefs", operation: "preferences", query: "小蓝" },
        {} as any,
      );
      expect(prefs.facts).toEqual([]);
      const context = h.core.context(input) as any;
      expect(context.facts_restricted).toBe(true);
      expect(context.facts).toEqual([]);
      return reply("恢复后的记忆需要先核对，暂不自动使用。");
    });
  });
});

describe("S3 constrained reflow", () => {
  it("S3 automatic placement keeps the trailing reserve until that date lowers it", async () => {
    const h = setup("2026-10-26T00:00:00Z");
    await h.run({
      type: "set_planning",
      preferences: {
        availability: [{ weekdays: [1, 2, 3, 4, 5, 6, 7], start: "10:00", end: "12:00" }],
        protected: [],
        day_overrides: [],
        buffer_minutes: 15,
      },
      expected_planning_version: 0,
    } as any);
    // User-confirmed long block: 10:00-11:30 local, explicitly placed.
    await h.run({
      ...task(1),
      planning: { enabled: true, remaining_minutes: 90, next_action: "写报告" },
    } as any);
    const report = h.store.registry().tasks.find((t) => t.title === "事项1")!;
    await h.run({
      type: "schedule",
      target_id: report.id,
      expected_version: report.version,
      duration_minutes: 90,
      window_start: "2026-10-26T02:00:00Z",
      window_end: "2026-10-26T03:30:00Z",
      next_action: "写报告",
    } as any);
    await h.run({
      ...task(2),
      planning: { enabled: true, remaining_minutes: 20, next_action: "画图表" },
    } as any);
    const chart = h.store.registry().tasks.find((t) => t.title === "事项2")!;
    const windows = [{ start: "2026-10-26T02:00:00Z", end: "2026-10-26T04:00:00Z" }];

    // 11:30-11:50 would end after the 11:45 reserve boundary: 5 minutes short.
    await expect(
      h.run({
        type: "schedule",
        target_id: chart.id,
        expected_version: chart.version,
        duration_minutes: 20,
        available_windows: windows,
        next_action: "画图表",
      } as any),
    ).rejects.toMatchObject({ code: "NO_CAPACITY" });
    expect(h.store.registry().plans.filter((p) => p.target_ref.id === chart.id)).toHaveLength(0);

    await h.run({
      type: "set_planning",
      preferences: {
        day_overrides: [
          { date: "2026-10-26", windows: [{ start: "10:00", end: "12:00" }], buffer_minutes: 0 },
        ],
      },
      expected_planning_version: 1,
    } as any);
    const current = h.store.registry().tasks.find((t) => t.id === chart.id)!;
    await h.run({
      type: "schedule",
      target_id: current.id,
      expected_version: current.version,
      duration_minutes: 20,
      available_windows: windows,
      next_action: "画图表",
    } as any);
    const plan = h.store.registry().plans.find((p) => p.target_ref.id === chart.id)!;
    expect(plan.window_start).toBe("2026-10-26T03:30:00.000Z");
    expect(plan.window_end).toBe("2026-10-26T03:50:00.000Z");
    // The earlier explicit block is untouched.
    expect(h.store.registry().plans.find((p) => p.target_ref.id === report.id)!.window_start).toBe(
      "2026-10-26T02:00:00.000Z",
    );
  });
});

describe("D03 snapshot and published revision", () => {
  it("D03 a snapshot carries one revision, stays immutable and survives restart", async () => {
    const h = setup();
    const empty = h.store.readSnapshot({ days: ["2026-10-26"] });
    expect(empty.snapshot_revision).toBe(0);
    expect(empty.registry.tasks).toHaveLength(0);
    await h.run(task(1));
    const after = h.store.readSnapshot({ days: ["2026-10-26"] });
    expect(after.snapshot_revision).toBeGreaterThan(empty.snapshot_revision);
    expect(after.registry.tasks).toHaveLength(1);
    expect(after.days["2026-10-26"].business_date).toBe("2026-10-26");
    // The earlier snapshot is an immutable copy, not a live view.
    expect(empty.registry.tasks).toHaveLength(0);

    const revision = after.snapshot_revision;
    await h.restart();
    const restarted = h.store.readSnapshot({ days: ["2026-10-26"] });
    expect(restarted.snapshot_revision).toBe(revision);
    expect(restarted.registry.tasks).toHaveLength(1);
  });

  it("D03 a crash after the files were written publishes exactly one revision on recovery", async () => {
    const h = setup();
    const before = h.store.readSnapshot().snapshot_revision;
    h.store.fault = (stage) => {
      if (stage === "files_applied") throw new Error("power loss");
    };
    await expect(h.run(task(1))).rejects.toThrow("power loss");
    h.store.fault = undefined;
    const recovered = h.store.readSnapshot();
    expect(recovered.snapshot_revision).toBe(before + 1);
    expect(recovered.registry.tasks).toHaveLength(1);
    expect(
      h.store.db
        .prepare("SELECT count(*) n FROM events WHERE kind='business' AND status='prepared'")
        .get(),
    ).toMatchObject({ n: 0 });
  });

  it("D03 query results report the revision they were read from", async () => {
    const h = setup();
    let seen: any;
    useModel(h, async (input) => {
      const state: any = await applicationCall(
        h.core,
        { input_id: input.id, call_id: "state", operation: "state" },
        {} as any,
      );
      seen = state.snapshot_revision;
      return reply("当前状态已读取。");
    });
    await turn(h, "看看现在有什么。");
    expect(seen).toBe(h.store.snapshotRevision());
  });
});

describe("S1 one briefing and one decision", () => {
  it("S1 accepts four items with one local amendment, keeps the user's wording and builds cross-year periods", async () => {
    const h = setup("2027-01-01T00:30:00Z");
    await h.run({
      type: "set_planning",
      preferences: {
        day_overrides: [
          {
            date: "2027-01-01",
            windows: [
              { start: "09:00", end: "12:00" },
              { start: "14:00", end: "16:00" },
            ],
          },
        ],
      },
      expected_planning_version: 0,
    } as any);
    const dailyPath = route("daily", "2027-01-01");
    await h.core.newPeriod("daily", "2027-01-01");
    atomicWrite(
      h.store.files.resolve(dailyPath),
      h.store.files.read(dailyPath) + "\n用户原文保留标记\n",
    );

    const items = [
      { title: "词汇", outcome: "记住20个词", next: "背20个词", start: "2027-01-01T01:00:00Z", end: "2027-01-01T01:20:00Z", minutes: 20,
        acceptance: [{ id: "words", kind: "count", description: "20个词", target: 20, unit: "词" }] },
      { title: "语法", outcome: "完成10题", next: "做10道语法题", start: "2027-01-01T01:30:00Z", end: "2027-01-01T02:00:00Z", minutes: 30,
        acceptance: [{ id: "items", kind: "count", description: "10题", target: 10, unit: "题" }] },
      { title: "报告", outcome: "写完第一节", next: "写报告第一节", start: "2027-01-01T02:00:00Z", end: "2027-01-01T03:00:00Z", minutes: 60,
        acceptance: [{ id: "first", kind: "check", description: "第一节完成并检查" }] },
      { title: "阅读", outcome: "读完一节", next: "读一节", start: "2027-01-01T03:10:00Z", end: "2027-01-01T03:30:00Z", minutes: 20,
        acceptance: [{ id: "read", kind: "check", description: "读完一节" }] },
    ];
    const taskAction = (item: (typeof items)[number]) => ({
      type: "create_task",
      title: item.title,
      outcome: item.outcome,
      acceptance: item.acceptance,
      due_at: "2027-01-01T10:00:00Z",
      planning: { enabled: true, next_action: item.next, remaining_minutes: item.minutes },
      initial_plan: {
        kind: "window",
        window_start: item.start,
        window_end: item.end,
        duration_minutes: item.minutes,
        next_action: item.next,
      },
    });

    await modelTurn(h, "先准备这四项，暂时不执行。", async (input) => {
      await businessCall(h.core, {
        input_id: input.id,
        call_id: "offer",
        operation: "save_proposals",
        summary: "四项当前草案",
        action_groups: items.map((item, index) => ({
          action_identity: "item" + index,
          actions: [taskAction(item)],
        })),
      });
      return reply("四项草案先放这里，等你决定。");
    });
    expect(h.store.registry().tasks).toHaveLength(0);
    expect(h.store.registry().proposals).toHaveLength(4);

    const decisionInput = await modelTurn(h, "都确定，语法改到下午两点，其他照刚才的。", async (input) => {
      const pending = h.store.registry().proposals.filter((p) => p.status === "pending");
      const decisions = pending.map((proposal) => ({
        target_id: proposal.id,
        expected_version: proposal.version,
        decision: "accept" as const,
        ...(String((proposal.actions[0] as any).title) === "语法"
          ? {
              replacements: [
                {
                  ...proposal.actions[0],
                  initial_plan: {
                    ...(proposal.actions[0] as any).initial_plan,
                    window_start: "2027-01-01T06:00:00Z",
                    window_end: "2027-01-01T06:30:00Z",
                  },
                },
              ],
            }
          : {}),
      }));
      const first = await businessCall(h.core, {
        input_id: input.id,
        call_id: "accept",
        operation: "resolve_proposals",
        decisions,
      });
      expect(first.results.every((r: any) => r.status === "applied")).toBe(true);
      // Same logical decision retried under another call id must not duplicate effects.
      const retry = await businessCall(h.core, {
        input_id: input.id,
        call_id: "accept-retry",
        operation: "resolve_proposals",
        decisions,
      });
      expect(retry.results.every((r: any) => r.already_applied === true)).toBe(true);
      return reply("四项都安排了，语法改到下午两点。");
    });

    const registry = h.store.registry();
    expect(registry.tasks.map((t) => t.title).sort()).toEqual(["报告", "词汇", "语法", "阅读"]);
    expect(registry.proposals.every((p) => p.status === "accepted")).toBe(true);
    const planFor = (title: string) => {
      const task = registry.tasks.find((t) => t.title === title)!;
      return registry.plans.find((p) => p.target_ref.id === task.id)!;
    };
    expect(planFor("语法").window_start).toBe("2027-01-01T06:00:00.000Z");
    expect(planFor("语法").window_end).toBe("2027-01-01T06:30:00.000Z");
    expect(planFor("语法").duration_minutes).toBe(30);
    expect(planFor("词汇").window_start).toBe("2027-01-01T01:00:00.000Z");
    expect(planFor("报告").window_start).toBe("2027-01-01T02:00:00.000Z");
    expect(planFor("阅读").window_start).toBe("2027-01-01T03:10:00.000Z");
    // The hard deadline did not drift with the amendment.
    expect(
      registry.tasks.every((t) => Date.parse(t.due_at!) === Date.parse("2027-01-01T10:00:00Z")),
    ).toBe(true);

    const files = h.store.files.list();
    expect(files).toContain("01. Daily/2027年/第1季度/01月/2026-W53/2027-01-01.md");
    expect(files).toContain(route("weekly", "2027-01-01"));
    expect(files).toContain(route("monthly", "2027-01-01"));
    expect(files).toContain(route("quarterly", "2027-01-01"));
    expect(files).toContain(route("yearly", "2027-01-01"));
    const daily = h.store.files.read(dailyPath);
    expect(daily).toContain("用户原文保留标记");
    expect(daily).toContain("背20个词");
    const week = h.store.files.read(route("weekly", "2027-01-01"));
    // The week segment starts at the new year and ends on Sunday 2027-01-03.
    expect(week).toContain("start: 2027-01-01");
    expect(week).toContain("end: 2027-01-03");
    expect(week).toContain("week: 2026-W53");
    expect(week).not.toContain("2027-01-04");
    // The previous ISO week still belongs to 2026.
    expect(week).toContain("2026年/第4季度/12月");

    const duplicate = await h.core.receive(decisionInput);
    expect(duplicate.duplicate).toBe(true);
    expect(
      h.store.db
        .prepare("SELECT count(*) n FROM inbox WHERE channel=? AND actor_ref=? AND external_id=?")
        .get(decisionInput.channel, decisionInput.actor_ref, decisionInput.external_id),
    ).toMatchObject({ n: 1 });
    expect(h.store.registry().tasks).toHaveLength(4);
    const links = h.store.registry().diary_links.filter(
      (l) => l.business_date === "2027-01-01",
    );
    expect(links.length).toBeGreaterThan(0);
    expect(new Set(links.map((l) => l.target_ref.id)).size).toBe(links.length);

    await modelTurn(h, "词汇20个做完了", async (input) => {
      const task = h.store.registry().tasks.find((t) => t.title === "词汇")!;
      await businessCall(h.core, {
        input_id: input.id,
        call_id: "report-done",
        operation: "apply_changes",
        action_groups: [
          {
            action_identity: "done-vocabulary",
            actions: [
              {
                type: "complete_task",
                target_id: task.id,
                expected_version: task.version,
                report: "词汇20个做完了",
              },
            ],
          },
        ],
      });
      return reply("词汇这项记下了，其他三项不变。");
    });
    const after = h.store.registry().tasks;
    expect(after.find((t) => t.title === "词汇")!.status).toBe("done");
    expect(after.filter((t) => t.status === "done")).toHaveLength(1);
    expect(
      h.store.day("2027-01-01").corrections.some((c) => c.title_snapshot === "词汇"),
    ).toBe(true);
  });
});

describe("E05/E08 input order and execution authority", () => {
  it("E05 a stale read cannot overwrite a change made after it", async () => {
    const h = setup();
    await h.run(task(1));
    useModel(h, async (input) => {
      const state: any = await applicationCall(
        h.core,
        { input_id: input.id, call_id: "read", operation: "state", scope: "tasks" },
        {} as any,
      );
      const seen = state.items[0];
      await h.run({
        type: "configure_task",
        target_id: seen.id,
        expected_version: seen.version,
        planning: { next_action: "外部改动" },
      } as any);
      await expect(
        businessCall(h.core, {
          input_id: input.id,
          call_id: "stale-write",
          operation: "apply_changes",
          action_groups: [
            {
              action_identity: "stale",
              actions: [
                {
                  type: "configure_task",
                  target_id: seen.id,
                  expected_version: seen.version,
                  planning: { next_action: "旧读版本" },
                },
              ],
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
      return reply("读到的版本已经变了，没有覆盖。");
    });
    await turn(h, "把下一步改一下。");
    expect(
      h.store.registry().tasks.find((t) => t.title === "事项1")!.planning!.next_action,
    ).toBe("外部改动");
  });

  it("E05 paging across a change returns a snapshot conflict instead of mixed versions", async () => {
    const h = setup();
    await h.run(task(1));
    useModel(h, async (input) => {
      await applicationCall(
        h.core,
        { input_id: input.id, call_id: "p0", operation: "state", scope: "tasks", offset: 0 },
        {} as any,
      );
      await h.run(task(2));
      await expect(
        applicationCall(
          h.core,
          { input_id: input.id, call_id: "p1", operation: "state", scope: "tasks", offset: 20 },
          {} as any,
        ),
      ).rejects.toMatchObject({ code: "QUERY_SNAPSHOT_CHANGED" });
      return reply("分页期间记录变了，需要从第一页重读。");
    });
    await turn(h, "把任务列表翻到下一页。");
  });

  it("E08 a job past its deadline cannot still write", async () => {
    const h = setup();
    useModel(h, async (input) => {
      h.store.db
        .prepare("UPDATE inbox SET metadata_json=json_set(metadata_json,'$.deadline_at',?) WHERE id=?")
        .run("2026-10-26T07:00:00Z", input.id);
      await expect(
        businessCall(h.core, {
          input_id: input.id,
          call_id: "late",
          operation: "apply_changes",
          action_groups: [{ action_identity: "late", actions: [task(1)] }],
        }),
      ).rejects.toMatchObject({ code: "APPLICATION_SESSION_EXPIRED" });
      return reply("这次执行已超过期限，没有写入。");
    });
    await turn(h, "办一下这件事。");
    expect(h.store.registry().tasks).toHaveLength(0);
  });

  it("E08 an old generation callback is refused while the new turn still works", async () => {
    const h = setup();
    let generation = "";
    useModel(h, async (input) => {
      generation = h.store.generation;
      await expect(
        businessCall(h.core, {
          input_id: input.id,
          call_id: "old",
          operation: "apply_changes",
          action_groups: [{ action_identity: "old", actions: [task(1)] }],
        }),
      ).resolves.toBeTruthy();
      return reply("第一件已经保存。");
    });
    await turn(h, "先办这件。");
    expect(h.store.registry().tasks).toHaveLength(1);
    await h.restart();
    expect(h.store.generation).not.toBe(generation);
    useModel(h, async (input) => {
      h.store.db
        .prepare("UPDATE inbox SET metadata_json=json_set(metadata_json,'$.runtime_generation',?) WHERE id=?")
        .run(generation, input.id);
      await expect(
        businessCall(h.core, {
          input_id: input.id,
          call_id: "replay",
          operation: "apply_changes",
          action_groups: [{ action_identity: "replay", actions: [task(2)] }],
        }),
      ).rejects.toMatchObject({ code: "APPLICATION_SESSION_EXPIRED" });
      return reply("旧执行权已失效，没有重放。");
    });
    await turn(h, "重启后再办一件。");
    expect(h.store.registry().tasks.map((t) => t.title)).toEqual(["事项1"]);
  });
});

describe("E06 path boundary", () => {
  it("E06 a Windows junction pointing outside the vault is refused before reading", () => {
    const h = setup();
    const outside = temporary();
    try {
      fs.mkdirSync(path.join(h.root, "03. Manual"), { recursive: true });
      fs.writeFileSync(path.join(outside, "outside.md"), "outside-secret");
      fs.symlinkSync(
        outside,
        path.join(h.root, "03. Manual/escape"),
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(() =>
        h.store.files.read("03. Manual/escape/outside.md"),
      ).toThrow(/符号链接|越界/);
      expect(() =>
        h.store.files.resolve("03. Manual/escape/new.md"),
      ).toThrow(/符号链接|越界/);
      expect(fs.existsSync(path.join(outside, "new.md"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("S5 repeated difficulty without drifting the standard", () => {
  it("S5 three explicit difficulties plus silence change the approach, not the standard", async () => {
    const h = setup("2026-10-19T09:00:00Z");
    const habit = await h.run({
      type: "create_habit",
      title: "英语",
      min_behavior: "打开词表读1词",
      optional_target: { value: 1, unit: "章" },
      recurrence: { weekdays: [1, 2, 3, 4, 5, 6, 7], starts_on: "2026-10-19" },
      anchor: { kind: "time_window", local_start: "20:00", local_end: "22:00" },
      reminder_mode: "window",
    } as any);
    const review = await h.run({
      type: "create_task",
      title: "本周掌握100词",
      outcome: "本周掌握100词",
      due_at: "2026-10-26T10:00:00Z",
      acceptance: [{ id: "q", kind: "count", description: "掌握100词", target: 100, unit: "词" }],
    } as any);
    const taskId = review.updated_ids[0];
    const before = structuredClone(h.store.registry().tasks.find((t) => t.id === taskId)!);
    let planning = 0;
    h.core.agent = {
      executionMode: "tools-v2",
      interpret: async (_input: unknown, context: any) => {
        planning++;
        expect(context.followup ?? context.task).toBeTruthy();
        return {
          action_groups: [
            {
              action_identity: "smaller-start",
              actions: [
                {
                  type: "configure_task",
                  target_id: taskId,
                  expected_version: context.task?.version ?? before.version,
                  planning: { next_action: "先把词表翻到第1页，只读前5词" },
                },
              ],
            },
          ],
          clarification: null,
          reply_intent: "discussion",
          discussion: "三次都卡在同一处。先把入口缩到一页五词，100词的要求不变。",
        };
      },
    } as any;
    // Day 1, 3, 5: explicit difficulty. Days 2 and 4 stay silent (no feedback at all).
    for (const day of ["2026-10-19", "2026-10-21", "2026-10-23"]) {
      h.setTime(day + "T09:00:00Z");
      await h.run({ type: "report_execution", target_id: taskId, execution: "not_started" } as any);
      h.core.assistant.startPlanning();
      await h.core.assistant.drain();
    }
    const after = h.store.registry().tasks.find((t) => t.id === taskId)!;
    // The standard is unchanged: acceptance, outcome and due date survive.
    expect(after.acceptance).toEqual(before.acceptance);
    expect(after.outcome).toBe(before.outcome);
    expect(after.due_at).toBe(before.due_at);
    // And the task was not quietly closed as done or failed.
    expect(after.status).not.toBe("done");
    // The approach did change once, not on every difficulty report.
    expect(after.planning?.next_action).toBe("先把词表翻到第1页，只读前5词");
    // The habit's minimum behaviour is still the agreed one, untouched by the task.
    expect(h.store.registry().habits.find((x) => x.id === habit.updated_ids[0])!.min_behavior).toBe(
      "打开词表读1词",
    );
    // Silence on days without feedback is not recorded as failure.
    const failed = h.store.db
      .prepare("SELECT count(*) n FROM events WHERE status='failed'")
      .get() as any;
    expect(failed.n).toBe(0);
    // Three separate reports produce one task and one adjustment, not duplicates.
    expect(h.store.registry().tasks.filter((x) => x.title === "本周掌握100词")).toHaveLength(1);
    expect(planning).toBeGreaterThanOrEqual(1);
  });
});
