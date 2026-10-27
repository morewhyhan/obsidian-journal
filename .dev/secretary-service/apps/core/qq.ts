import WebSocket from "ws";
import { id } from "./files.js";
import type { Core } from "./core.js";
import type { Channel } from "./scheduler.js";
const validId = (value: unknown) =>
  (typeof value === "string" && value.length > 0 && value.length <= 128) ||
  (typeof value === "number" && Number.isSafeInteger(value));
export class OneBotChannel implements Channel {
  socket?: WebSocket;
  lastEventAt: string | null = null;
  private stopped = false;
  private reconnect?: NodeJS.Timeout;
  private retry = 0;
  private pending = new Map<
    string,
    { resolve: (result: any) => void; timer: NodeJS.Timeout }
  >();
  constructor(
    private core: Core,
    private options: {
      url: string;
      token: string;
      botId: string;
      userId: string;
      timeoutMs?: number;
    },
  ) {}
  connect() {
    if (
      this.stopped ||
      (this.socket &&
        [WebSocket.OPEN, WebSocket.CONNECTING].includes(
          this.socket.readyState as 0 | 1,
        ))
    )
      return;
    this.socket = new WebSocket(this.options.url, {
      headers: { Authorization: "Bearer " + this.options.token },
      maxPayload: 262144,
    });
    this.socket.on("open", () => {
      this.retry = 0;
    });
    this.socket.on("message", (raw) => {
      try {
        const event = JSON.parse(raw.toString());
        if (event.echo) {
          const request = this.pending.get(String(event.echo));
          if (request) {
            clearTimeout(request.timer);
            this.pending.delete(String(event.echo));
            if (event.status === "ok" && validId(event.data?.message_id))
              request.resolve({
                status: "sent",
                externalId: String(event.data.message_id),
              });
            else if (
              event.status === "failed" &&
              Number.isInteger(event.retcode) &&
              event.retcode !== 0
            )
              request.resolve({ status: "failed", reason: "CHANNEL_REJECTED" });
            else
              request.resolve({
                status: "unknown",
                reason: "CHANNEL_UNCONFIRMED",
              });
          }
          return;
        }
        if (
          String(event.self_id) !== this.options.botId ||
          event.post_type !== "message" ||
          event.message_type !== "private" ||
          String(event.user_id) !== this.options.userId
        )
          return;
        if (
          !validId(event.self_id) ||
          !validId(event.user_id) ||
          !validId(event.message_id) ||
          !Number.isFinite(event.time) ||
          Math.abs(event.time * 1000 - this.core.store.clock().getTime()) >
            30 * 86400000
        )
          return;
        this.lastEventAt = this.core.store.now();
        let text = "",
          reply: string | undefined;
        if (Array.isArray(event.message))
          for (const part of event.message) {
            if (part.type === "text" && typeof part.data?.text === "string")
              text += part.data.text;
            if (part.type === "reply" && validId(part.data?.id))
              reply = String(part.data.id);
          }
        else {
          text = String(event.raw_message ?? event.message ?? "");
          text = text
            .replace(/\[CQ:reply,id=([^,\]]+)[^\]]*\]/g, (_all, value) => {
              reply = value;
              return "";
            })
            .replace(/\[CQ:[^\]]+\]/g, "")
            .replace(/&#91;/g, "[")
            .replace(/&#93;/g, "]")
            .replace(/&#44;/g, ",")
            .replace(/&amp;/g, "&");
        }
        if (!text.trim()) return;
        void this.core
          .receive({
            id: id("input"),
            channel: "qq",
            actor_ref: this.options.botId + ":" + this.options.userId,
            external_id: String(event.message_id),
            text,
            occurred_at: new Date(Number(event.time) * 1000).toISOString(),
            reply_to: reply,
          })
          .catch(() => {});
      } catch {}
    });
    this.socket.on("error", () => {});
    this.socket.on("close", () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.resolve({ status: "unknown", reason: "CHANNEL_DISCONNECTED" });
      }
      this.pending.clear();
      if (!this.stopped) {
        const delays = [1, 2, 5, 10, 30, 60];
        this.reconnect = setTimeout(
          () => this.connect(),
          delays[Math.min(this.retry++, 5)] * 1000,
        );
        this.reconnect.unref();
      }
    });
  }
  send(message: {
    id: string;
    recipient: string;
    body: string;
  }): Promise<Awaited<ReturnType<Channel["send"]>>> {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.resolve({
        status: "failed",
        reason: "CHANNEL_DISCONNECTED",
      });
    const recipient = message.recipient.split(":").at(-1);
    if (message.body.length > 2000)
      return Promise.resolve({ status: "failed", reason: "MESSAGE_TOO_LONG" });
    if (recipient !== this.options.userId)
      return Promise.resolve({
        status: "failed",
        reason: "RECIPIENT_FORBIDDEN",
      });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id);
        resolve({ status: "unknown", reason: "CHANNEL_TIMEOUT" });
      }, this.options.timeoutMs ?? 15000);
      this.pending.set(message.id, { resolve, timer });
      this.socket!.send(
        JSON.stringify({
          action: "send_private_msg",
          params: {
            user_id: recipient,
            message: [{ type: "text", data: { text: message.body } }],
          },
          echo: message.id,
        }),
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(message.id);
            resolve({ status: "unknown", reason: "CHANNEL_WRITE_ERROR" });
          }
        },
      );
    });
  }
  health() {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      lastEventAt: this.lastEventAt,
    };
  }
  close() {
    this.stopped = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.socket?.close();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ status: "unknown", reason: "SHUTDOWN" });
    }
    this.pending.clear();
  }
}
export class DisconnectedChannel implements Channel {
  health() {
    return { connected: false, lastEventAt: null };
  }
  async send() {
    return { status: "failed" as const, reason: "NOT_CONFIGURED" };
  }
}
