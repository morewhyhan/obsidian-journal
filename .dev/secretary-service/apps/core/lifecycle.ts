import { AppError } from "../../packages/contracts/types.js";

export type LifecycleState =
  | "starting"
  | "recovering"
  | "migrating"
  | "ready"
  | "degraded"
  | "draining"
  | "maintenance"
  | "stopped";

/**
 * Every legal runtime transition. The table is deliberately closed: a state that
 * is not listed here is a programming error, not a degraded mode.
 */
const TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  starting: ["recovering", "migrating", "ready", "degraded", "stopped"],
  recovering: ["migrating", "ready", "degraded", "stopped"],
  migrating: ["ready", "degraded", "stopped"],
  ready: ["degraded", "draining", "maintenance", "stopped"],
  degraded: ["ready", "draining", "maintenance", "stopped"],
  maintenance: ["ready", "degraded", "draining", "stopped"],
  draining: ["stopped"],
  stopped: [],
};

/** States that may accept new user input and business commits. */
const WRITABLE: readonly LifecycleState[] = ["ready", "degraded"];
/** Only a fully ready runtime may claim background or contact work. */
const BACKGROUND: readonly LifecycleState[] = ["ready"];

/**
 * Minimal runtime lifecycle: an explicit state machine with recorded degraded
 * reasons and the two gates the rest of the service reads.
 *
 * It does not own draining work. Shutdown ordering stays in apps/core/app.ts;
 * this object only refuses new work once the runtime has left ready/degraded.
 */
export class Lifecycle {
  private state: LifecycleState = "starting";
  private reasons: string[] = [];

  get current(): LifecycleState {
    return this.state;
  }
  get degradedReasons(): readonly string[] {
    return this.reasons;
  }
  /** New input and business commits. */
  acceptsWork(): boolean {
    return WRITABLE.includes(this.state);
  }
  /** Background claims, contact dispatch and snapshot work. */
  acceptsBackground(): boolean {
    return BACKGROUND.includes(this.state);
  }

  /**
   * Validated transition. Repeating the current state is allowed (callers
   * re-assert a mode); anything else outside TRANSITIONS throws.
   */
  set(next: LifecycleState, ...reasons: string[]): LifecycleState {
    if (next === this.state) {
      if (next === "degraded") for (const reason of reasons) this.note(reason);
      return this.state;
    }
    if (!TRANSITIONS[this.state].includes(next))
      throw new AppError("LIFECYCLE_TRANSITION", "运行时状态不允许该迁移", 500, {
        from: this.state,
        to: next,
      });
    this.state = next;
    if (next === "degraded") for (const reason of reasons) this.note(reason);
    if (next === "ready") this.reasons = [];
    return this.state;
  }

  /** Degrade a serving runtime. Refuses when the current state cannot serve. */
  degrade(...reasons: string[]): LifecycleState {
    if (this.state === "degraded") {
      for (const reason of reasons) this.note(reason);
      return this.state;
    }
    if (this.state !== "ready" && this.state !== "maintenance")
      throw new AppError("LIFECYCLE_TRANSITION", "当前运行时状态不能降级", 500, {
        from: this.state,
        to: "degraded",
      });
    this.state = "degraded";
    for (const reason of reasons) this.note(reason);
    return this.state;
  }

  /** Drop one degraded reason; a fixed reason returns the runtime to ready. */
  resolveReason(reason: string): LifecycleState {
    this.reasons = this.reasons.filter((x) => x !== reason);
    if (this.state === "degraded" && this.reasons.length === 0)
      return this.set("ready");
    return this.state;
  }

  requireWork() {
    if (!this.acceptsWork())
      throw new AppError(
        "RUNTIME_NOT_READY",
        "系统正在恢复、排空或维护，未接纳新交代",
        503,
        { state: this.state, reasons: this.reasons },
      );
  }
  requireBackground() {
    if (!this.acceptsBackground())
      throw new AppError(
        "RUNTIME_NOT_READY",
        "系统正在恢复、排空或维护，暂不领取后台工作",
        503,
        { state: this.state, reasons: this.reasons },
      );
  }

  snapshot() {
    return {
      state: this.state,
      reasons: [...this.reasons],
      accepts_work: this.acceptsWork(),
      accepts_background: this.acceptsBackground(),
    };
  }

  private note(reason: string) {
    if (!this.reasons.includes(reason)) this.reasons.push(reason);
  }
}

export function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === "string" && value in TRANSITIONS;
}
