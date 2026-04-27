import type Anthropic from "@anthropic-ai/sdk";
import type { CompactStrategy } from "../compact/CompactStrategy.ts";
import { editingAgentCompactStrategy } from "../compact/CompactStrategy.ts";
import type { ContextBlock } from "../context/buildEditingAgentContext.ts";
import type { PermissionDecision } from "../permissions/canUseTool.ts";
import type { Tool, ToolUseContext } from "../Tool.ts";
import { newAgentId } from "../types/ids.ts";
import { runAgentLoop, type RunResult } from "./runAgentLoop.ts";

// Plan §M — state isolation for forked subagents.
//
// FileStateCache:        per-session record of file reads (path → mtime).
//                        Forks see a CLONE — reads observed in the fork
//                        don't leak back, and parent's "read before edit"
//                        guard isn't confused.
// DenialTrackingState:   past permission denials. Forks inherit a
//                        SNAPSHOT (read-only) so they don't re-prompt for
//                        things already denied; cannot append.
// ContentReplacementState: queued text replacements. Snapshot-only.
//
// We don't yet have parent code that USES these structures (no read-mtime
// guard exists, no denial tracking, no content replacement). The shapes
// are deliberately built up-front so the §M discipline is in place
// before the consumers (AgentSummary, MagicDocs, SessionMemory,
// PerformanceAgent, insight extraction, compact summariser) land.

export class FileStateCache {
  private readonly state = new Map<string, number>();

  recordRead(path: string, mtime: number): void {
    this.state.set(path, mtime);
  }

  getRead(path: string): number | undefined {
    return this.state.get(path);
  }

  // §M — the load-bearing call. Fork sees a copy; mutations don't propagate.
  clone(): FileStateCache {
    const c = new FileStateCache();
    for (const [k, v] of this.state) c.state.set(k, v);
    return c;
  }

  get size(): number {
    return this.state.size;
  }
}

export interface DenialTrackingSnapshot {
  has(toolName: string, inputHash: string): boolean;
  readonly size: number;
}

export class DenialTrackingState {
  private readonly denials = new Set<string>();

  record(toolName: string, inputHash: string): void {
    this.denials.add(`${toolName}:${inputHash}`);
  }

  has(toolName: string, inputHash: string): boolean {
    return this.denials.has(`${toolName}:${inputHash}`);
  }

  // §M — fork gets a read-only snapshot frozen at this moment.
  snapshot(): DenialTrackingSnapshot {
    const captured = new Set(this.denials);
    return {
      has(toolName: string, inputHash: string): boolean {
        return captured.has(`${toolName}:${inputHash}`);
      },
      get size(): number {
        return captured.size;
      },
    };
  }
}

export interface ContentReplacementSnapshot {
  pending(): readonly { from: string; to: string }[];
}

export class ContentReplacementState {
  private readonly queue: { from: string; to: string }[] = [];

  enqueue(from: string, to: string): void {
    this.queue.push({ from, to });
  }

  // §M — fork gets a read-only snapshot.
  snapshot(): ContentReplacementSnapshot {
    const frozen = [...this.queue];
    return {
      pending(): readonly { from: string; to: string }[] {
        return frozen;
      },
    };
  }
}

// What the fork inherits. Cloned/snapshotted from the parent's state.
export interface CacheSafeParams {
  readonly fileStateCache: FileStateCache;
  readonly denialTracking: DenialTrackingSnapshot;
  readonly contentReplacement: ContentReplacementSnapshot;
}

// Build CacheSafeParams from a parent's live state objects (any of which
// may be missing — the system isn't required to track every kind yet).
// All four pieces — these three plus the parent's tool list — together
// satisfy §M's "fork shares the parent's prompt-cache key without
// observable state coupling."
export function snapshotForFork(
  parent: {
    fileStateCache?: FileStateCache;
    denialTracking?: DenialTrackingState;
    contentReplacement?: ContentReplacementState;
  },
): CacheSafeParams {
  return {
    fileStateCache: parent.fileStateCache?.clone() ?? new FileStateCache(),
    denialTracking:
      parent.denialTracking?.snapshot() ??
      new DenialTrackingState().snapshot(),
    contentReplacement:
      parent.contentReplacement?.snapshot() ??
      new ContentReplacementState().snapshot(),
  };
}

// Common canUseTool wrapper for read-only forks (AgentSummary, MagicDocs,
// SessionMemory, PerformanceAgent insight extraction, etc.). Tools stay in
// the list for cache-key match; restriction is enforced here.
export const denyNonReadonly: (
  tool: Tool,
  input: unknown,
  ctx: ToolUseContext,
) => Promise<PermissionDecision> = async (tool) => {
  if (tool.readonly) {
    return { action: "allow", reason: "fork: readonly tool" };
  }
  return {
    action: "deny",
    reason: "fork: non-readonly tools denied (CacheSafeParams)",
  };
};

// Telemetry/audit role discriminator. Not load-bearing for permissions —
// just labels the fork in logs and AgentIds.
export type ForkRole =
  | "agent_summary"
  | "magic_docs_update"
  | "session_memory"
  | "performance_agent"
  | "insight_extraction"
  | "compact_summariser";

export interface ForkOpts {
  readonly parentCtx: Pick<ToolUseContext, "brandId" | "campaignId">;
  readonly cacheSafe: CacheSafeParams;
  readonly role: ForkRole;
  // SAME list as parent — the cache-key constraint. Restriction goes
  // through canUseTool, not by removing tools.
  readonly tools: readonly Tool[];
  readonly canUseTool?: (
    tool: Tool,
    input: unknown,
    ctx: ToolUseContext,
  ) => Promise<PermissionDecision>;
  readonly systemBlocks: readonly ContextBlock[];
  readonly initialMessage: string;
  readonly model?: string;
  readonly compactStrategy?: CompactStrategy;
  readonly client?: Anthropic;
}

export interface ForkResult extends RunResult {
  readonly role: ForkRole;
  readonly forkAgentId: string;
}

const DEFAULT_MODEL = process.env.MODEL ?? "claude-opus-4-7";

// Spawn a forked subagent with cache-safe state isolation. This is the
// single helper every forked feature in the system uses:
// AgentSummary (T1.1), MagicDocs (T1.3), SessionMemory (T1.2),
// PerformanceAgent (T2.4), insight extraction (T2.3), and the
// autoCompact summariser (T0.2).
//
// Why centralise: each forked feature would otherwise reinvent the
// isolation discipline; getting it wrong corrupts parent state, busts
// the prompt-cache prefix on every fork, or both.
export async function forkVideoSubagent(opts: ForkOpts): Promise<ForkResult> {
  const forkAgentId = newAgentId(opts.role);
  const abort = new AbortController();
  const ctx: ToolUseContext = {
    agentId: forkAgentId,
    brandId: opts.parentCtx.brandId,
    campaignId: opts.parentCtx.campaignId,
    abortSignal: abort.signal,
  };

  const run = await runAgentLoop({
    model: opts.model ?? DEFAULT_MODEL,
    systemBlocks: opts.systemBlocks,
    tools: opts.tools,
    initialMessage: opts.initialMessage,
    ctx,
    canUseTool: opts.canUseTool ?? denyNonReadonly,
    compactStrategy: opts.compactStrategy ?? editingAgentCompactStrategy,
    ...(opts.client !== undefined ? { client: opts.client } : {}),
  });

  return { ...run, role: opts.role, forkAgentId };
}
