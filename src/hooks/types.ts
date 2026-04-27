import type { ToolUseContext } from "../Tool.ts";

// Pattern 3 (plan §D) — PreToolUse and PostToolUse hooks.
// PreToolUse runs BEFORE the tool call. Can block.
// PostToolUse runs AFTER the tool call. Can block, modify the result the
// model sees, or escalate to the leader (Phase 2 — swarm bridge).
//
// Outcomes mirror Claude Code's hook semantics in claude-code-src/hooks/.
// `modify` is PostToolUse-only; rewrites the tool result before it lands
// in the model's message history (Claude Code's modify-and-pass-through).
//
// `escalate_to_leader` falls back to a deny in Phase 1 — Phase 2 plugs
// in utils/swarm/permissionSync.ts so the leader can auto-approve from a
// learned policy or surface to a human via WorkerBadge (§N).
export type HookDecision =
  | { readonly action: "continue" }
  | { readonly action: "block"; readonly reason: string }
  | {
      readonly action: "modify";
      readonly replacementResult: unknown;
      readonly note?: string;
    }
  | {
      readonly action: "escalate_to_leader";
      readonly reason: string;
      readonly data?: unknown;
    }
  // T3.5 — auto-fix can't be applied transparently (logo_position is the
  // current example: overlay-on-top leaves the wrong logo bleeding through,
  // so the right answer is to re-render with corrected EditPlan). The loop
  // surfaces this as a synthetic tool error so the agent re-renders with
  // the suggested adjustments.
  | {
      readonly action: "needs_rerender";
      readonly reason: string;
      readonly suggestedEditPlanDelta: unknown;
    };

export type PreToolUseHook = (
  toolName: string,
  input: unknown,
  ctx: ToolUseContext,
) => Promise<HookDecision>;

export type PostToolUseHook = (
  toolName: string,
  input: unknown,
  output: unknown,
  ctx: ToolUseContext,
) => Promise<HookDecision>;

export interface HookSet {
  readonly preToolUse?: Readonly<Record<string, PreToolUseHook>>;
  readonly postToolUse?: Readonly<Record<string, PostToolUseHook>>;
}
