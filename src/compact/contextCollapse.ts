import type Anthropic from "@anthropic-ai/sdk";

type MessageParam = Anthropic.Messages.MessageParam;

// Plan §O / T5.3 — contextCollapse rewrites whole subtrees of completed
// work into denser representations. Different from compact:
//   - autoCompact (§A) summarises older tool-result blocks within a
//     single agent's transcript at the turn boundary.
//   - contextCollapse rewrites the transcript itself by collapsing
//     completed subtrees — e.g. "edited 18 variants for spec batch A,
//     all delivered, all metrics nominal" replaces 18 detailed child-
//     agent transcripts.
//
// Used by long-running coordinator-mode sessions (T5.1) where many child
// agents have completed and their full transcripts are dead weight.
//
// FEATURE-GATED: off by default. Hosts opt in via `useContextCollapse: true`
// in the orchestrator config. Phase-1 default is OFF — Phase-1 campaigns
// don't run long enough for the Orchestrator's transcript to bloat.

export interface CompletedSubtree {
  // Range of message indices this subtree covers (inclusive start, exclusive end).
  readonly start: number;
  readonly end: number;
  // Pre-computed dense summary the collapse replaces them with.
  readonly summary: string;
}

export interface CollapseOpts {
  readonly enabled: boolean;
  readonly identifySubtrees: (
    messages: readonly MessageParam[],
  ) => readonly CompletedSubtree[];
}

export interface CollapseResult {
  readonly messages: readonly MessageParam[];
  readonly collapsed: number;
  readonly droppedCount: number;
}

export async function collapseContext(
  messages: readonly MessageParam[],
  opts: CollapseOpts,
): Promise<CollapseResult> {
  if (!opts.enabled) {
    return { messages, collapsed: 0, droppedCount: 0 };
  }
  const subtrees = opts.identifySubtrees(messages);
  if (subtrees.length === 0) {
    return { messages, collapsed: 0, droppedCount: 0 };
  }

  // Apply collapses from the END of the array first so earlier indices
  // remain valid while we rewrite. Subtrees must be non-overlapping.
  const sorted = [...subtrees].sort((a, b) => b.start - a.start);
  let out = [...messages];
  let droppedCount = 0;
  for (const s of sorted) {
    const placeholder: MessageParam = {
      role: "user",
      content: `<collapsed-subtree>\n${s.summary}\n</collapsed-subtree>`,
    };
    droppedCount += s.end - s.start;
    out = [...out.slice(0, s.start), placeholder, ...out.slice(s.end)];
  }
  return { messages: out, collapsed: sorted.length, droppedCount };
}
