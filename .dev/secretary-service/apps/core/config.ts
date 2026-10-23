import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../../packages/contracts/types.js";
import { VaultFiles } from "./files.js";
function locateProject() {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (
    !fs.existsSync(path.join(current, "resources", "config.default.json"))
  ) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Service resources not found");
    current = parent;
  }
  return current;
}
export const projectRoot = locateProject();
export const resource = (name: string) =>
  path.join(projectRoot, "resources", name);
export type Config = ReturnType<typeof defaults>;
function defaults() {
  return JSON.parse(
    fs.readFileSync(resource("config.default.json"), "utf8"),
  ) as {
    schema_version: number;
    timezone: string;
    storage: { database: string; registry: string; day_records: string };
    notifications: {
      quiet_hours: { start: string; end: string };
      daily_proactive_message_cap: number;
      minimum_gap_minutes: number;
      per_plan_reminder_cap: number;
      follow_up_after_minutes: number;
      recent_engagement_hours: number;
      delivery_retry_cap: number;
      delivery_retry_delays_seconds: number[];
    };
    retention: {
      outbox_body_days: number;
      outbox_receipt_days: number;
      inbox_terminal_days: number;
      events_completed_days: number;
      unknown_abandon_after_window_days: number;
      registry_ended_plan_days: number;
      trash_days: number;
      vacuum_min_database_mib: number;
      vacuum_min_free_fraction: number;
      cleanup_local_time: string;
    };
    web: {
      autosave_idle_ms: number;
      max_document_bytes: number;
      max_attachment_bytes: number;
    };
    channel: {
      enabled: boolean;
      max_input_bytes: number;
      send_timeout_seconds: number;
    };
    agent: {
      provider: string;
      interpret_timeout_seconds: number;
      compose_timeout_seconds: number;
      max_tool_calls: number;
    };
    scheduler: {
      tick_seconds: number;
      lookahead_hours: number;
      delivery_lease_seconds: number;
    };
    sync: {
      git: {
        enabled: boolean;
        branch: string;
        debounce_seconds: number;
        continuous_edit_commit_max_seconds: number;
        retry_delay_minutes: number[];
        degraded_retry_minutes: number;
      };
    };
  };
}
export function loadConfig(vault: string) {
  const cfg = defaults(),
    p = new VaultFiles(vault).resolve(".agent/config.json", "internal");
  if (fs.existsSync(p)) {
    const override = JSON.parse(fs.readFileSync(p, "utf8"));
    merge(cfg, override);
  }
  if (
    !["Asia/Shanghai", "UTC"].includes(cfg.timezone) &&
    !Intl.supportedValuesOf("timeZone").includes(cfg.timezone)
  )
    throw new AppError("CONFIG_INVALID", "无效时区", 500);
  for (const key of ["database", "registry", "day_records"] as const) {
    const p = path.resolve(vault, cfg.storage[key]);
    if (!p.startsWith(path.resolve(vault) + path.sep))
      throw new AppError("CONFIG_INVALID", "运行路径必须在笔记根内", 500);
    new VaultFiles(vault).resolve(cfg.storage[key], "internal");
  }
  if (
    !/^\.agent\/data\/.+\.sqlite$/.test(cfg.storage.database) ||
    !/^\.agent\/state\/.+\.json$/.test(cfg.storage.registry) ||
    !/^\.agent\/state\//.test(cfg.storage.day_records)
  )
    throw new AppError("CONFIG_INVALID", "运行资料应位于约定的后台目录", 500);
  const bounded = (value: unknown, min: number, max: number, integer = true) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!integer || Number.isInteger(value)) &&
    value >= min &&
    value <= max;
  const validTime = (value: unknown) =>
    typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (
    !validTime(cfg.notifications.quiet_hours.start) ||
    !validTime(cfg.notifications.quiet_hours.end) ||
    cfg.notifications.quiet_hours.start === cfg.notifications.quiet_hours.end ||
    !validTime(cfg.retention.cleanup_local_time)
  )
    throw new AppError("CONFIG_INVALID", "静默和清理时刻无效", 500);
  for (const [value, min, max] of [
    [cfg.notifications.daily_proactive_message_cap, 0, 4],
    [cfg.notifications.minimum_gap_minutes, 60, 1440],
    [cfg.notifications.follow_up_after_minutes, 90, 1440],
    [cfg.notifications.delivery_retry_cap, 0, 2],
    [cfg.scheduler.tick_seconds, 1, 30],
    [cfg.scheduler.delivery_lease_seconds, 30, 300],
    [cfg.channel.send_timeout_seconds, 1, 15],
    [cfg.channel.max_input_bytes, 1, 16384],
    [cfg.web.max_document_bytes, 1024, 2097152],
    [cfg.web.max_attachment_bytes, 1024, 20971520],
    [cfg.retention.events_completed_days, 90, 365],
  ] as number[][])
    if (!bounded(value, min, max))
      throw new AppError("CONFIG_INVALID", "运行参数不在允许范围内", 500);
  if (
    cfg.schema_version !== 1 ||
    cfg.agent.provider !== "pi" ||
    !Array.isArray(cfg.notifications.delivery_retry_delays_seconds) ||
    cfg.notifications.delivery_retry_delays_seconds.length !== 2 ||
    cfg.notifications.delivery_retry_delays_seconds.some(
      (n) => !bounded(n, 1, 3600),
    )
  )
    throw new AppError("CONFIG_INVALID", "配置与 v1 运行协议不匹配", 500);
  return cfg;
}
function merge(target: any, source: any) {
  for (const [k, v] of Object.entries(source)) {
    if (["__proto__", "constructor", "prototype"].includes(k))
      throw new Error("Unsafe config key");
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      target[k] &&
      typeof target[k] === "object"
    )
      merge(target[k], v);
    else target[k] = v;
  }
}
export function validateProductionSettings(settings: {
  passwordHash: string;
  sessionKey: string;
  origin?: string;
  env: NodeJS.ProcessEnv;
}) {
  if (settings.env.NODE_ENV !== "production") return;
  const invalid = (message: string): never => {
    throw new AppError("CONFIG_INVALID", message, 500);
  };
  const parse = (value: string) => {
    try {
      return new URL(value);
    } catch {
      return invalid("接口地址配置不合法");
    }
  };
  if (
    Buffer.byteLength(settings.sessionKey) < 32 ||
    !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(settings.passwordHash)
  )
    invalid("生产登录配置需要密码哈希和至少32字节的独立会话密钥");
  const origin = parse(settings.origin ?? "http://localhost");
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    invalid("生产公开入口需要明确的 HTTPS Origin");
  if (settings.env.SECRETARY_PI_URL) {
    const pi = parse(settings.env.SECRETARY_PI_URL);
    if (
      !["pi", "localhost", "127.0.0.1", "[::1]"].includes(pi.hostname) ||
      pi.protocol !== "http:" ||
      pi.username ||
      pi.password ||
      pi.pathname !== "/" ||
      pi.search ||
      pi.hash ||
      Buffer.byteLength(settings.env.SECRETARY_PI_INTERNAL_TOKEN ?? "") < 32
    )
      invalid("Pi应使用独立内部地址和至少32字节的机器凭据");
  }
  if (settings.env.LLM_BASE_URL) {
    const provider = parse(settings.env.LLM_BASE_URL);
    if (
      provider.protocol !== "https:" ||
      provider.username ||
      provider.password ||
      provider.search ||
      provider.hash
    )
      invalid("生产模型接口需要固定的HTTPS地址，凭据单独配置");
  }
  if (settings.env.SECRETARY_QQ_ENABLED === "1") {
    if (settings.env.QQ_PROTOCOL === "official") {
      if (
        !/^\d+$/.test(settings.env.QQ_APP_ID ?? "") ||
        !settings.env.QQ_APP_SECRET
      )
        invalid("QQ官方接入需要AppID和独立AppSecret");
      return;
    }
    if (
      ![
        "QQ_WS_URL",
        "QQ_ACCESS_TOKEN",
        "QQ_BOT_ID",
        "SECRETARY_RECIPIENT",
      ].every((key) => !!settings.env[key])
    )
      invalid("QQ启用后需要完整的网关和私聊账号配置");
    const gateway = parse(settings.env.QQ_WS_URL!);
    if (
      !["ws:", "wss:"].includes(gateway.protocol) ||
      gateway.username ||
      gateway.password
    )
      invalid("QQ网关地址不合法");
  }
}
