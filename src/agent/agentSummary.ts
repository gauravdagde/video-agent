import { forkVideoSubagent, snapshotForFork } from "./forkVideoSubagent.ts";
import type { ContextBlock } from "../context/buildEditingAgentContext.ts";
import type { Tool, ToolUseContext } from "../Tool.ts";
import type { TaskRecord } from "../Task.ts";
import { isTerminalStatus, SUMMARY_INTERVAL_MS } from "../Task.ts";

// Plan §G — periodic forked summariser. Every ~30s while a task is
// running, fork a subagent that produces a 3-5 word present-tense label
// of what the agent is currently doing. Operators monitoring 200
// concurrent campaigns scan the labels rather than the raw recentActivities.
//
// The summariser is injectable: production passes the forkVideoSubagent-
// backed `buildForkedSummariser`; tests pass a fake. This keeps the
// scheduling logic testable without an API key.

const MAX_LABEL_CHARS = 80;

export type SummariserFn = () => Promise<string>;

export interface StartAgentSummaryOpts {
  readonly task: TaskRecord;
  readonly summarise: SummariserFn;
  readonly intervalMs?: number;
  // Logged but not thrown — failures shouldn't kill the agent loop.
  readonly onError?: (err: Error) => void;
}

export interface AgentSummaryHandle {
  stop(): void;
  // Test-only: fire one tick synchronously, bypassing the timer.
  _tickForTest(): Promise<void>;
}

export function startAgentSummary(
  opts: StartAgentSummaryOpts,
): AgentSummaryHandle {
  const intervalMs = opts.intervalMs ?? SUMMARY_INTERVAL_MS;
  let stopped = false;
  let timer: Timer | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (isTerminalStatus(opts.task.status)) {
      stopped = true;
      return;
    }
    try {
      const label = await opts.summarise();
      if (!stopped && !isTerminalStatus(opts.task.status)) {
        opts.task.summaryLabel = label.trim().slice(0, MAX_LABEL_CHARS);
        opts.task.summaryUpdatedAtMs = Date.now();
      }
    } catch (e) {
      opts.onError?.(e as Error);
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await tick();
      schedule();
    }, intervalMs);
  };

  schedule();

  return {
    stop(): void {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    async _tickForTest(): Promise<void> {
      await tick();
    },
  };
}

// Production summariser builder. Closes over the parent's context so the
// fork shares the prompt-cache prefix (system prompt + tool list); the
// fork's user message is just the recent-activity hint.
export interface BuildForkedSummariserOpts {
  readonly task: TaskRecord;
  readonly parentSystemBlocks: readonly ContextBlock[];
  readonly parentTools: readonly Tool[];
  readonly parentCtx: Pick<ToolUseContext, "brandId" | "campaignId">;
}

export function buildForkedSummariser(
  opts: BuildForkedSummariserOpts,
): SummariserFn {
  return async () => {
    const recent = opts.task.recentActivities
      .map((a) => a.tool)
      .join(", ");
    const promptHint =
      recent.length > 0
        ? `Recent tool calls (most recent last): ${recent}.`
        : `No tool calls observed yet — agent is in initial reasoning.`;
    const result = await forkVideoSubagent({
      parentCtx: opts.parentCtx,
      cacheSafe: snapshotForFork({}),
      role: "agent_summary",
      tools: opts.parentTools,
      systemBlocks: opts.parentSystemBlocks,
      initialMessage:
        `${promptHint}\n\n` +
        `Reply with a 3-5 word present-tense summary of what the agent ` +
        `is currently doing (e.g. "trimming hook scene", "rendering ` +
        `tiktok variant", "checking compliance"). No quotes, no period, ` +
        `no preamble — just the phrase.`,
    });
    return result.finalText;
  };
}
