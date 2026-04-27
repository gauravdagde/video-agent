// Plan §A — three flavours of compaction. autoCompact (token-budget triggered)
// is the Week-1 stub here. microCompact (in-place truncation of superseded
// tool results) and reactiveCompact (per-result size cap) land later.
//
// §A v3 — Claude Code uses TOKEN BUFFERS, not percent thresholds. The
// trigger fires when remaining tokens drop below `autoCompactBufferTokens`.
// 13_000 mirrors AUTOCOMPACT_BUFFER_TOKENS in services/compact/autoCompact.ts.

export interface CompactStrategy {
  readonly autoCompactBufferTokens: number;
  readonly warningBufferTokens: number;
  readonly preserveLatestNTurns: number;
}

export interface CompactState {
  readonly modelContextLimit: number;
  readonly lastInputTokens: number;
  readonly remainingTokens: number;
  readonly turnIndex: number;
}

export const editingAgentCompactStrategy: CompactStrategy = {
  autoCompactBufferTokens: 13_000,
  warningBufferTokens: 25_000,
  preserveLatestNTurns: 3,
};

export const DEFAULT_MODEL_CONTEXT_LIMIT = 200_000;

export type CompactSignal =
  | { kind: "ok" }
  | { kind: "warning"; remainingTokens: number; bufferTokens: number }
  | { kind: "trigger"; remainingTokens: number; bufferTokens: number };

export function classify(
  state: CompactState,
  strategy: CompactStrategy,
): CompactSignal {
  if (state.remainingTokens < strategy.autoCompactBufferTokens) {
    return {
      kind: "trigger",
      remainingTokens: state.remainingTokens,
      bufferTokens: strategy.autoCompactBufferTokens,
    };
  }
  if (state.remainingTokens < strategy.warningBufferTokens) {
    return {
      kind: "warning",
      remainingTokens: state.remainingTokens,
      bufferTokens: strategy.warningBufferTokens,
    };
  }
  return { kind: "ok" };
}
