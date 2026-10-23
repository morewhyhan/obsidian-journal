import fs from "node:fs";
import {
  QQBot,
  ApiError,
  type QQBotInboundMessage,
} from "@tencent-connect/qqbot-nodejs";
import type { Core } from "./core.js";
import type { Channel } from "./scheduler.js";
import { atomicWrite, id } from "./files.js";
import { safeEqual } from "./auth.js";

type Options = {
  appId: string;
  appSecret: string;
  userId?: string;
  pairingToken?: string;
  pairingExpiresAt?: string;
  onBound?: (recipient: string) => void;
  timeoutMs?: number;
};
// Only the official transport sees credentials. No SDK logger receives messages or tokens.
export class OfficialQQChannel implements Channel {
  private bot: QQBot;
  private connected = false;
  private stopped = false;
  private running?: Promise<void>;
  private retry?: NodeJS.Timeout;
  private userId: string;
  private bindingPath: string;
  private lastEventAt: string | null = null;
  private error: string | null = null;
  constructor(
    private core: Core,
    private options: Options,
    bot?: QQBot,
  ) {
    this.bindingPath = core.store.files.resolve(
      ".agent/state/qq-binding.json",
      "internal",
    );
    const binding = fs.existsSync(this.bindingPath)
      ? JSON.parse(fs.readFileSync(this.bindingPath, "utf8"))
      : null;
    this.userId =
      options.userId ||
      (binding?.app_id === options.appId ? binding.user_id : "") ||
      "";
    this.bot =
      bot ??
      new QQBot({
        appId: options.appId,
        appSecret: options.appSecret,
        intents: 1 << 25,
        markdownSupport: false,
      });
    this.bot.on("ready", () => {
      this.connected = true;
      this.error = null;
    });
    this.bot.on("resumed", () => {
      this.connected = true;
      this.error = null;
    });
    this.bot.on("disconnected", () => {
      this.connected = false;
    });
    this.bot.on("error", () => {
      this.error = "QQ_CONNECTION_ERROR";
    });
    this.bot.on("message", async (_ctx, message) => {
      await this.receive(message);
    });
  }
  recipient() {
    return this.userId ? this.options.appId + ":" + this.userId : "";
  }
  async receive(message: QQBotInboundMessage) {
    if (
      this.stopped ||
      message.kind !== "c2c" ||
      !message.senderId ||
      !message.messageId ||
      message.senderId.length > 128 ||
      message.messageId.length > 256 ||
      typeof message.content !== "string" ||
      !Number.isFinite(Date.parse(message.timestamp))
    )
      return;
    if (!this.userId) {
      const token = this.options.pairingToken;
      if (
        !token ||
        token.length < 24 ||
        !this.options.pairingExpiresAt ||
        !Number.isFinite(Date.parse(this.options.pairingExpiresAt)) ||
        Date.parse(this.options.pairingExpiresAt) <=
          this.core.store.clock().getTime() ||
        !safeEqual(message.content.trim(), token)
      )
        return;
      await this.core.store.exclusive(() => {
        if (this.userId) return;
        atomicWrite(
          this.bindingPath,
          JSON.stringify({
            schema_version: 1,
            app_id: this.options.appId,
            user_id: message.senderId,
            bound_at: this.core.store.now(),
          }),
        );
        this.userId = message.senderId;
        this.options.onBound?.(this.recipient());
        const input = {
          id: id("input"),
          channel: "qq",
          actor_ref: this.recipient(),
          external_id: message.messageId,
          text: "",
          occurred_at: message.timestamp,
        };
        this.core.store.db
          .prepare(
            "INSERT OR IGNORE INTO inbox(id,channel,actor_ref,external_id,body,metadata_json,status,received_at,occurred_at,processed_at) VALUES(?,?,?,?,NULL,'{}','processed',?,?,?)",
          )
          .run(
            input.id,
            input.channel,
            input.actor_ref,
            input.external_id,
            this.core.store.now(),
            input.occurred_at,
            this.core.store.now(),
          );
        this.core.queueReply(input, "QQ 已连接。可以直接交代任务。");
      });
      return;
    }
    if (
      this.options.pairingToken &&
      safeEqual(message.content.trim(), this.options.pairingToken)
    )
      return;
    if (message.senderId !== this.userId || !message.content.trim()) return;
    this.lastEventAt = this.core.store.now();
    await this.core.receive({
      id: id("input"),
      channel: "qq",
      actor_ref: this.recipient(),
      external_id: message.messageId,
      text: message.content,
      occurred_at: message.timestamp,
      reply_to: message.refMsgIdx,
    });
  }
  connect() {
    if (this.stopped || this.running) return;
    this.running = this.bot
      .start()
      .catch((error) => {
        this.connected = false;
        this.error =
          (error as { code?: string }).code === "GATEWAY_FATAL_CLOSE"
            ? "QQ_PLATFORM_ACCESS_BLOCKED"
            : "QQ_CONNECTION_ERROR";
        if (!this.stopped && this.error !== "QQ_PLATFORM_ACCESS_BLOCKED") {
          this.retry = setTimeout(() => this.connect(), 60000);
          this.retry.unref();
        }
      })
      .finally(() => {
        this.running = undefined;
      });
  }
  async send(message: {
    id: string;
    recipient: string;
    body: string;
  }): ReturnType<Channel["send"]> {
    if (!this.userId || message.recipient !== this.recipient())
      return { status: "failed", reason: "RECIPIENT_FORBIDDEN" };
    if (!this.connected)
      return { status: "failed", reason: "CHANNEL_DISCONNECTED" };
    if (message.body.length > 2000)
      return { status: "failed", reason: "MESSAGE_TOO_LONG" };
    const receipt = this.core.store.db
      .prepare(
        "SELECT i.external_id FROM outbox o JOIN inbox i ON o.dedupe_key=i.id||':reply' WHERE o.id=? AND o.message_kind='receipt'",
      )
      .get(message.id) as { external_id: string } | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const response = await Promise.race([
        this.bot.sendText(
          { scope: "c2c", targetId: this.userId, msgId: receipt?.external_id },
          message.body,
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("TIMEOUT")),
            this.options.timeoutMs ?? 15000,
          );
        }),
      ]);
      if (!response?.id)
        return { status: "unknown", reason: "CHANNEL_UNCONFIRMED" };
      return {
        status: "sent",
        externalId: response.ext_info?.ref_idx ?? response.id,
      };
    } catch (error) {
      // A timeout, malformed success or server 5xx may have delivered the message.
      if (
        error instanceof ApiError &&
        error.httpStatus >= 400 &&
        error.httpStatus < 500
      )
        return {
          status: "failed",
          reason: "QQ_REJECTED_" + (error.bizCode ?? error.httpStatus),
        };
      return { status: "unknown", reason: "CHANNEL_UNCONFIRMED" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  health() {
    return {
      connected: this.connected,
      lastEventAt: this.lastEventAt,
      protocol: "official",
      bound: !!this.userId,
      error: this.error,
    };
  }
  close() {
    this.stopped = true;
    this.connected = false;
    if (this.retry) clearTimeout(this.retry);
    this.bot.stop();
  }
}
