import { CronExpressionParser } from "cron-parser";
import { applyJitter } from "./jitter.ts";
import { acquireLock } from "./lock.ts";

// Plan §H — in-process cron scheduler. Per-task setTimeout chains drive
// firings (more efficient than a single 1Hz poll for many tasks), with
// jitter applied to each scheduled fire and per-task locks preventing
// concurrent runs across process restarts.
//
// Phase-1 in-process scope. Multi-host fanout (the actual "200 brands at
// midnight UTC" use case) is out of scope per the plan.

export interface CronTaskSpec<TCtx = unknown> {
  readonly id: string;
  // Standard cron expression — `cron-parser` handles parsing. Most useful
  // patterns: `0 2 * * *` (daily 2am), `*/5 * * * *` (every 5 min).
  readonly schedule: string;
  // ±jitterMs window around the scheduled fire time.
  readonly jitterMs?: number;
  // Lock key — fired runs acquire `${id}:${lockKey(ctx)}`.
  readonly lockKey: (ctx: TCtx) => string;
  // Time we'll wait for a lock before assuming the previous holder is dead.
  // Should be ≥ the longest expected run duration.
  readonly lockTtlMs?: number;
  readonly run: (ctx: TCtx) => Promise<void>;
}

interface RegisteredTask<TCtx = unknown> {
  readonly spec: CronTaskSpec<TCtx>;
  readonly ctx: TCtx;
  timeout: Timer | null;
  active: boolean;
}

const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes

class Scheduler {
  private tasks = new Map<string, RegisteredTask<unknown>>();
  private started = false;

  register<TCtx>(spec: CronTaskSpec<TCtx>, ctx: TCtx): void {
    if (this.tasks.has(spec.id)) {
      throw new Error(`cron task already registered: ${spec.id}`);
    }
    const reg: RegisteredTask<TCtx> = {
      spec,
      ctx,
      timeout: null,
      active: false,
    };
    this.tasks.set(spec.id, reg as RegisteredTask<unknown>);
    if (this.started) this.scheduleNext(reg as RegisteredTask<unknown>);
  }

  unregister(id: string): void {
    const reg = this.tasks.get(id);
    if (reg === undefined) return;
    reg.active = false;
    if (reg.timeout !== null) clearTimeout(reg.timeout);
    this.tasks.delete(id);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const reg of this.tasks.values()) {
      this.scheduleNext(reg);
    }
  }

  stop(): void {
    this.started = false;
    for (const reg of this.tasks.values()) {
      reg.active = false;
      if (reg.timeout !== null) clearTimeout(reg.timeout);
      reg.timeout = null;
    }
  }

  // For tests: fire the task immediately (still goes through the lock).
  async _runNowForTest(id: string): Promise<void> {
    const reg = this.tasks.get(id);
    if (reg === undefined) throw new Error(`no such task: ${id}`);
    await this.fire(reg);
  }

  registeredIds(): readonly string[] {
    return [...this.tasks.keys()];
  }

  private scheduleNext(reg: RegisteredTask<unknown>): void {
    if (!this.started) return;
    reg.active = true;
    let nextFireMs: number;
    try {
      const expr = CronExpressionParser.parse(reg.spec.schedule);
      nextFireMs = expr.next().getTime();
    } catch (e) {
      console.error(
        `[cron] schedule parse failed for ${reg.spec.id}: ${(e as Error).message}`,
      );
      return;
    }
    const delay = Math.max(
      0,
      nextFireMs - Date.now() + applyJitter(reg.spec.jitterMs ?? 0),
    );
    reg.timeout = setTimeout(async () => {
      if (!reg.active) return;
      try {
        await this.fire(reg);
      } catch (e) {
        console.error(
          `[cron] task ${reg.spec.id} threw: ${(e as Error).message}`,
        );
      }
      this.scheduleNext(reg);
    }, delay);
  }

  private async fire(reg: RegisteredTask<unknown>): Promise<void> {
    const lockKey = `${reg.spec.id}:${reg.spec.lockKey(reg.ctx)}`;
    const ttl = reg.spec.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    const lock = await acquireLock(lockKey, ttl);
    if (lock === null) {
      console.warn(
        `[cron] task ${reg.spec.id} skipped — lock ${lockKey} held`,
      );
      return;
    }
    try {
      await reg.spec.run(reg.ctx);
    } finally {
      lock.release();
    }
  }
}

// Process-wide singleton. Hosts call `cronScheduler.register(...)` then
// `cronScheduler.start()`.
export const cronScheduler = new Scheduler();
