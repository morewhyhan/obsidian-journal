import { WebSocketServer, WebSocket } from "ws";
import { afterEach, it, expect } from "vitest";
import { harness, habitAction } from "./helpers.js";
import { OneBotChannel } from "../apps/core/qq.js";
import { Scheduler } from "../apps/core/scheduler.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function setup(time?: string) {
  const h = harness(time);
  cleanups.push(() => h.close());
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "string" || !address)
    throw new Error("Missing fixture port");
  let socket!: WebSocket;
  let auth: string | undefined;
  server.on("connection", (s, request) => {
    socket = s;
    auth = request.headers.authorization;
  });
  cleanups.push(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const channel = new OneBotChannel(h.core, {
    url: "ws://127.0.0.1:" + address.port,
    token: "fixture-secret",
    botId: "100",
    userId: "200",
    timeoutMs: 80,
  });
  cleanups.push(async () => channel.close());
  channel.connect();
  await expect.poll(() => channel.health().connected).toBe(true);
  const send = (overrides: Record<string, unknown> = {}) =>
    socket.send(
      JSON.stringify({
        post_type: "message",
        message_type: "private",
        self_id: "100",
        user_id: "200",
        message_id: "fixture-input",
        time: Math.floor(h.store.clock().getTime() / 1000),
        message: [{ type: "text", data: { text: "今天不提醒了" } }],
        ...overrides,
      }),
    );
  return {
    h,
    server,
    channel,
    send,
    get socket() {
      return socket;
    },
    get auth() {
      return auth;
    },
  };
}
it("A04 OneBot authenticates and ignores strangers, groups, other bots and malformed IDs", async () => {
  const t = await setup();
  expect(t.auth).toBe("Bearer fixture-secret");
  t.send({ user_id: "999" });
  t.send({ message_type: "group" });
  t.send({ self_id: "999" });
  t.send({ message_id: undefined });
  t.socket.send("{bad json");
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(t.h.store.registry().controls).toHaveLength(0);
  expect(
    t.h.store.db.prepare("SELECT count(*) AS n FROM inbox").get(),
  ).toMatchObject({ n: 0 });
});
it("S01 duplicate gateway deliveries cause only one pause and one receipt", async () => {
  const t = await setup();
  t.send();
  t.send();
  await expect.poll(() => t.h.store.registry().controls.length).toBe(1);
  expect(
    t.h.store.db.prepare("SELECT count(*) AS n FROM inbox").get(),
  ).toMatchObject({ n: 1 });
  expect(
    t.h.store.db.prepare("SELECT count(*) AS n FROM outbox").get(),
  ).toMatchObject({ n: 1 });
});
it("S03 only acknowledged message IDs count as sent; an incomplete success is unknown", async () => {
  const t = await setup();
  let calls = 0;
  t.socket.on("message", (raw) => {
    const request = JSON.parse(raw.toString());
    calls++;
    expect(request.action).toBe("send_private_msg");
    expect(request.params.user_id).toBe("200");
    t.socket.send(
      JSON.stringify({
        echo: request.echo,
        status: "ok",
        data: calls === 1 ? { message_id: "987654321098765432" } : {},
      }),
    );
  });
  expect(
    await t.channel.send({
      id: "send-1",
      recipient: "100:200",
      body: "现在做一点",
    }),
  ).toMatchObject({ status: "sent", externalId: "987654321098765432" });
  expect(
    await t.channel.send({ id: "send-2", recipient: "200", body: "第二条" }),
  ).toMatchObject({ status: "unknown" });
  expect(
    await t.channel.send({ id: "wrong", recipient: "999", body: "x" }),
  ).toMatchObject({ status: "failed" });
});
it("S03 a real WebSocket request without gateway response becomes unknown", async () => {
  const t = await setup();
  expect(
    await t.channel.send({ id: "timeout", recipient: "200", body: "最小动作" }),
  ).toMatchObject({ status: "unknown", reason: "CHANNEL_TIMEOUT" });
});
it("A03 a clear quoted completion records facts without any model connection", async () => {
  const t = await setup();
  await t.h.run(habitAction);
  t.socket.on("message", (raw) => {
    const request = JSON.parse(raw.toString());
    t.socket.send(
      JSON.stringify({
        echo: request.echo,
        status: "ok",
        data: { message_id: "offline-reminder" },
      }),
    );
  });
  await new Scheduler(t.h.core, t.channel, "200").tick();
  expect(t.h.core.agent).toBeUndefined();
  t.send({
    message_id: "offline-feedback",
    message: [
      { type: "reply", data: { id: "offline-reminder" } },
      { type: "text", data: { text: "完成了" } },
    ],
  });
  await expect
    .poll(() => t.h.store.day("2026-10-23").occurrences.length)
    .toBe(1);
  expect(t.h.store.day("2026-10-23").occurrences[0].status).toBe("did");
  expect(t.h.store.files.list()).toHaveLength(0);
});
it("oversized input keeps an error marker without storing its body or repeated receipts", async () => {
  const t = await setup();
  const message = [{ type: "text", data: { text: "字".repeat(6000) } }];
  t.send({ message });
  t.send({ message });
  await expect
    .poll(() => t.h.store.db.prepare("SELECT count(*) AS n FROM inbox").get())
    .toMatchObject({ n: 1 });
  expect(
    t.h.store.db.prepare("SELECT body,status,error_code FROM inbox").get(),
  ).toMatchObject({
    body: null,
    status: "failed",
    error_code: "INPUT_TOO_LARGE",
  });
  expect(
    t.h.store.db.prepare("SELECT count(*) AS n FROM outbox").get(),
  ).toMatchObject({ n: 1 });
});
it("S07 midnight reply is mapped to the old reminder and its opportunity date", async () => {
  const t = await setup("2026-10-23T15:55:00Z");
  t.h.store.config.notifications.quiet_hours = { start: "09:00", end: "10:00" };
  const habit = await t.h.run({
    ...habitAction,
    anchor: { kind: "time_window", local_start: "23:50", local_end: "00:40" },
  });
  t.socket.on("message", (raw) => {
    const request = JSON.parse(raw.toString());
    t.socket.send(
      JSON.stringify({
        echo: request.echo,
        status: "ok",
        data: { message_id: "old-reminder" },
      }),
    );
  });
  const scheduler = new Scheduler(t.h.core, t.channel, "200");
  await scheduler.tick();
  expect(
    t.h.store.db
      .prepare("SELECT status FROM outbox WHERE external_id='old-reminder'")
      .get(),
  ).toMatchObject({ status: "sent" });
  t.h.setTime("2026-10-23T16:05:00Z");
  let observed: any;
  t.h.core.agent = {
    interpret: async (_input, context: any) => {
      observed = context;
      return {
        action_groups: [
          {
            action_identity: "old-opportunity",
            actions: [
              {
                type: "report_habit",
                target_id: habit.updated_ids[0],
                expected_version: context.items[0].version,
                business_date: context.reply_business_date,
                status: "did",
              },
            ],
          },
        ],
        clarification: null,
        reply_intent: "receipt",
      };
    },
  };
  t.send({
    message_id: "midnight-reply",
    message: [
      { type: "reply", data: { id: "old-reminder" } },
      { type: "text", data: { text: "读了一句" } },
    ],
  });
  await expect
    .poll(() => t.h.store.day("2026-10-23").occurrences.length)
    .toBe(1);
  expect(observed.reply_business_date).toBe("2026-10-23");
  expect(t.h.store.day("2026-10-24").occurrences).toHaveLength(0);
  expect(t.h.store.day("2026-10-23").occurrences[0].source.channel).toBe("qq");
});
