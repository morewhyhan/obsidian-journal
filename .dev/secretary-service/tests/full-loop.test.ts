import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { it, expect } from "vitest";
import { createApp } from "../apps/core/app.js";
import { createPiApp } from "../apps/pi-adapter/app.js";
import { passwordHash } from "../apps/core/auth.js";
import {
  temporary,
  removeTemporary,
  habitAction,
  taskAction,
} from "./helpers.js";
import { OneBotChannel } from "../apps/core/qq.js";
it("complete local protocol loop: Web → Core → Pi SDK → fixed model proxy → QQ → feedback → diary → pause", async () => {
  const root = temporary();
  let now = new Date("2026-10-23T12:00:00Z"),
    instance: Awaited<ReturnType<typeof createApp>> | undefined;
  let providerCalls = 0,
    gateSocket!: WebSocket;
  const delivered: { body: string; id: string }[] = [];
  const provider = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    providerCalls++;
    expect(request.headers.authorization).toBe(
      "Bearer fixture-provider-secret",
    );
    expect(body.model).toBe("fixture-model");
    expect(body.tools.map((tool: any) => tool.function.name).sort()).toEqual([
      "get_context",
      "submit_proposal",
    ]);
    const last = body.messages.at(-1),
      toolTurn = last.role === "tool";
    let proposal: any;
    if (!toolTurn) {
      const user = [...body.messages]
          .reverse()
          .find((m: any) => m.role === "user"),
        payload =
          typeof user.content === "string"
            ? user.content
            : user.content.find((part: any) => part.type === "text").text,
        { input, context } = JSON.parse(payload);
      let actions: any[] = [];
      let discussion: string | undefined;
      if (input.id === "model-self-test") discussion = "ready";
      else if (input.id === "compose") discussion = context.facts.message;
      else if (input.text.includes("每天晚上")) actions = [habitAction];
      else if (input.text === "读了一句")
        actions = [
          {
            type: "report_habit",
            target_id: context.items[0].id,
            expected_version: context.items[0].version,
            business_date: context.reply_business_date ?? context.business_date,
            status: "did",
            optional_target_met: false,
          },
        ];
      else if (input.text.includes("创建任务")) actions = [taskAction];
      else if (input.text === "做了两题") {
        const task = context.items.find((x: any) => x.acceptance);
        actions = [
          {
            type: "update_task_progress",
            target_id: task.id,
            expected_version: task.version,
            criterion_id: "count",
            mode: "increment",
            value: 2,
            unit: "题",
          },
        ];
      } else if (input.text === "全部完成") {
        const task = context.items.find((x: any) => x.acceptance);
        actions = [
          {
            type: "complete_task",
            target_id: task.id,
            expected_version: task.version,
          },
        ];
      }
      proposal = {
        action_groups: actions.length
          ? [{ action_identity: input.id, actions }]
          : [],
        clarification: null,
        reply_intent: "receipt",
        ...(discussion ? { discussion } : {}),
      };
    }
    const delta = toolTurn
      ? { role: "assistant", content: "候选已提交给Core。" }
      : {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "fixture-proposal",
              type: "function",
              function: {
                name: "submit_proposal",
                arguments: JSON.stringify(proposal),
              },
            },
          ],
        };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [data, finish] of [
      [delta, null],
      [{}, toolTurn ? "stop" : "tool_calls"],
    ] as any[])
      response.write(
        "data: " +
          JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture-model",
            choices: [{ index: 0, delta: data, finish_reason: finish }],
          }) +
          "\n\n",
      );
    response.end("data: [DONE]\n\n");
  });
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => gateway.once("listening", resolve));
  const gatePort = (gateway.address() as any).port;
  gateway.on("connection", (socket) => {
    gateSocket = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()),
        externalId = "qq-" + (delivered.length + 1);
      delivered.push({
        body: message.params.message[0].data.text,
        id: externalId,
      });
      socket.send(
        JSON.stringify({
          echo: message.echo,
          status: "ok",
          data: { message_id: externalId },
        }),
      );
    });
  });
  const pi = createPiApp({
    baseUrl: "http://127.0.0.1:1",
    token: "fixture-internal-token",
    modelId: "fixture-model",
  });
  try {
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    const providerPort = (provider.address() as any).port;
    // Reserve Pi's actual port first, then create its replacement with Core's known model URL.
    await pi.listen({ host: "127.0.0.1", port: 0 });
    const piPort = (pi.server.address() as any).port;
    instance = await createApp({
      vault: root,
      passwordHash: passwordHash("fixture-web"),
      sessionKey: "fixture-web-session",
      clock: () => now,
      secure: false,
      origin: "http://localhost",
      timers: false,
      env: {
        SECRETARY_PI_URL: "http://127.0.0.1:" + piPort,
        SECRETARY_PI_INTERNAL_TOKEN: "fixture-internal-token",
        LLM_BASE_URL: "http://127.0.0.1:" + providerPort + "/v1",
        LLM_MODEL: "fixture-model",
        LLM_API_KEY: "fixture-provider-secret",
        SECRETARY_QQ_ENABLED: "1",
        QQ_WS_URL: "ws://127.0.0.1:" + gatePort,
        QQ_ACCESS_TOKEN: "fixture-gateway-token",
        QQ_BOT_ID: "100",
        SECRETARY_RECIPIENT: "200",
      },
    });
    await instance.app.listen({ host: "127.0.0.1", port: 0 });
    const corePort = (instance.app.server.address() as any).port;
    await pi.close();
    const realPi = createPiApp({
      baseUrl: "http://127.0.0.1:" + corePort + "/internal/model/v1",
      token: "fixture-internal-token",
      modelId: "fixture-model",
    });
    await realPi.listen({ host: "127.0.0.1", port: piPort });
    try {
      instance.checkAgent();
      await expect
        .poll(() => !!instance?.core.agent, { timeout: 10000 })
        .toBe(true);
      const login = await instance.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: "http://localhost" },
        payload: { password: "fixture-web" },
      });
      const headers = {
        cookie: login.cookies[0].name + "=" + login.cookies[0].value,
        origin: "http://localhost",
      };
      const tell = async (text: string) => {
        const key = crypto.randomUUID(),
          result = await instance!.app.inject({
            method: "POST",
            url: "/api/v1/assistant/messages",
            headers: { ...headers, "Idempotency-Key": key },
            payload: { text },
          });
        expect(result.statusCode).toBe(202);
        await expect
          .poll(
            () =>
              instance!.store.db
                .prepare("SELECT status FROM inbox WHERE id=?")
                .get(result.json().id),
            { timeout: 10000 },
          )
          .toMatchObject({ status: "processed" });
        return result.json().id;
      };
      await tell("提醒我每天晚上8点读一句英语");
      expect(instance.store.registry().habits).toHaveLength(1);
      const channel = instance.scheduler.channel;
      if (!(channel instanceof OneBotChannel))
        throw new Error("Missing QQ adapter");
      channel.connect();
      await expect.poll(() => channel.health().connected).toBe(true);
      await instance.scheduler.tick();
      expect(delivered).toHaveLength(1);
      expect(delivered[0].body).toContain("读一句英语");
      gateSocket.send(
        JSON.stringify({
          post_type: "message",
          message_type: "private",
          self_id: "100",
          user_id: "200",
          message_id: "reply-habit",
          time: Math.floor(+now / 1000),
          message: [
            { type: "reply", data: { id: delivered[0].id } },
            { type: "text", data: { text: "读了一句" } },
          ],
        }),
      );
      await expect
        .poll(() => instance!.store.day("2026-10-23").occurrences.length, {
          timeout: 10000,
        })
        .toBe(1);
      expect(instance.store.day("2026-10-23").occurrences[0]).toMatchObject({
        status: "did",
        optional_target_met: false,
      });
      expect(instance.store.files.list()).toHaveLength(0);
      await tell("帮我创建任务：完成五题并订正");
      await tell("做了两题");
      expect(instance.store.registry().tasks[0].status).toBe("in_progress");
      expect(
        instance.store.registry().tasks[0].progress.criteria.count
          .reported_value,
      ).toBe(2);
      await tell("全部完成");
      expect(instance.store.registry().tasks[0].status).toBe("done");
      const daily = await instance.app.inject({
        method: "POST",
        url: "/api/v1/documents",
        headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
        payload: { kind: "daily", date: "2026-10-23" },
      });
      expect(daily.statusCode).toBe(200);
      expect(instance.store.files.read(daily.json().path)).toContain(
        "- [x] 英语",
      );
      const beforePause = providerCalls;
      gateSocket.send(
        JSON.stringify({
          post_type: "message",
          message_type: "private",
          self_id: "100",
          user_id: "200",
          message_id: "pause",
          time: Math.floor(+now / 1000),
          message: [{ type: "text", data: { text: "今天不提醒了" } }],
        }),
      );
      await expect
        .poll(() => instance!.store.registry().controls.length)
        .toBe(1);
      expect(providerCalls).toBe(beforePause);
      now = new Date("2026-10-23T14:00:00Z");
      await instance.scheduler.tick();
      expect(
        delivered.filter((x) => x.body.includes("现在做这一小步")),
      ).toHaveLength(1);
    } finally {
      await instance.core.stop();
      await realPi.close();
    }
  } finally {
    await instance?.app.close();
    await pi.close();
    for (const socket of gateway.clients) socket.terminate();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    removeTemporary(root);
  }
}, 45000);
