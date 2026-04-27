import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  checkAutoCompact,
  performAutoCompact,
} from "../compact/autoCompact.ts";
import {
  DEFAULT_MODEL_CONTEXT_LIMIT,
  type CompactStrategy,
} from "../compact/CompactStrategy.ts";
import { microCompact } from "../compact/microCompact.ts";
import {
  reactiveCompact,
  reactiveCompactDefault,
  type ReactiveCompactOpts,
} from "../compact/reactiveCompact.ts";
import type { ContextBlock } from "../context/buildEditingAgentContext.ts";
import type {
  PermissionDecision,
} from "../permissions/canUseTool.ts";
import type { HookSet } from "../hooks/types.ts";
import { newPermissionRequestId } from "../swarm/PermissionRequest.ts";
import { permissionSync } from "../swarm/permissionSync.ts";
import type { Tool, ToolUseContext } from "../Tool.ts";
import { findToolByName } from "../Tool.ts";
import { buildToolSearchTool } from "./loopTools.ts";

type MessageParam = Anthropic.Messages.MessageParam;
type TextBlockParam = Anthropic.Messages.TextBlockParam;
type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;
type ToolUseBlock = Anthropic.Messages.ToolUseBlock;

export interface RunOpts {
  readonly model: string;
  readonly systemBlocks: readonly ContextBlock[];
  readonly tools: readonly Tool[];
  readonly initialMessage: string;
  readonly ctx: ToolUseContext;
  readonly canUseTool: (
    tool: Tool,
    input: unknown,
    ctx: ToolUseContext,
  ) => Promise<PermissionDecision>;
  readonly maxIterations?: number;
  readonly maxTokens?: number;
  readonly onToolCall?: (name: string, input: unknown) => void;
  // Fires AFTER PostToolUse hooks have decided to keep the result (continue
  // or modify). Receives the ORIGINAL output, not the modified one — hosts
  // care what the tool actually produced, not what the model sees.
  readonly onToolSuccess?: (
    name: string,
    input: unknown,
    output: unknown,
  ) => void;
  readonly onToolError?: (name: string, error: string) => void;
  // UI hooks — fired around the per-turn API call. Lets a renderer show
  // a "thinking" spinner while the model is generating.
  readonly onTurnStart?: (turn: number) => void;
  readonly onTurnEnd?: (
    turn: number,
    info: {
      readonly stopReason: string | null;
      readonly textPreview: string;
      readonly toolCallCount: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens: number;
      readonly cacheCreationTokens: number;
    },
  ) => void;
  readonly client?: Anthropic;
  // §A — pass the compaction strategy. Required field at the loop level;
  // even a stub strategy is checked at each turn boundary.
  readonly compactStrategy: CompactStrategy;
  readonly modelContextLimit?: number;
  // §D — pre/post tool-use hook registries. Keyed by tool name.
  readonly hooks?: HookSet;
  // Caller-supplied loop tools. The loop already injects ToolSearch (§E);
  // callers pass agent-specific control-plane tools here (e.g. EditingAgent
  // injects ExitPlanMode). Loop tools are never persisted in the registry.
  readonly extraLoopTools?: readonly Tool[];
  // §A — reactiveCompact config. Default caps each tool result at 50 KB
  // and preserves load-bearing fields (duration_ms, resolution, etc.).
  readonly reactiveCompactOpts?: ReactiveCompactOpts;
}

export interface RunResult {
  readonly finalText: string;
  readonly iterations: number;
  readonly totalUsage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_creation_input_tokens: number;
    readonly cache_read_input_tokens: number;
  };
  readonly toolCallsByName: Readonly<Record<string, number>>;
}

const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_MAX_TOKENS = 4096;

export async function runAgentLoop(opts: RunOpts): Promise<RunResult> {
  const client = opts.client ?? new Anthropic();
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  const systemParams = buildSystemParams(opts.systemBlocks);

  // §E — ToolSearch lives at the loop level. `discovery.discovered` grows
  // as the model searches; we rebuild the tools array each turn so newly
  // discovered tools appear (and previously hidden deferred ones stay
  // hidden).
  const discovery = { discovered: new Set<string>() };
  const toolSearch = buildToolSearchTool(opts.tools, discovery);

  // ToolSearch is always present; agent-specific loop tools (e.g.
  // ExitPlanMode for EditingAgent) come in via opts.extraLoopTools.
  const loopTools: readonly Tool[] = [
    toolSearch,
    ...(opts.extraLoopTools ?? []),
  ];

  // §A — `messages` is mutated in place by autoCompact (rewriting old
  // turns into a boundary message) and microCompact (rewriting tool_result
  // blocks for analysis tools after EditPlan submission). Hence `let`.
  let messages: MessageParam[] = [
    { role: "user", content: opts.initialMessage },
  ];
  const reactiveOpts = opts.reactiveCompactOpts ?? reactiveCompactDefault;

  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const toolCallsByName: Record<string, number> = {};

  for (let iter = 1; iter <= maxIterations; iter++) {
    // Rebuild per-turn: always-load tools + ToolSearch + any deferred tools
    // discovered so far. Prefix is stable until a new discovery, so
    // post-discovery turns share a cache prefix.
    const turnTools = assembleTurnTools(opts.tools, loopTools, discovery);

    opts.onTurnStart?.(iter);
    const response = await client.messages.create({
      model: opts.model,
      max_tokens: maxTokens,
      system: systemParams,
      tools: buildToolParams(turnTools),
      messages,
    });
    opts.onTurnEnd?.(iter, {
      stopReason: response.stop_reason,
      textPreview: extractText(response.content).slice(0, 200),
      toolCallCount: response.content.filter((b) => b.type === "tool_use")
        .length,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    });

    usage.input_tokens += response.usage.input_tokens;
    usage.output_tokens += response.usage.output_tokens;
    usage.cache_creation_input_tokens +=
      response.usage.cache_creation_input_tokens ?? 0;
    usage.cache_read_input_tokens +=
      response.usage.cache_read_input_tokens ?? 0;

    // §A — turn-boundary compaction. Order matters:
    //   1. Check whether we're past the autoCompact trigger; if so,
    //      rewrite older messages into a single boundary message.
    //   2. Run microCompact — idempotent, replaces dead-weight analysis
    //      tool_result blocks with a one-liner once an EditPlan exists.
    // Both run AFTER the assistant turn has been appended (later in the
    // iteration). The trigger we check here is on the response we just got
    // — if input_tokens is already above the budget, we want the NEXT API
    // call to use compacted messages.
    const limit = opts.modelContextLimit ?? DEFAULT_MODEL_CONTEXT_LIMIT;
    const compactResult = await checkAutoCompact(
      {
        modelContextLimit: limit,
        lastInputTokens: response.usage.input_tokens,
        remainingTokens: limit - response.usage.input_tokens,
        turnIndex: iter,
      },
      opts.compactStrategy,
      (s) => {
        if (process.env.VIDEO_AGENT_VERBOSE === "1") {
          console.warn(
            `[autoCompact] WARNING — ${s.remainingTokens} tokens remain (warning buffer ${s.bufferTokens})`,
          );
        }
      },
    );

    if (
      response.stop_reason === "end_turn" ||
      response.stop_reason === "stop_sequence"
    ) {
      return {
        finalText: extractText(response.content),
        iterations: iter,
        totalUsage: usage,
        toolCallsByName,
      };
    }

    if (response.stop_reason === "max_tokens") {
      throw new Error(
        `runAgentLoop: model hit max_tokens at iteration ${iter}`,
      );
    }

    if (response.stop_reason !== "tool_use") {
      throw new Error(
        `runAgentLoop: unexpected stop_reason ${response.stop_reason}`,
      );
    }

    // Echo assistant turn back into history.
    messages.push({ role: "assistant", content: response.content });

    // Dispatch every tool_use block in the assistant turn.
    const toolResults: ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const result = await dispatchOne(
        block,
        turnTools,
        opts.ctx,
        opts.canUseTool,
        opts.hooks,
        opts.onToolCall,
        opts.onToolSuccess,
        reactiveOpts,
      );
      // Surface tool failures (is_error true) to the UI hook so the
      // renderer can show ✗ instead of ✓.
      if (
        result.is_error === true &&
        opts.onToolError !== undefined &&
        typeof result.content === "string"
      ) {
        opts.onToolError(block.name, result.content);
      }
      toolResults.push(result);
      toolCallsByName[block.name] = (toolCallsByName[block.name] ?? 0) + 1;
    }
    messages.push({ role: "user", content: toolResults });

    // §A — end-of-turn compaction. autoCompact rewrites old turns first
    // (so microCompact's pattern matching runs against the smaller array);
    // microCompact then drops any superseded analysis blocks.
    if (compactResult.signal.kind === "trigger") {
      const r = await performAutoCompact(messages, opts.compactStrategy);
      if (r.compacted) {
        messages = [...r.messages];
        console.warn(
          `[autoCompact] rewrote — dropped ${r.droppedCount} earlier message(s)`,
        );
      }
    }
    const micro = microCompact(messages);
    if (micro.rewroteCount > 0) {
      messages = [...micro.messages];
    }
  }

  throw new Error(
    `runAgentLoop: exceeded ${maxIterations} iterations without end_turn`,
  );
}

async function dispatchOne(
  block: ToolUseBlock,
  tools: readonly Tool[],
  ctx: ToolUseContext,
  permission: RunOpts["canUseTool"],
  hooks: HookSet | undefined,
  onToolCall: RunOpts["onToolCall"],
  onToolSuccess: RunOpts["onToolSuccess"],
  reactiveOpts: ReactiveCompactOpts,
): Promise<ToolResultBlockParam> {
  const tool = findToolByName(tools, block.name);
  if (!tool) {
    return errResult(block.id, `unknown tool: ${block.name}`);
  }

  onToolCall?.(block.name, block.input);

  const decision = await permission(tool, block.input, ctx);
  if (decision.action === "deny") {
    return errResult(block.id, `permission deny: ${decision.reason}`);
  }
  if (decision.action === "needs_leader") {
    // T3.3 — Tier 3 escalations route through the swarm bridge. The
    // default leader handler approves; orchestrator coordinator-mode
    // (T5.1) can swap in a brand-policy classifier + human review.
    const resp = await permissionSync.forwardToLeader({
      id: newPermissionRequestId(),
      fromAgentId: ctx.agentId,
      brandId: ctx.brandId,
      campaignId: ctx.campaignId,
      toolName: block.name,
      input: block.input,
      reason: decision.reason,
      hookKind: "permission_classifier",
    });
    if (!resp.allowed) {
      return errResult(block.id, `leader denied: ${resp.reason}`);
    }
    // Approved — fall through.
  }

  // §D — PreToolUse hook. Runs after canUseTool, before validateInput/call.
  // Can block (Claude Code semantics: synchronous block before the tool runs).
  const preHook = hooks?.preToolUse?.[block.name];
  if (preHook) {
    const d = await preHook(block.name, block.input, ctx);
    if (d.action === "block") {
      return errResult(block.id, `pre-tool-use blocked: ${d.reason}`);
    }
    if (d.action === "escalate_to_leader") {
      // §N — route to the swarm permission bus. Default leader handler
      // auto-approves; orchestrator coordinator-mode (T5.1) replaces it
      // with a queueing handler that the orchestrator agent polls.
      const resp = await permissionSync.forwardToLeader({
        id: newPermissionRequestId(),
        fromAgentId: ctx.agentId,
        brandId: ctx.brandId,
        campaignId: ctx.campaignId,
        toolName: block.name,
        input: block.input,
        reason: d.reason,
        data: d.data,
        hookKind: "pre_tool_use",
      });
      if (!resp.allowed) {
        return errResult(block.id, `leader denied: ${resp.reason}`);
      }
      // Approved — fall through to validateInput/call.
    }
    // continue / modify (modify is a no-op here — PreToolUse has no result)
  }

  let validated: unknown;
  try {
    validated = tool.validateInput(block.input);
  } catch (e) {
    return errResult(block.id, `validateInput: ${(e as Error).message}`);
  }

  let result: Awaited<ReturnType<Tool["call"]>>;
  try {
    result = await tool.call(validated, ctx);
  } catch (e) {
    return errResult(block.id, (e as Error).message);
  }
  if (!result.ok) {
    return errResult(block.id, result.error);
  }

  // §D — PostToolUse hook. Runs on the unmodified output. May block,
  // modify (rewrite the result the model sees), or escalate.
  // Default content is the tool's multipart blocks if present (e.g.
  // ExtractFrames returns inline image blocks), otherwise JSON-stringified
  // output run through reactiveCompact (§A) — caps any single tool result
  // before it enters the message history.
  let resultContent: ToolResultBlockParam["content"];
  if (result.multipart !== undefined) {
    resultContent = [...result.multipart];
  } else {
    const compacted = await reactiveCompact(result.output, reactiveOpts);
    resultContent = compacted.content;
  }

  const postHook = hooks?.postToolUse?.[block.name];
  if (postHook) {
    const d = await postHook(block.name, block.input, result.output, ctx);
    if (d.action === "block") {
      return errResult(block.id, `post-tool-use blocked: ${d.reason}`);
    }
    if (d.action === "escalate_to_leader") {
      // §N — same swarm bridge as PreToolUse. Difference: PostToolUse
      // also forwards `output` so the leader sees what was produced.
      const resp = await permissionSync.forwardToLeader({
        id: newPermissionRequestId(),
        fromAgentId: ctx.agentId,
        brandId: ctx.brandId,
        campaignId: ctx.campaignId,
        toolName: block.name,
        input: block.input,
        output: result.output,
        reason: d.reason,
        data: d.data,
        hookKind: "post_tool_use",
      });
      if (!resp.allowed) {
        return errResult(block.id, `leader denied: ${resp.reason}`);
      }
      // Approved — fall through; result keeps its original `resultContent`.
    }
    if (d.action === "needs_rerender") {
      // T3.5 — surface as a synthetic tool error so the agent retries with
      // the suggested adjustments. The render that just happened is NOT
      // accepted — the model should treat its output as discarded and
      // re-issue RenderVariant with corrected upstream tool calls
      // (typically OverlayAsset with new logo positions).
      return errResult(
        block.id,
        `render rejected by compliance: ${d.reason}\n` +
          `Suggested EditPlan adjustments: ${JSON.stringify(d.suggestedEditPlanDelta)}\n` +
          `Re-issue RenderVariant after rerunning the upstream OverlayAsset / TrimClip steps with the corrected positions.`,
      );
    }
    if (d.action === "modify") {
      // Modify always replaces with JSON content — multipart isn't intended
      // for hook output. If a hook needs multipart, use a different action.
      resultContent = JSON.stringify(d.replacementResult);
    }
  }

  // Result is being kept (continue or modify). Notify the host so it can
  // record the original output. Fired with the ORIGINAL — modify-pass-
  // through is for the model's view, not the host's.
  onToolSuccess?.(block.name, block.input, result.output);

  return {
    type: "tool_result",
    tool_use_id: block.id,
    content: resultContent,
  };
}

function errResult(id: string, msg: string): ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: id,
    content: msg,
    is_error: true,
  };
}

// Plan §I — apply cache_control to the LAST stable block. Everything before
// it is implicitly cached up to that breakpoint. Dynamic blocks come after
// and are not cached.
function buildSystemParams(blocks: readonly ContextBlock[]): TextBlockParam[] {
  const lastStableIdx = lastIndexOf(blocks, (b) => b.kind === "stable");
  return blocks.map((b, i): TextBlockParam => {
    const base: TextBlockParam = { type: "text", text: b.content };
    if (i === lastStableIdx) {
      return { ...base, cache_control: { type: "ephemeral" } };
    }
    return base;
  });
}

function buildToolParams(
  tools: readonly Tool[],
): Anthropic.Messages.Tool[] {
  return tools.map((t): Anthropic.Messages.Tool => {
    // Anthropic requires JSON Schema draft 2020-12. zod-to-json-schema's
    // "openApi3" target uses OpenAPI 3.0 dialect (exclusiveMinimum:
    // boolean, nullable:true) which is rejected. Default jsonSchema7
    // target is broadly compatible with 2020-12 for the constructs we use.
    // $refStrategy:"none" inlines definitions so the schema is flat at
    // input_schema rather than wrapped in {$ref, definitions}.
    const schema = zodToJsonSchema(t.inputSchema, {
      $refStrategy: "none",
    }) as Record<string, unknown>;
    // Strip top-level $schema if present (zod-to-json-schema adds it).
    delete schema.$schema;
    return {
      name: t.name,
      description: t.description,
      input_schema: schema as Anthropic.Messages.Tool["input_schema"],
    };
  });
}

function extractText(
  content: Anthropic.Messages.ContentBlock[],
): string {
  return content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function lastIndexOf<T>(arr: readonly T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i]!)) return i;
  }
  return -1;
}

// §E — Per-turn tool list. Always-load + loop tools + post-discovery deferred.
// The same registry input always produces the same output for the same
// discovered set, so cache prefixes line up across turns of equal discovery.
function assembleTurnTools(
  registry: readonly Tool[],
  loopTools: readonly Tool[],
  discovery: { discovered: Set<string> },
): readonly Tool[] {
  const turnTools: Tool[] = [];
  for (const t of registry) {
    if (t.alwaysLoad || !t.shouldDefer) turnTools.push(t);
    else if (discovery.discovered.has(t.name)) turnTools.push(t);
  }
  for (const t of loopTools) turnTools.push(t);
  return turnTools;
}
