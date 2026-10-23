import Fastify from "fastify";
import { interpretWithPi, type PiOptions } from "./agent.js";
import { safeEqual } from "../core/auth.js";
export function createPiApp(options: PiOptions) {
  const app = Fastify({ logger: false, bodyLimit: 150000 });
  let occupied = false;
  app.setErrorHandler((_error, _request, reply) =>
    reply.code(503).send({ error: { code: "AGENT_UNAVAILABLE" } }),
  );
  app.addHook("preHandler", async (request, reply) => {
    if (
      !safeEqual(request.headers.authorization ?? "", "Bearer " + options.token)
    )
      return reply.code(403).send({ error: { code: "FORBIDDEN" } });
  });
  app.get("/healthz", () => ({ ok: true, agent: "pi" }));
  app.post<{ Body: { input: any; context: any; instructions: string } }>(
    "/interpret",
    async (request, reply) => {
      if (occupied)
        return reply.code(429).send({ error: { code: "AGENT_BUSY" } });
      occupied = true;
      try {
        const body = request.body;
        if (
          !body?.input ||
          typeof body.input.text !== "string" ||
          !body.context ||
          typeof body.instructions !== "string"
        )
          return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
        return await interpretWithPi(
          body.input,
          body.context,
          body.instructions,
          {
            ...options,
            timeoutMs: /^(?:\/讨论 |(?:帮我|请)?(?:分析|研究|讨论|比较))/.test(
              body.input.text,
            )
              ? 120000
              : 30000,
          },
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "pi_interpret_error",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return reply.code(503).send({ error: { code: "AGENT_UNAVAILABLE" } });
      } finally {
        occupied = false;
      }
    },
  );
  app.post<{ Body: { facts: unknown; instructions: string } }>(
    "/compose",
    async (request, reply) => {
      if (occupied)
        return reply.code(429).send({ error: { code: "AGENT_BUSY" } });
      occupied = true;
      try {
        if (!request.body || typeof request.body.instructions !== "string")
          return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
        const result = await interpretWithPi(
          {
            id: "compose",
            channel: "core",
            actor_ref: "core",
            external_id: "compose",
            text: "根据已经执行的事实生成一句短文案。不要提问，不增加事实；将文案放在discussion字段，action_groups必须为空。",
            occurred_at: new Date().toISOString(),
          },
          { facts: request.body.facts },
          request.body.instructions,
          { ...options, timeoutMs: 10000, maxTools: 2 },
        );
        const text = result.discussion ?? result.summary;
        if (result.action_groups.length || !text || text.length > 250)
          throw new Error("Invalid composition");
        return { text };
      } catch {
        return reply.code(503).send({ error: { code: "COMPOSE_UNAVAILABLE" } });
      } finally {
        occupied = false;
      }
    },
  );
  return app;
}
