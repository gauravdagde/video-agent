import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolUseContext } from "../Tool.ts";

// Plan §4.2 — in-process teammate fan-out. Each teammate runs in its own
// AsyncLocalStorage context so concurrent work doesn't see each other's
// state via globals (logs, telemetry, request ids). Promise.all gives
// you parallel execution; ALS gives you isolation.
//
// Usage: when GenerationAgent generates 8 shots, it fans out 8 teammate
// promises. Each one carries its own `ToolUseContext` (different agentId
// per teammate); shared parent context (brand, campaign) propagates.

export interface TeammateContext {
  readonly parent: ToolUseContext;
  readonly teammateId: string;
}

const teammateAls = new AsyncLocalStorage<TeammateContext>();

// Run a teammate task in an isolated ALS context. Returns the task's
// result. The body sees `getTeammateContext()` returning its own context.
export function runInProcessTeammate<T>(
  ctx: TeammateContext,
  task: () => Promise<T>,
): Promise<T> {
  return teammateAls.run(ctx, task);
}

export function getTeammateContext(): TeammateContext | undefined {
  return teammateAls.getStore();
}

// Convenience fan-out: each item gets its own ALS-isolated context, all
// run in parallel, results returned in input order.
export async function fanOutTeammates<TItem, TResult>(
  parent: ToolUseContext,
  items: readonly TItem[],
  taskFor: (item: TItem, idx: number) => Promise<TResult>,
  teammateIdFor: (item: TItem, idx: number) => string,
): Promise<readonly TResult[]> {
  return Promise.all(
    items.map((item, idx) =>
      runInProcessTeammate(
        { parent, teammateId: teammateIdFor(item, idx) },
        () => taskFor(item, idx),
      ),
    ),
  );
}
