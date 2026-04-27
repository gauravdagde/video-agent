import type Anthropic from "@anthropic-ai/sdk";
import {
  classify,
  type CompactSignal,
  type CompactState,
  type CompactStrategy,
} from "./CompactStrategy.ts";

type MessageParam = Anthropic.Messages.MessageParam;

// Plan §A — autoCompact has two halves:
//   `checkAutoCompact`     — classify the current state; emit warning /
//                            trigger / ok signals.
//   `performAutoCompact`   — rewrite the message array when a trigger
//                            fires: keep the last N turns verbatim, replace
//                            everything older with a single boundary
//                            message containing a summary of the prior
//                            context.
//
// The summariser is injectable: production passes a forkVideoSubagent
// (T0.1) backed summariser; tests and Phase-1 default fall back to a
// drop-with-marker boundary. Either way the cache prefix shrinks enough
// that the next turn fits.

export interface AutoCompactResult {
  readonly signal: CompactSignal;
}

export async function checkAutoCompact(
  state: CompactState,
  strategy: CompactStrategy,
  onWarning?: (s: Extract<CompactSignal, { kind: "warning" }>) => void,
  onTrigger?: (s: Extract<CompactSignal, { kind: "trigger" }>) => void,
): Promise<AutoCompactResult> {
  const signal = classify(state, strategy);
  if (signal.kind === "warning") onWarning?.(signal);
  if (signal.kind === "trigger") onTrigger?.(signal);
  return { signal };
}

export interface PerformAutoCompactOpts {
  readonly summarise?: (
    older: readonly MessageParam[],
  ) => Promise<string>;
}

export interface PerformAutoCompactResult {
  readonly messages: readonly MessageParam[];
  readonly compacted: boolean;
  readonly droppedCount: number;
}

export async function performAutoCompact(
  messages: readonly MessageParam[],
  strategy: CompactStrategy,
  opts: PerformAutoCompactOpts = {},
): Promise<PerformAutoCompactResult> {
  // Each "turn" in our loop produces 2 messages: the assistant turn, and
  // the user turn carrying tool_results. Keep the last 2N intact.
  const preserveCount = strategy.preserveLatestNTurns * 2;
  // Need enough older messages to make the compaction worth it.
  if (messages.length <= preserveCount + 1) {
    return { messages, compacted: false, droppedCount: 0 };
  }

  const older = messages.slice(0, messages.length - preserveCount);
  const recent = messages.slice(messages.length - preserveCount);

  const summary = opts.summarise
    ? await opts.summarise(older)
    : `[autoCompacted: ${older.length} earlier message(s) dropped to free context. ` +
      `Summariser not configured — recent ${preserveCount} message(s) preserved verbatim.]`;

  const boundary: MessageParam = {
    role: "user",
    content: `<previous-context-summary>\n${summary}\n</previous-context-summary>`,
  };

  return {
    messages: [boundary, ...recent],
    compacted: true,
    droppedCount: older.length,
  };
}
