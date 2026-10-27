import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import {
  AppError,
  type Action,
  type Input,
  type NoteRef,
} from "../../packages/contracts/types.js";
import {
  localDate,
  type Period,
  route,
  identifyPeriod,
} from "../../packages/calendar/index.js";
import {
  loadConfig,
  projectRoot,
  resource,
  validateProductionSettings,
} from "./config.js";
import { Store } from "./store.js";
import { Core, type AgentAdapter } from "./core.js";
import { id, hash, atomicWrite } from "./files.js";
import {
  issueSession,
  validSession,
  verifyPassword,
  safeEqual,
} from "./auth.js";
import { Scheduler } from "./scheduler.js";
import { DisconnectedChannel } from "./qq.js";
import { AstrBotChannel } from "./astrbot-channel.js";
import { GitWorker, verifyGitHubPrivate } from "./git.js";
import { Maintenance } from "./maintenance.js";
import { AstrBotClient } from "./agent-client.js";
import { registerApiContracts } from "../../packages/contracts/api.js";
import { RuntimeLog } from "./log.js";
import { workspaceCall, type WorkspaceCall } from "./workspace.js";
import { applicationCall, type ApplicationCall } from "./application.js";
import { AGENT_TOOL_NAMES, AGENT_TOOLS } from "../../packages/contracts/agent-tools.js";
import { ModelBudget } from "./model-budget.js";
import { effectivePolicy } from "./policy.js";
import { SnapshotBackup } from "./snapshot-backup.js";
import { beginModelJob,endModelJob,modelDeadline } from "./model-job.js";
import {loadRuntimeCombination} from "./compatibility-runtime.js";
export type AppOptions = {
  vault: string;
  passwordHash: string;
  sessionKey: string;
  origin?: string;
  secure?: boolean;
  clock?: () => Date;
  agent?: AgentAdapter;
  timers?: boolean;
  env?: NodeJS.ProcessEnv;
};
export async function createApp(options: AppOptions) {
  validateProductionSettings({
    passwordHash: options.passwordHash,
    sessionKey: options.sessionKey,
    origin: options.origin,
    env: options.env ?? process.env,
  });
  const env = options.env ?? process.env,
    bridgeToken = env.SECRETARY_BRIDGE_TOKEN,
    cfg = loadConfig(options.vault),
    store = new Store(options.vault, cfg, options.clock),
    core = new Core(store),
    origin = options.origin ?? "http://localhost:3180";
  if(env.NODE_ENV==="production" && !options.clock)store.time.verifySynchronized(env.SECRETARY_TIME_SYNCHRONIZED==="1");
  const app = Fastify({
    logger: false,
    bodyLimit: cfg.web.max_document_bytes * 3,
    trustProxy: (address: string, hop: number) =>
      hop === 0 &&
      !!env.SECRETARY_TRUSTED_PROXY_IP &&
      address.replace(/^::ffff:/, "") === env.SECRETARY_TRUSTED_PROXY_IP,
    requestIdHeader: false,
  });
  const openapi = registerApiContracts(app);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, {
    limits: { files: 1, fileSize: cfg.web.max_attachment_bytes },
  });
  const combination=loadRuntimeCombination(store,env),instructions=combination.instructions;
  const configuredAgent =
    options.agent ??
    (env.SECRETARY_ASTRBOT_URL && bridgeToken
      ? new AstrBotClient(
          env.SECRETARY_ASTRBOT_URL,
          bridgeToken,
          cfg.agent.interpret_timeout_seconds * 1000,
          instructions,
          {
            maxTools: cfg.agent.max_tool_calls,
            composeTimeoutMs: cfg.agent.compose_timeout_seconds * 1000,
          },
        )
      : undefined);
  if (configuredAgent instanceof AstrBotClient)
    configuredAgent.communication = combination.communication;
  core.agent = options.agent;
  const agentStatus = {
    configured: !!configuredAgent,
    self_test: options.agent ? "injected" : "not_run",
    last_success: null as string | null,
    error: null as string | null,
    consecutive_failures:0,
    retry_at:null as string|null,
  };
  let modelCheck: Promise<void> | undefined,
    lastModelCheck = 0;
  let modelRetry: NodeJS.Timeout | undefined;
  const checkAgent = () => {
    const retryCooldown=agentStatus.consecutive_failures>=3?600000:agentStatus.consecutive_failures===2?30000:agentStatus.consecutive_failures===1?5000:0;
    if (
      !(configuredAgent instanceof AstrBotClient) ||
      core.working ||
      !!store.runtimeMeta().model_job ||
      agentStatus.self_test === "passed" ||
      modelCheck ||
      store.clock().getTime() - lastModelCheck < retryCooldown
    )
      return;
    lastModelCheck = store.clock().getTime();
    agentStatus.self_test = "checking";
    modelCheck = configuredAgent
      .check()
      .then(() => {
        agentStatus.consecutive_failures=0;agentStatus.retry_at=null;
        agentStatus.self_test = "passed";
        agentStatus.last_success = store.now();
        agentStatus.error = null;
        core.agent = configuredAgent;
        void core.processPending();
      })
      .catch(() => {
        agentStatus.consecutive_failures++;
        agentStatus.self_test = agentStatus.consecutive_failures>=3?"circuit_open":"failed";
        agentStatus.error = "MODEL_SELF_TEST_FAILED";
        core.agent = undefined;
      })
      .finally(() => {
        modelCheck = undefined;
        if (["failed","circuit_open"].includes(agentStatus.self_test) && !closing) {
          const delay=agentStatus.consecutive_failures>=3?600000:agentStatus.consecutive_failures===2?30000:5000;
          agentStatus.retry_at=new Date(store.clock().getTime()+delay).toISOString();
          if(modelRetry)clearTimeout(modelRetry);
          modelRetry = setTimeout(checkAgent, delay);
          modelRetry.unref();
        }
        core.emit("health_changed", {
          component: "agent",
          state: agentStatus.self_test,
        });
      });
  };
  const channel =
    env.SECRETARY_QQ_ENABLED === "1" &&
    env.SECRETARY_ASTRBOT_URL &&
    bridgeToken &&
    env.SECRETARY_RECIPIENT
      ? new AstrBotChannel(
          env.SECRETARY_ASTRBOT_URL,
          bridgeToken!,
          env.SECRETARY_RECIPIENT,
          cfg.channel.send_timeout_seconds * 1000,
        )
      : new DisconnectedChannel();
  const scheduler = new Scheduler(core, channel, env.SECRETARY_RECIPIENT ?? ""),
    backup = new GitWorker(options.vault, {
      enabled: env.SECRETARY_GIT_ENABLED === "1",
      debounceSeconds: cfg.sync.git.debounce_seconds,
      maxSeconds: cfg.sync.git.continuous_edit_commit_max_seconds,
      branch: cfg.sync.git.branch,
      remote: env.SECRETARY_GIT_REMOTE,
      verifyPrivate: (remote) =>
        verifyGitHubPrivate(remote, env.SECRETARY_GITHUB_METADATA_TOKEN),
      withWriteLock: (work) => store.exclusive(work),
    });
  const maintenance = new Maintenance(store);
  const snapshotBackup=new SnapshotBackup(store,env.SECRETARY_BACKUP_DIR,env.SECRETARY_BACKUP_KEY_FILE);
  const streams = new Set<import("node:http").ServerResponse>();
  const log = new RuntimeLog(store);
  core.subscribers.add((event) => {
    if (event.type === "input_result" && options.timers !== false)
      void scheduler.flushReceipts();
    if (event.type === "item_changed") core.rebuildSummary();
    if (event.type === "item_changed" || event.type === "document_changed")
      backup.changed();
  });
  app.setErrorHandler((error, request, reply) => {
    const own = error instanceof AppError,
      status = own
        ? error.status
        : ((error as { statusCode?: number }).statusCode ?? 500);
    log.write("request_error", {
      request_id: request.id,
      status,
      code: own
        ? error.code
        : status >= 500
          ? "INTERNAL_ERROR"
          : "INVALID_REQUEST",
    });
    reply.code(status).send({
      error: {
        code: own
          ? error.code
          : status === 400
            ? "INVALID_REQUEST"
            : "INTERNAL_ERROR",
        message: own
          ? error.message
          : status < 500
            ? "请求格式不正确"
            : "操作暂未完成，请保留草稿",
        request_id: request.id,
        details: own ? error.details : {},
        stage:own?error.stage:"transport",
        effect:own?error.effect:"unknown",
        retry_policy:own?error.retry_policy:"reconcile_only",
        scope:own?error.details.capability??"request":"request",
      },
    });
  });
  app.addHook("onResponse", async (request, reply) => {
    if (request.url.startsWith("/api/"))
      log.write("request_finished", {
        request_id: request.id,
        status: reply.statusCode,
        duration_ms: reply.elapsedTime,
        route: request.routeOptions.url,
      });
  });
  app.addHook("preHandler", async (request, reply) => {
    if (request.url.startsWith("/api/") || request.url.startsWith("/internal/"))
      reply.header("Cache-Control", "no-store");
    const url = request.url.split("?")[0];
    if (url.startsWith("/internal/")) {
      const token = bridgeToken;
      if (
        !token ||
        !safeEqual(request.headers.authorization ?? "", "Bearer " + token)
      )
        throw new AppError("FORBIDDEN", "无权访问", 403);
      return;
    }
    if (!url.startsWith("/api/v1/")) return;
    const login = url === "/api/v1/auth/login";
    if (
      !login &&
      !validSession(
        request.cookies.secretary,
        options.sessionKey,
        store.clock().getTime(),
      )
    )
      throw new AppError("UNAUTHENTICATED", "请先登录", 401);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      if (request.headers.origin !== origin)
        throw new AppError("CROSS_ORIGIN", "请求来源不符", 403);
      if (
        !String(request.headers["content-type"] ?? "").startsWith(
          url === "/api/v1/attachments"
            ? "multipart/form-data"
            : "application/json",
        )
      )
        throw new AppError("CONTENT_TYPE", "请求类型不符", 400);
      if (!login && typeof request.headers["idempotency-key"] !== "string")
        throw new AppError("IDEMPOTENCY_REQUIRED", "缺少请求标识", 400);
    }
  });
  app.get("/healthz", () => ({ ok: true }));
  app.get("/readyz", async (_request, reply) => {
    const state = store.state.snapshot();
    try {
      if (store.closed || !state.accepts_work || !store.compatibility!.verify()) throw new Error("not_ready");
      store.db.prepare("SELECT 1").get();
      fs.accessSync(store.root, fs.constants.R_OK | fs.constants.W_OK);
      const pending = store.db
        .prepare(
          "SELECT count(*) AS n FROM events WHERE kind='business' AND status IN ('prepared','conflict','failed')",
        )
        .get() as { n: number };
      if (pending.n) throw new Error("recovering");
      return { ready: true, ...state };
    } catch (error) {
      return reply.code(503).send({
        ready: false,
        ...state,
        reason: (error as Error)?.message ?? "not_ready",
      });
    }
  });
  const loginFailures = new Map<string, { count: number; since: number }>();
  app.post<{ Body: { password: string } }>(
    "/api/v1/auth/login",
    {
      schema: {
        body: {
          type: "object",
          required: ["password"],
          additionalProperties: false,
          properties: { password: { type: "string", maxLength: 1024 } },
        },
      },
    },
    async (request, reply) => {
      const now = store.clock().getTime();
      for (const [ip, entry] of loginFailures)
        if (now - entry.since >= 60000) loginFailures.delete(ip);
      const prior = loginFailures.get(request.ip);
      if (prior && prior.count >= 5) {
        reply.header(
          "Retry-After",
          Math.ceil((60000 - now + prior.since) / 1000),
        );
        throw new AppError("LOGIN_LIMIT", "尝试次数较多，请一分钟后再试", 429);
      }
      if (!verifyPassword(request.body.password, options.passwordHash)) {
        if (!prior && loginFailures.size >= 1000)
          throw new AppError("LOGIN_LIMIT", "请稍后再试", 429);
        loginFailures.set(request.ip, {
          count: (prior?.count ?? 0) + 1,
          since: prior?.since ?? now,
        });
        throw new AppError("LOGIN_FAILED", "密码不正确", 401);
      }
      loginFailures.delete(request.ip);
      reply.setCookie(
        "secretary",
        issueSession(options.sessionKey, store.clock().getTime()),
        {
          httpOnly: true,
          secure: options.secure ?? true,
          sameSite: "strict",
          path: "/",
          maxAge: 7 * 86400,
        },
      );
      return { ok: true };
    },
  );
  app.post("/api/v1/auth/logout", async (_, reply) => {
    reply.clearCookie("secretary", { path: "/" });
    return { ok: true };
  });
  app.get("/api/v1/auth/session", () => ({ authenticated: true }));
  app.get("/api/v1/openapi.json", () => openapi());
  app.get("/api/v1/tree", () => ({ paths: store.files.list() }));
  app.get("/api/v1/export", async (_request, reply) => {
    const data = await store.exclusive(() => {
      core.recoverPending();
      return store.exportData();
    });
    reply.header(
      "Content-Disposition",
      'attachment; filename="secretary-data.json"',
    );
    return data;
  });
  app.get<{ Querystring: { path: string } }>(
    "/api/v1/documents",
    async (request) => store.document(request.query.path),
  );
  app.put<{ Body: { path: string; base_hash: string; content: string } }>(
    "/api/v1/documents",
    {
      schema: {
        body: {
          type: "object",
          required: ["path", "base_hash", "content"],
          additionalProperties: false,
          properties: {
            path: { type: "string", maxLength: 1024 },
            base_hash: { type: "string", maxLength: 80 },
            content: { type: "string" },
          },
        },
      },
    },
    async (request) => {
      const result = await core.saveDocument(
        request.body.path,
        request.body.base_hash,
        request.body.content,
        String(request.headers["idempotency-key"]),
      );
      backup.changed();
      return result;
    },
  );
  app.post<{
    Body: { kind?: Period; date?: string; path?: string; content?: string };
  }>("/api/v1/documents", async (request) => {
    const body = request.body;
    const period =
      body.kind && body.date
        ? { kind: body.kind, date: body.date }
        : body.path
          ? identifyPeriod(body.path)
          : null;
    if (period) {
      if (!body.kind && body.content?.trim())
        throw new AppError(
          "PERIOD_CREATION_REQUIRED",
          "请先按日期创建周期模板，再编辑正文",
          409,
        );
      const result = await core.newPeriod(period.kind, period.date);
      backup.changed();
      return result;
    }
    if (!body.path || typeof body.content !== "string")
      throw new AppError("INVALID_DOCUMENT", "需要路径和内容", 400);
    return store.exclusive(() => {
      const file = store.files.resolve(body.path!);
      if (fs.existsSync(file)) return { path: body.path, existing: true };
      if (Buffer.byteLength(body.content!) > cfg.web.max_document_bytes)
        throw new AppError("DOCUMENT_TOO_LARGE", "笔记过大", 413);
      atomicWrite(file, body.content!);
      backup.changed();
      return store.document(body.path!);
    });
  });
  app.get<{ Querystring: { date?: string } }>(
    "/api/v1/home",
    async (request) => {
      const date = request.query.date ?? localDate(store.clock(), cfg.timezone);
      const paths = store.files.list(),
        daily = paths.filter(
          (p) => p.startsWith("01. Daily/") && /\d{4}-\d{2}-\d{2}\.md$/.test(p),
        );
      const heatmap = daily.map((p) => ({
        date: p.match(/(\d{4}-\d{2}-\d{2})\.md$/)![1],
        path: p,
      }));
      return {
        date,
        periods: Object.fromEntries(
          (
            ["daily", "weekly", "monthly", "quarterly", "yearly"] as Period[]
          ).map((k) => [k, store.files.actualPath(route(k, date))]),
        ),
        heatmap,
        recent: paths
          .filter((p) => !p.startsWith("Template/"))
          .map((p) => ({
            path: p,
            updated_at: fs.statSync(store.files.resolve(p)).mtime.toISOString(),
          }))
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
          .slice(0, 10),
      };
    },
  );
  app.get<{ Querystring: { q: string; offset?: string } }>(
    "/api/v1/search",
    async (request) => {
      const q = (request.query.q ?? "").trim().toLocaleLowerCase();
      if (!q || q.length > 200) return { results: [] };
      const found = store.files.search(store.files.list().filter(p=>!p.startsWith("Template/")),q);
      return {
        total: found.length,
        results: found.slice(
          Number(request.query.offset) || 0,
          (Number(request.query.offset) || 0) + 30,
        ),
      };
    },
  );
  app.get<{ Querystring: { date?: string } }>(
    "/api/v1/items",
    async (request) =>
      core.items(request.query.date ?? localDate(store.clock(), cfg.timezone)),
  );
  app.post<{ Body: Action }>(
    "/api/v1/commands",
    {
      schema: {
        body: {
          type: "object",
          required: ["type"],
          properties: {
            type: { type: "string", maxLength: 80 },
            target_id: { type: "string", maxLength: 100 },
            expected_version: { type: "integer", minimum: 1 },
          },
          additionalProperties: true,
        },
      },
    },
    async (request) => {
      const key = String(request.headers["idempotency-key"]);
      const input: Input = {
        id: key,
        channel: "web",
        actor_ref: "configured_user",
        external_id: key,
        text: "用户在 Web 明确操作：" + request.body.type,
        occurred_at: store.now(),
      };
      const result = await core.execute(
        input,
        [request.body],
        request.body.type,
        true,
      );
      backup.changed();
      return result;
    },
  );
  app.post<{
    Body: { text: string; reply_to?: string; note_scope?: NoteRef[] };
  }>(
    "/api/v1/assistant/messages",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
          properties: {
            text: { type: "string", minLength: 1, maxLength: 8000 },
            reply_to: { type: "string", maxLength: 200 },
            note_scope: {
              type: "array",
              maxItems: 2,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["path"],
                properties: {
                  path: { type: "string", maxLength: 1024 },
                  heading: { type: ["string", "null"], maxLength: 200 },
                  relation: {
                    type: "string",
                    enum: ["motivation", "plan", "method", "evidence"],
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const key = String(request.headers["idempotency-key"]);
      const received = await core.receive({
        id: key,
        channel: "web",
        actor_ref: "configured_user",
        external_id: key,
        text: request.body.text,
        occurred_at: store.now(),
        reply_to: request.body.reply_to,
        note_scope: request.body.note_scope,
      });
      reply.code(202);
      return received;
    },
  );
  app.get<{ Params: { id: string } }>("/api/v1/inputs/:id", async (request) => {
    const row = store.db
      .prepare(
        "SELECT id,status,error_code,metadata_json FROM inbox WHERE id=?",
      )
      .get(request.params.id) as any;
    if (!row) throw new AppError("NOT_FOUND", "输入不存在", 404);
    return {
      id: row.id,
      status: row.status,
      error: row.error_code,
      reply: JSON.parse(row.metadata_json).reply ?? null,
      groups: JSON.parse(row.metadata_json).groups ?? [],
    };
  });
  app.post<{ Params: { id: string }; Body: { version: number } }>(
    "/api/v1/proposals/:id/accept",
    async (request) => {
      const key = String(request.headers["idempotency-key"]);
      await core.acceptProposal(request.params.id, request.body.version, {
        id: key,
        channel: "web",
        actor_ref: "configured_user",
        external_id: key,
        text: "接受这份具体提案",
        occurred_at: store.now(),
      });
      backup.changed();
      return { status: "accepted" };
    },
  );
  app.get("/api/v1/events/stream", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(": connected\n\n");
    streams.add(reply.raw);
    const cb = (event: unknown) =>
      reply.raw.write("data: " + JSON.stringify(event) + "\n\n");
    core.subscribers.add(cb);
    const pulse = setInterval(() => reply.raw.write(": heartbeat\n\n"), 20000);
    reply.raw.on("close", () => {
      streams.delete(reply.raw);
      clearInterval(pulse);
      core.subscribers.delete(cb);
    });
  });
  app.get("/api/v1/status", () => ({
    runtime:{state:store.lifecycle,generation:store.generation,registry_schema:store.registry().schema_version,policy:effectivePolicy(store),
      compatibility:{fingerprint:combination.fingerprint,current:store.compatibility!.verify(),manifest:combination.manifest}},
    snapshot_backup:snapshotBackup.status,
    diagnostics:log.summary(),
    model_budget:{usage:modelBudget.status(),recovery_protected:!!store.runtimeMeta().budget_guard},
    scheduler: { last_tick: scheduler.lastTick, error: scheduler.lastError },
    planning: { error: core.coordinator.lastError },
    assistant: { error: core.assistant.lastError },
    qq: channel.health(),
    agent: agentStatus,
    logs: { error: log.error },
    context: { summary_error: core.summaryError },
    backup: {
      enabled: backup.options.enabled,
      last_commit: backup.lastCommit,
      last_push: backup.lastPush,
      error: backup.error,
    },
    maintenance: { last: maintenance.last, error: maintenance.error },
    recovery_until: store.recoveryUntil,
    unfinished_recovery: (
      store.db
        .prepare(
          "SELECT count(*) AS n FROM events WHERE status IN ('prepared','conflict','failed')",
        )
        .get() as { n: number }
    ).n,
    database_bytes: fs.statSync(
      store.files.resolve(cfg.storage.database, "internal"),
    ).size,
  }));
  app.get<{ Querystring: { path: string } }>(
    "/api/v1/documents/history",
    async (request) => {
      store.files.resolve(request.query.path);
      return { versions: await backup.history(request.query.path) };
    },
  );
  app.get<{ Querystring: { path: string; commit: string } }>(
    "/api/v1/documents/history/content",
    async (request) => {
      store.files.resolve(request.query.path);
      return {
        path: request.query.path,
        commit: request.query.commit,
        content: await backup.content(request.query.path, request.query.commit),
      };
    },
  );
  app.post<{ Body: { path: string; commit: string; base_hash: string } }>(
    "/api/v1/documents/restore",
    async (request) => {
      store.files.resolve(request.body.path);
      const content = await backup.content(
        request.body.path,
        request.body.commit,
      );
      const result = await core.saveDocument(
        request.body.path,
        request.body.base_hash,
        content,
        String(request.headers["idempotency-key"]),
      );
      backup.changed();
      return result;
    },
  );
  app.delete<{ Body: { path: string; base_hash: string } }>(
    "/api/v1/documents",
    async (request) =>
      store.exclusive(() => {
        const result = core.documents.delete(
          request.body.path,
          request.body.base_hash,
          String(request.headers["idempotency-key"]),
        );
        core.emit("document_changed", {
          path: request.body.path,
          deleted: true,
        });
        backup.changed();
        return result;
      }),
  );
  app.post<{ Body: { path: string; new_path: string; base_hash: string } }>(
    "/api/v1/documents/rename",
    async (request) =>
      store.exclusive(() => {
        const result = core.documents.rename(
          request.body.path,
          request.body.new_path,
          request.body.base_hash,
          String(request.headers["idempotency-key"]),
        );
        core.emit("document_changed", {
          path: request.body.path,
          renamed_to: result.path,
        });
        core.emit("document_changed", { path: result.path });
        backup.changed();
        return result;
      }),
  );
  app.get("/api/v1/documents/trash", () => ({
    entries: core.documents.listTrash(),
  }));
  app.post<{ Body: { recovery_id: string } }>(
    "/api/v1/documents/recover",
    async (request) =>
      store.exclusive(() => {
        const result = core.documents.restoreTrash(
          request.body.recovery_id,
          String(request.headers["idempotency-key"]),
        );
        core.emit("document_changed", { path: result.path });
        backup.changed();
        return result;
      }),
  );
  app.post("/api/v1/attachments", async (request) => {
    const upload = await request.file();
    if (!upload) throw new AppError("NO_ATTACHMENT", "没有附件", 400);
    const ext = path.extname(upload.filename).toLowerCase();
    if (
      ![
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".pdf",
        ".txt",
        ".csv",
        ".md",
        ".svg",
        ".html",
        ".zip",
        ".docx",
        ".xlsx",
      ].includes(ext)
    )
      throw new AppError("ATTACHMENT_TYPE", "不支持的附件类型", 415);
    const buffer = await upload.toBuffer();
    if (upload.file.truncated)
      throw new AppError("ATTACHMENT_TOO_LARGE", "附件过大", 413);
    const signature = buffer.subarray(0, 12);
    if (
      (ext === ".png" &&
        !signature
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
      ([".jpg", ".jpeg"].includes(ext) &&
        !signature.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) ||
      (ext === ".pdf" && !signature.toString().startsWith("%PDF-"))
    )
      throw new AppError("ATTACHMENT_TYPE", "附件类型与文件内容不符", 415);
    const relative = "Attachment/" + id("file") + ext;
    atomicWrite(store.files.resolve(relative, "attachment"), buffer);
    backup.changed();
    return { path: relative, link: `![[${relative}]]` };
  });
  app.get<{ Querystring: { path: string } }>(
    "/api/v1/attachments",
    async (request, reply) => {
      const p = store.files.resolve(request.query.path, "attachment");
      if (!fs.existsSync(p)) throw new AppError("NOT_FOUND", "附件不存在", 404);
      const ext = path.extname(p);
      const type: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".pdf": "application/pdf",
      };
      reply
        .header("X-Content-Type-Options", "nosniff")
        .type(type[ext] ?? "application/octet-stream");
      if (!type[ext]) reply.header("Content-Disposition", "attachment");
      return store.files.readBytes(request.query.path,"attachment",cfg.web.max_attachment_bytes);
    },
  );
  app.post<{
    Body: {
      bot_id: string;
      user_id: string;
      message_id: string;
      text: string;
      occurred_at: string;
      reply_to?: string;
    };
  }>(
    "/internal/channel-input",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["bot_id", "user_id", "message_id", "text", "occurred_at"],
          properties: {
            bot_id: { type: "string", pattern: "^\\d{5,20}$" },
            user_id: { type: "string", pattern: "^\\d{5,20}$" },
            message_id: { type: "string", minLength: 1, maxLength: 128 },
            text: { type: "string", minLength: 1, maxLength: 20000 },
            occurred_at: { type: "string", maxLength: 40 },
            reply_to: { type: "string", maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const bot = env.SECRETARY_QQ_BOT_ID,
        owner = env.SECRETARY_RECIPIENT;
      if (
        !bot ||
        !owner ||
        request.body.bot_id !== bot ||
        request.body.user_id !== owner
      )
        throw new AppError("FORBIDDEN", "QQ账号绑定不符", 403);
      const occurred = new Date(request.body.occurred_at);
      if (!Number.isFinite(occurred.getTime()))
        throw new AppError("INVALID_INPUT", "消息时间无效", 400);
      const received = await core.receive({
        id: id("input"),
        channel: "qq",
        actor_ref: bot + ":" + owner,
        external_id: request.body.message_id,
        text: request.body.text,
        occurred_at: occurred.toISOString(),
        reply_to: request.body.reply_to,
      });
      reply.code(202);
      return received;
    },
  );
  app.post<{ Body: WorkspaceCall }>(
    "/internal/workspace",
    {
      schema: {
        body: {
          type: "object",
          required: ["input_id", "call_id", "operation"],
          additionalProperties: false,
          properties: {
            input_id: { type: "string", maxLength: 200 },
            call_id: { type: "string", maxLength: 200 },
            operation: {
              enum: [
                "list",
                "search",
                "read",
                "write",
                "edit",
                "rename",
                "delete",
              ],
            },
            path: { type: "string", maxLength: 1024 },
            new_path: { type: "string", maxLength: 1024 },
            query: { type: "string", maxLength: 200 },
            content: { type: "string", maxLength: 200000 },
            old_text: { type: "string", maxLength: 200000 },
            new_text: { type: "string", maxLength: 200000 },
            base_hash: { type: "string", maxLength: 100 },
            offset: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    async (request) => {
      const result = await workspaceCall(core, request.body);
      store.db
        .prepare(
          "UPDATE inbox SET metadata_json=json_set(metadata_json,'$.workspace_calls',json_insert(COALESCE(json_extract(metadata_json,'$.workspace_calls'),'[]'),'$[#]',json(?))) WHERE id=?",
        )
        .run(
          JSON.stringify({
            operation: request.body.operation,
            path: request.body.path ?? "",
            new_path: request.body.new_path ?? null,
          }),
          request.body.input_id,
        );
      if (
        ["write", "edit", "rename", "delete"].includes(request.body.operation)
      ) {
        store.db
          .prepare(
            "UPDATE inbox SET metadata_json=json_set(metadata_json,'$.workspace_operations',json_insert(COALESCE(json_extract(metadata_json,'$.workspace_operations'),'[]'),'$[#]',json(?))) WHERE id=?",
          )
          .run(
            JSON.stringify({
              operation: request.body.operation,
              path: request.body.path,
              new_path: request.body.new_path ?? null,
            }),
            request.body.input_id,
          );
        backup.changed();
      }
      return result;
    },
  );
  app.post<{ Body: ApplicationCall }>(
    "/internal/application",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["input_id", "call_id", "operation"],
          properties: {
            input_id: { type: "string", maxLength: 200 },
            call_id: { type: "string", maxLength: 200 },
            operation: {
              enum: [
                "apply_changes", "save_proposals", "resolve_proposals", "conversation",
                "preferences",
                "followups",
                "rules",
                "automations",
                "focus",
                "board",
                "planning_context",
                "capabilities",
                "planning",
                "periods",
                "create_period",
                "state",
                "day",
                "status",
                "trash",
                "restore_note",
                "history",
                "history_content",
                "restore_version",
              ],
            },
            kind: {
              enum: ["daily", "weekly", "monthly", "quarterly", "yearly"],
            },
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            scope: {
              enum: [
                "all",
                "habits",
                "tasks",
                "plans",
                "controls",
                "proposals",
              ],
            },
            query: { type: "string", maxLength: 200 },
            ids: {
              type: "array",
              maxItems: 50,
              items: { type: "string", maxLength: 100 },
            },
            offset: { type: "integer", minimum: 0 },
            path: { type: "string", maxLength: 1024 },
            recovery_id: { type: "string", maxLength: 150 },
            commit: { type: "string", maxLength: 40 },
            base_hash: { type: "string", maxLength: 100 },
            action_groups: AGENT_TOOLS.find(t => t.name === "secretary")!.parameters.properties.action_groups,
            commit_mode: AGENT_TOOLS.find(t => t.name === "secretary")!.parameters.properties.commit_mode,
            decisions: AGENT_TOOLS.find(t => t.name === "secretary")!.parameters.properties.decisions,
            summary: { type: "string", maxLength: 500 },
          },
        },
      },
    },
    async (request) => {
      const result = await applicationCall(core, request.body, {
        backup,
        status: () => ({
          model: agentStatus,
          planning: { error: core.coordinator.lastError },
          assistant: { error: core.assistant.lastError },
          qq: channel.health(),
          scheduler: {
            last_tick: scheduler.lastTick,
            error: scheduler.lastError,
          },
          backup: {
            enabled: backup.options.enabled,
            last_commit: backup.lastCommit,
            last_push: backup.lastPush,
            error: backup.error,
          },
          maintenance: { last: maintenance.last, error: maintenance.error },
          recovery_until: store.recoveryUntil,
        }),
      });
      const entry = JSON.stringify({
        operation: request.body.operation,
        path: request.body.path ?? (result as any)?.path ?? "",
      });
      store.db
        .prepare(
          "UPDATE inbox SET metadata_json=json_set(metadata_json,'$.application_calls',json_insert(COALESCE(json_extract(metadata_json,'$.application_calls'),'[]'),'$[#]',json(?))) WHERE id=?",
        )
        .run(entry, request.body.input_id);
      if (
        ["create_period", "restore_note", "restore_version"].includes(
          request.body.operation,
        )
      ) {
        store.db
          .prepare(
            "UPDATE inbox SET metadata_json=json_set(metadata_json,'$.workspace_operations',json_insert(COALESCE(json_extract(metadata_json,'$.workspace_operations'),'[]'),'$[#]',json(?))) WHERE id=?",
          )
          .run(entry, request.body.input_id);
        backup.changed();
      }
      return result;
    },
  );
  const modelBudget=new ModelBudget(store,env.LLM_MODEL);
  app.post<{Body:{input_id:string;kind:"front"|"background"|"compose"|"self_test";tools_hash?:string}}>("/internal/model/jobs/start",{
    schema:{body:{type:"object",additionalProperties:false,required:["input_id","kind","tools_hash"],properties:{input_id:{type:"string",maxLength:200},kind:{enum:["front","background","compose","self_test"]},tools_hash:{type:"string",pattern:"^sha256:[a-f0-9]{64}$"}}}},
  },async request=>store.exclusive(()=>{
    if(request.body.tools_hash!==hash(JSON.stringify(AGENT_TOOLS)))throw new AppError("AGENT_CONTRACT_MISMATCH","工具合同与Core不兼容",409);
    return beginModelJob(store,request.body.input_id,request.body.kind);
  }));
  app.post<{Body:{job_id:string}}>("/internal/model/jobs/end",{
    schema:{body:{type:"object",additionalProperties:false,required:["job_id"],properties:{job_id:{type:"string",maxLength:200}}}},
  },async request=>store.exclusive(()=>{endModelJob(store,request.body.job_id);return {ended:true};}));
  let modelInFlight = false;
  const modelRequests = new Set<AbortController>();
  app.post(
    "/internal/model/v1/chat/completions",
    { bodyLimit: 400000 },
    async (request, reply) => {
      if (!env.LLM_BASE_URL || !env.LLM_API_KEY)
        throw new AppError("MODEL_UNCONFIGURED", "模型未配置", 503);
      const body = request.body as any;
      if (!body || body.model !== env.LLM_MODEL)
        throw new AppError("MODEL_FORBIDDEN", "模型不在允许范围", 403);
      if (
        !Array.isArray(body.messages) ||
        body.messages.length > 60 ||
        (body.tools &&
          (!Array.isArray(body.tools) ||
            body.tools.length > AGENT_TOOL_NAMES.length ||
            body.tools.some(
              (tool: any) =>
                tool.type !== "function" ||
                !(AGENT_TOOL_NAMES as readonly string[]).includes(
                  tool.function?.name,
                ),
            )))
      )
        throw new AppError("MODEL_SCOPE", "请求不符合受限模型协议", 403);
      if (modelInFlight)
        throw new AppError("MODEL_BUSY", "模型正在处理另一件事", 429);
      const base = new URL(env.LLM_BASE_URL);
      if (
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        (base.protocol !== "https:" && env.NODE_ENV === "production")
      )
        throw new AppError("MODEL_ENDPOINT_INVALID", "模型接口配置不合法", 503);
      const forwarded: any = {
        model: env.LLM_MODEL,
        messages: body.messages,
        stream: body.stream !== false,
      };
      for (const key of [
        "stream_options",
        "tools",
        "tool_choice",
        "temperature",
        "top_p",
        "frequency_penalty",
        "presence_penalty",
        "parallel_tool_calls",
        "reasoning_effort",
      ])
        if (body[key] !== undefined) forwarded[key] = body[key];
      // Keep DeepSeek Flash in thinking mode, but pin the effort to low so
      // routine secretary turns remain inexpensive and quick. This is set at
      // the provider boundary rather than trusting optional client fields.
      if (env.LLM_MODEL === "deepseek-flash") {
        forwarded.thinking = { type: "enabled" };
        forwarded.reasoning_effort = "low";
        // DeepSeek's thinking mode rejects `tool_choice: required`; the
        // that value when it must obtain a structured proposal. `auto` still
        // permits the proposal tool and is the compatible provider contract.
        if (forwarded.tool_choice === "required")
          forwarded.tool_choice = "auto";
      }
      const tokenField =
        body.max_completion_tokens !== undefined
          ? "max_completion_tokens"
          : "max_tokens";
      forwarded[tokenField] = Math.max(
        1,
        Math.min(cfg.agent.budget.request_output_tokens, Math.floor(Number(body[tokenField]) || cfg.agent.budget.request_output_tokens)),
      );
      const deadline=modelDeadline(store,env.NODE_ENV==="production");
      const reservation=modelBudget.reserve({messages:forwarded.messages,tools:forwarded.tools},forwarded[tokenField],store.runtimeMeta().model_job?.id??"fixture-unbound");
      let usage:any=null;
      const abort = new AbortController();
      modelRequests.add(abort);
      modelInFlight = true;
      const cancel = () => abort.abort();
      reply.raw.once("close", cancel);
      try {
        const response = await fetch(
          base.toString().replace(/\/$/, "") + "/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + env.LLM_API_KEY,
            },
            body: JSON.stringify(forwarded),
            signal: AbortSignal.any([
              abort.signal,
              AbortSignal.timeout(Math.min(125000,deadline)),
            ]),
            redirect: "error",
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          console.error(
            JSON.stringify({
              event: "model_upstream_error",
              status: response.status,
            }),
          );
          throw new AppError("MODEL_UPSTREAM_FAILED", "模型暂时不可用", 503);
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of response.body ?? []) {
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > 2 * 1024 * 1024) {
            abort.abort();
            throw new AppError(
              "MODEL_RESPONSE_TOO_LARGE",
              "模型回复超过限制",
              503,
            );
          }
          chunks.push(buffer);
        }
        reply.type(response.headers.get("content-type") ?? "application/json");
        const content=Buffer.concat(chunks);
        try {
          if(forwarded.stream) {
            for(const line of content.toString("utf8").split(/\r?\n/))
              if(line.startsWith("data: ") && line.slice(6)!=="[DONE]") {const frame=JSON.parse(line.slice(6));if(frame.usage)usage=frame.usage;}
          } else usage=JSON.parse(content.toString("utf8")).usage??null;
        }catch{/* Missing usage keeps the complete conservative reservation. */}
        return content;
      } finally {
        modelBudget.settle(reservation,usage);
        reply.raw.off("close", cancel);
        modelRequests.delete(abort);
        modelInFlight = false;
      }
    },
  );
  const web = path.join(projectRoot, "dist/web");
  if (fs.existsSync(web)) {
    await app.register(staticPlugin, {
      root: web,
      prefix: "/",
      setHeaders: (response, file) => {
        if (file.includes(path.sep + "assets" + path.sep))
          response.header(
            "Cache-Control",
            "public, max-age=31536000, immutable",
          );
        else response.header("Cache-Control", "no-store");
      },
    });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api") || request.url.startsWith("/internal")
        ? reply.code(404).send({ error: { code: "NOT_FOUND" } })
        : reply.sendFile("index.html"),
    );
  }
  let timer: NodeJS.Timeout | undefined,
    cycleTask: Promise<void> | undefined,
    coreStopping: Promise<void> | undefined,
    closing = false;
  if (options.timers !== false) {
    if (channel instanceof AstrBotChannel) channel.connect();
    const cycle = () => {
      if (closing || cycleTask) return;
      cycleTask = (async () => {
        await core.coordinator.tick();
        await core.assistant.tick();
        void scheduler.tick();
        if (closing) return;
        checkAgent();
        void core.processPending();
        core.assistant.startPlanning();
        void backup.tick();
        const previousCleanup = maintenance.last?.at;
        await snapshotBackup.tick();
        await maintenance.tick();
        if (previousCleanup !== maintenance.last?.at) backup.changed();
      })()
        .catch(() => {
          log.write("cycle_error", { code: "CYCLE_FAILED" });
        })
        .finally(() => {
          cycleTask = undefined;
        });
    };
    timer = setInterval(() => cycle(), cfg.scheduler.tick_seconds * 1000);
    timer.unref();
    cycle();
  }
  app.addHook("onClose", async () => {
    closing = true;
    if (modelRetry) clearTimeout(modelRetry);
    if (timer) clearInterval(timer);
    if (channel instanceof AstrBotChannel) channel.close();
    configuredAgent?.close?.();
    await (coreStopping ?? core.stop());
    await cycleTask;
    await core.assistant.drain();
    await modelCheck;
    await scheduler.drain(true);
    await backup.drain();
    await store.close();
  });
  app.addHook("preClose", async () => {
    closing = true;
    store.lifecycle="draining";
    scheduler.close();
    coreStopping = core.stop();
    if (timer) clearInterval(timer);
    for (const stream of streams) stream.end();
    for (const request of modelRequests) request.abort();
    configuredAgent?.close?.();
    if (channel instanceof AstrBotChannel) channel.close();
  });
  return { app, core, store, scheduler, backup, openapi, checkAgent };
}
