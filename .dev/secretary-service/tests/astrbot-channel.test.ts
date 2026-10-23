import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { AstrBotChannel } from "../apps/core/astrbot-channel.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

it("AstrBot channel only sends to the bound owner and preserves external receipt", async () => {
  const server = createServer(async (request, response) => {
    if (request.url === "/healthz") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ agent: "astrbot", qq: { connected: true, bound: true } }));
      return;
    }
    if (request.url === "/send") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ status: "sent", externalId: "napcat-1" }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const channel = new AstrBotChannel(
    "http://127.0.0.1:" + (server.address() as any).port,
    "bridge-token",
    "1000000002",
  );
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  await channel.refresh();
  expect(channel.health().connected).toBe(true);
  expect((await channel.send({ id: "send-1", recipient: "qq:1000000002", body: "Hello" })).status).toBe("sent");
  expect((await channel.send({ id: "send-2", recipient: "qq:1000000001", body: "wrong" })).status).toBe("failed");
  channel.close();
});
