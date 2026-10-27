import type { Channel } from "./scheduler.js";

export class AstrBotChannel implements Channel {
  private state = {
    connected: false,
    bound: false,
    lastEventAt: null as string | null,
    transport: "astrbot-napcat",
  };
  private timer?: NodeJS.Timeout;
  private abort = new AbortController();
  constructor(
    private url: string,
    private token: string,
    private recipient: string,
    private timeoutMs = 15000,
  ) {}
  health() {
    return { ...this.state };
  }
  async refresh() {
    try {
      const response = await fetch(this.url + "/healthz", {
        headers: { Authorization: "Bearer " + this.token },
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(4000)]),
        redirect: "error",
      });
      const result: any = await response.json();
      if (!response.ok || result.agent !== "astrbot") throw new Error();
      this.state = {
        connected: result.qq?.connected === true,
        bound: result.qq?.bound === true,
        lastEventAt: result.qq?.lastEventAt ?? null,
        transport: "astrbot-napcat",
      };
    } catch {
      this.state.connected = false;
    }
  }
  connect() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 5000);
    this.timer.unref();
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
  }
  async send(message: {
    id: string;
    recipient: string;
    body: string;
  }): Promise<Awaited<ReturnType<Channel["send"]>>> {
    if (message.recipient.split(":").at(-1) !== this.recipient)
      return { status: "failed", reason: "RECIPIENT_FORBIDDEN" };
    try {
      const response = await fetch(this.url + "/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + this.token,
        },
        body: JSON.stringify(message),
        redirect: "error",
        signal: AbortSignal.any([
          this.abort.signal,
          AbortSignal.timeout(this.timeoutMs),
        ]),
      });
      const result: any = await response.json();
      if (
        response.ok &&
        result.status === "sent" &&
        typeof result.externalId === "string" &&
        result.externalId
      )
        return { status: "sent", externalId: result.externalId };
      if (response.ok && result.status === "failed")
        return { status: "failed", reason: "ASTRBOT_REJECTED" };
    } catch {
      /* Ambiguous sends are never blindly retried. */
    }
    return { status: "unknown", reason: "ASTRBOT_UNCONFIRMED" };
  }
}
