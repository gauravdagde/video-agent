import type Anthropic from "@anthropic-ai/sdk";

type MessageParam = Anthropic.Messages.MessageParam;

// Plan §A — microCompact rewrites tool_result blocks for analysis tools
// once their work is captured downstream. After ExitPlanMode has been
// called, the EditPlan summarises everything VideoAnalyse / SceneDetect /
// TranscriptExtract produced — the raw outputs become dead weight in the
// transcript that just costs tokens on every cached turn.
//
// Idempotent: running twice has the same effect as running once. Safe to
// invoke at the end of every turn — we only rewrite blocks that haven't
// been rewritten yet.

const SUPERSEDED_BY_PLAN = new Set([
  "VideoAnalyse",
  "SceneDetect",
  "TranscriptExtract",
]);

const PLAN_TRIGGER_TOOL = "ExitPlanMode";

const REPLACEMENT_PREFIX = "[microCompacted by EditPlan: ";

export interface MicroCompactResult {
  readonly messages: readonly MessageParam[];
  readonly rewroteCount: number;
}

export function microCompact(
  messages: readonly MessageParam[],
): MicroCompactResult {
  // Cheap early exit — no plan has been submitted, nothing to compact.
  if (!hasExitPlanMode(messages)) {
    return { messages, rewroteCount: 0 };
  }

  const targetIds = collectTargetToolUseIds(messages);
  if (targetIds.size === 0) {
    return { messages, rewroteCount: 0 };
  }

  let rewroteCount = 0;
  const out: MessageParam[] = messages.map((m) => {
    if (m.role !== "user" || typeof m.content === "string") return m;
    if (!Array.isArray(m.content)) return m;

    let touched = false;
    const newContent = m.content.map((b) => {
      if (b.type !== "tool_result") return b;
      if (!targetIds.has(b.tool_use_id)) return b;
      // Already compacted — leave it. (Identifies via the prefix marker.)
      if (
        typeof b.content === "string" &&
        b.content.startsWith(REPLACEMENT_PREFIX)
      ) {
        return b;
      }
      rewroteCount++;
      touched = true;
      return {
        ...b,
        content: `${REPLACEMENT_PREFIX}see EditPlan in subsequent turns; raw analysis output dropped to save context]`,
      };
    });
    return touched ? { ...m, content: newContent } : m;
  });

  return { messages: out, rewroteCount };
}

function hasExitPlanMode(messages: readonly MessageParam[]): boolean {
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") continue;
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_use" && b.name === PLAN_TRIGGER_TOOL) return true;
    }
  }
  return false;
}

function collectTargetToolUseIds(
  messages: readonly MessageParam[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") continue;
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_use" && SUPERSEDED_BY_PLAN.has(b.name)) {
        ids.add(b.id);
      }
    }
  }
  return ids;
}
