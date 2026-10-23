import { createServer, type RequestListener } from "node:http";
import { afterEach, it, expect } from "vitest";
import { createApp } from "../apps/core/app.js";
import { passwordHash } from "../apps/core/auth.js";
import { temporary, removeTemporary } from "./helpers.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup(handler?: RequestListener, model = "only-this-model") {
  const root = temporary();
  cleanups.push(async () => removeTemporary(root));
  let base = "http://127.0.0.1:1";
  if (handler) {
    const provider = createServer(handler);
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    base = "http://127.0.0.1:" + (provider.address() as any).port;
    cleanups.push(
      () => new Promise<void>((resolve) => provider.close(() => resolve())),
    );
  }
  const h = await createApp({
    vault: root,
    passwordHash: passwordHash("fixture-password"),
    sessionKey: "fixture-signature",
    origin: "http://localhost",
    secure: false,
    timers: false,
    env: {
      SECRETARY_PI_INTERNAL_TOKEN: "fixture-internal",
      LLM_BASE_URL: base,
      LLM_MODEL: model,
      LLM_API_KEY: "fixture-provider-secret",
    },
  });
  cleanups.push(() => h.app.close());
  return h;
}
it("A01 Pi machine credentials grant neither document access nor arbitrary provider tools", async () => {
  let calls = 0;
  const h = await setup((_request, response) => {
    calls++;
    response.end("{}");
  });
  const headers = { authorization: "Bearer fixture-internal" };
  expect(
    (await h.app.inject({ url: "/api/v1/tree", headers })).statusCode,
  ).toBe(401);
  const badTool = await h.app.inject({
    method: "POST",
    url: "/internal/model/v1/chat/completions",
    headers,
    payload: {
      model: "only-this-model",
      messages: [],
      tools: [{ type: "function", function: { name: "bash" } }],
    },
  });
  expect(badTool.statusCode).toBe(403);
  const badModel = await h.app.inject({
    method: "POST",
    url: "/internal/model/v1/chat/completions",
    headers,
    payload: { model: "another-model", messages: [] },
  });
  expect(badModel.statusCode).toBe(403);
  expect(calls).toBe(0);
});
it("upstream errors cannot expose the provider key to Pi or logs", async () => {
  const h = await setup((_request, response) => {
    response.writeHead(401);
    response.end("Invalid key: fixture-provider-secret");
  });
  const result = await h.app.inject({
    method: "POST",
    url: "/internal/model/v1/chat/completions",
    headers: { authorization: "Bearer fixture-internal" },
    payload: { model: "only-this-model", messages: [] },
  });
  expect(result.statusCode).toBe(503);
  expect(result.body).not.toContain("fixture-provider-secret");
  expect(result.json().error.code).toBe("MODEL_UPSTREAM_FAILED");
});
it("model proxy fixes the endpoint, caps token requests and strips unknown forwarding settings", async () => {
  let seen: any;
  const h = await setup(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    seen = { url: request.url, body: JSON.parse(text) };
    response.setHeader("Content-Type", "text/event-stream");
    response.end("data: [DONE]\n\n");
  });
  const result = await h.app.inject({
    method: "POST",
    url: "/internal/model/v1/chat/completions",
    headers: { authorization: "Bearer fixture-internal" },
    payload: {
      model: "only-this-model",
      messages: [],
      max_tokens: 1000000000,
      base_url: "https://outside.invalid",
      api_key: "not-forwarded",
    },
  });
  expect(result.statusCode).toBe(200);
  expect(seen.url).toBe("/chat/completions");
  expect(seen.body.max_tokens).toBe(4096);
  expect(seen.body).not.toHaveProperty("base_url");
  expect(seen.body).not.toHaveProperty("api_key");
});
it("DeepSeek Flash is kept in low-effort thinking mode at the provider boundary", async () => {
  let seen: any;
  const h = await setup(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    seen = JSON.parse(text);
    response.setHeader("Content-Type", "text/event-stream");
    response.end("data: [DONE]\n\n");
  }, "deepseek-flash");
  const result = await h.app.inject({
    method: "POST",
    url: "/internal/model/v1/chat/completions",
    headers: { authorization: "Bearer fixture-internal" },
    payload: {
      model: "deepseek-flash",
      messages: [],
      tools: [
        { type: "function", function: { name: "submit_proposal" } },
      ],
      tool_choice: "required",
    },
  });
  expect(result.statusCode).toBe(200);
  expect(seen.thinking).toEqual({ type: "enabled" });
  expect(seen.reasoning_effort).toBe("low");
  expect(seen.tool_choice).toBe("auto");
});
it("A04 direct connections cannot bypass login limits by forging X-Forwarded-For", async () => {
  const h = await setup();
  for (let i = 0; i < 5; i++) {
    const result = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: {
        origin: "http://localhost",
        "x-forwarded-for": "192.0.2." + i,
      },
      payload: { password: "wrong" },
    });
    expect(result.statusCode).toBe(401);
  }
  const blocked = await h.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: "http://localhost", "x-forwarded-for": "192.0.2.99" },
    payload: { password: "wrong" },
  });
  expect(blocked.statusCode).toBe(429);
});
it("graceful shutdown ends an active SSE stream and releases the vault lock", async () => {
  const h = await setup();
  await h.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (h.app.server.address() as any).port,
    login = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost" },
      payload: { password: "fixture-password" },
    });
  const cookie = login.cookies[0].name + "=" + login.cookies[0].value,
    response = await fetch(
      "http://127.0.0.1:" + port + "/api/v1/events/stream",
      { headers: { cookie } },
    ),
    reader = response.body!.getReader();
  await reader.read();
  await h.app.close();
  expect(h.store.closed).toBe(true);
  await reader.cancel();
});
