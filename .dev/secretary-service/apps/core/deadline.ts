import { AppError } from "../../packages/contracts/types.js";

export type DeadlineReport = (label: string, ms: number) => void;
let report: DeadlineReport | undefined;
/** Installed once by the app so a timeout leaves a diagnostic instead of silence. */
export function onDeadline(handler: DeadlineReport) {
  report = handler;
}

/**
 * Run work under a hard deadline. It always settles, so a caller can never be
 * held forever by a model, a channel or a filesystem call that does not return.
 * The abandoned promise is not awaited again; its effects must already be
 * idempotent through the operation identity they carry.
 */
export async function withDeadline<T>(
  label: string,
  ms: number,
  run: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          report?.(label, ms);
          reject(
            new AppError("DEADLINE_EXCEEDED", `操作超时：${label}`, 503, {
              label,
              ms,
            }),
          );
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A lease that expires by itself. Unlike a boolean flag, a holder that hangs or
 * dies cannot keep every other caller out: once the ttl passes the next caller
 * takes over, and a late release from the old holder cannot free the new one.
 */
export class Lease {
  private token = 0;
  private startedAt = 0;
  constructor(
    readonly name: string,
    readonly ttlMs: number,
  ) {}
  get held(): boolean {
    return this.token !== 0 && Date.now() - this.startedAt < this.ttlMs;
  }
  get expired(): boolean {
    return this.token !== 0 && !this.held;
  }
  ageMs(): number {
    return this.token === 0 ? 0 : Date.now() - this.startedAt;
  }
  /** Returns a token when the lease is free or expired, otherwise null. */
  tryAcquire(): number | null {
    if (this.held) return null;
    this.token += 1;
    this.startedAt = Date.now();
    return this.token;
  }
  release(token: number) {
    if (token === this.token) {
      this.token = 0;
      this.startedAt = 0;
    }
  }
}
