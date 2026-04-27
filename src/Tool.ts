// Tool interface — mirrors claude-code-src/Tool.ts.
// Three knobs from §E (token economics) are first-class:
//   shouldDefer  — true means schema is hidden behind ToolSearch on turn 1.
//   alwaysLoad   — true means schema is in every cached turn (worth it for
//                  tools the model needs visible immediately, e.g. polling).
//   searchHint   — keywords ToolSearch matches when the model asks for it.
import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";

export type ToolUseContext = {
  readonly agentId: string;
  readonly brandId: string;
  readonly campaignId: string;
  // Optional — populated by spawnEditingAgent when the run is scoped to a
  // single asset. Compliance / Performance / Generation agents may run
  // unscoped.
  readonly assetId?: string;
  readonly abortSignal: AbortSignal;
};

// What ends up inside a tool_result block. By default the loop JSON-strings
// `output`. A tool that needs to surface images (ExtractFrames) sets
// `multipart` — those blocks land verbatim in the tool_result the model sees.
export type ToolResultContent =
  | Anthropic.Messages.TextBlockParam
  | Anthropic.Messages.ImageBlockParam;

export type ToolResult<TOutput> =
  | {
      ok: true;
      output: TOutput;
      tokens?: number;
      multipart?: readonly ToolResultContent[];
    }
  | { ok: false; error: string; retryable: boolean };

export interface Tool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  // The schema parses untyped input into TInput. Using `any` for the input
  // side of the zod type is deliberate — schemas with .default() / .optional()
  // have a parse-input shape that differs from the parsed output, and we
  // care about the output (TInput).
  readonly inputSchema: z.ZodType<TInput, z.ZodTypeDef, any>;

  // §E — load policy
  readonly shouldDefer: boolean;
  readonly alwaysLoad: boolean;
  readonly searchHint?: string;

  // §A — when this tool's recent output is safe to microCompact.
  readonly microCompactable: boolean;

  // Permission hint — actual gate is canUseTool (Tier 1/2/3 in plan §4).
  readonly readonly: boolean;

  validateInput(input: unknown): TInput;
  call(input: TInput, ctx: ToolUseContext): Promise<ToolResult<TOutput>>;
}

// Helper for the registry — Claude Code's tools.ts equivalent.
export function findToolByName<T extends Tool>(
  tools: readonly T[],
  name: string,
): T | undefined {
  return tools.find((t) => t.name === name);
}

// §E — what we send to the model on turn 1.
export function loadedToolsForTurn1<T extends Tool>(
  tools: readonly T[],
): readonly T[] {
  return tools.filter((t) => t.alwaysLoad || !t.shouldDefer);
}

// §E — pool that ToolSearch resolves against.
export function deferredTools<T extends Tool>(
  tools: readonly T[],
): readonly T[] {
  return tools.filter((t) => t.shouldDefer);
}
