import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages.mjs";
import {
  DEFAULT_MODEL_CONTEXT_LIMIT,
  editingAgentCompactStrategy,
} from "../compact/CompactStrategy.ts";
import {
  reactiveCompactDefault,
  type ReactiveCompactOpts,
} from "../compact/reactiveCompact.ts";
import { buildEditingAgentContext } from "../context/buildEditingAgentContext.ts";
import { extractCreativeInsights } from "../hooks/extractCreativeInsights.ts";
import {
  buildOnRenderComplete,
  type ComplianceCheckFn,
} from "../hooks/onRenderComplete.ts";
import { preDeliverToAdPlatform } from "../hooks/preDeliverToAdPlatform.ts";
import type { HookSet } from "../hooks/types.ts";
import { canUseTool } from "../permissions/canUseTool.ts";
import { runComplianceCheck } from "../compliance/runComplianceCheck.ts";
import {
  recordEditPlans,
  recordVariantBatch,
} from "../storage/recorder.ts";
import { editingAgentTools } from "../tools/registry.ts";
import type { Tool, ToolUseContext } from "../Tool.ts";
import {
  newAgentId,
  newJobId,
  type AgentId,
} from "../types/ids.ts";
import type {
  EditPlan,
  RenderedVariant,
  VariantBatch,
} from "../types/video.ts";
import { agentActivity } from "../ui/agentActivity.ts";
import type { CliRenderer } from "../ui/cli.ts";
import {
  buildEnterPlanModeTool,
  buildExitPlanModeTool,
  buildToolSearchTool,
  defaultPlanApprover,
  type PlanApprovalState,
  type PlanApprover,
  type ToolDiscovery,
} from "../agent/loopTools.ts";
import {
  buildSystemParams,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_TOKENS,
  runOneTurnCycle,
  type TurnCycleOpts,
  type TurnState,
} from "../agent/runAgentLoop.ts";

// Conversation — chat-mode state holder. Wraps the same per-turn primitives
// `runAgentLoop` uses, but the state (messages, discovery, planApproval,
// usage, accumulated variants) lives on the instance and persists across
// `sendUserMessage` calls.
//
// One Conversation per chat session. Brand / campaign / asset are fixed
// for the session — switching brand mid-chat would mean rebuilding the
// system context, which we don't support in v1.

const DEFAULT_MODEL = process.env.MODEL ?? "claude-opus-4-7";

export interface ConversationOpts {
  readonly brandId: string;
  readonly campaignId: string;
  readonly assetId: string;
  readonly approvePlans?: PlanApprover;
  readonly compliance?: ComplianceCheckFn;
  readonly ui?: CliRenderer;
  readonly client?: Anthropic;
  readonly model?: string;
  readonly maxIterations?: number;
  readonly maxTokens?: number;
}

export interface TurnResult {
  readonly finalText: string;
  readonly iterations: number;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_creation_input_tokens: number;
    readonly cache_read_input_tokens: number;
  };
  readonly toolCallsThisMessage: Readonly<Record<string, number>>;
  // True iff the turn was cancelled via cancel(). The conversation is
  // still in a valid state and can accept the next user message.
  readonly aborted: boolean;
  // Set when this message produced new renders that were flushed to disk.
  readonly persisted?: {
    readonly editPlanFiles: readonly string[];
    readonly batchFile: string;
    readonly variantFiles: readonly string[];
  };
}

export interface Snapshot {
  readonly messages: number;
  readonly toolCalls: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheCreation: number;
  };
  readonly approvedPlans: number;
  readonly renderedVariants: number;
}

export class Conversation {
  private readonly opts: ConversationOpts;
  private readonly agentId: AgentId;
  private readonly tools: readonly Tool[];
  private readonly loopTools: readonly Tool[];
  private readonly systemParams: ReturnType<typeof buildSystemParams>;
  private readonly hooks: HookSet;
  private readonly compactStrategy = editingAgentCompactStrategy;
  private readonly modelContextLimit = DEFAULT_MODEL_CONTEXT_LIMIT;
  private readonly reactiveOpts: ReactiveCompactOpts = reactiveCompactDefault;
  private readonly client: Anthropic;
  private readonly maxIterations: number;
  private readonly maxTokens: number;

  // Mutable session state — survives across `sendUserMessage` calls.
  private state: TurnState;
  private readonly planApproval: PlanApprovalState;
  private readonly renderedVariants: RenderedVariant[] = [];
  private readonly cumulativeEditPlans: EditPlan[] = [];
  private readonly seenEditPlanIds = new Set<string>();
  private dirtySinceLastFlush = false;

  // Per-message scratch state.
  private currentTurnAbort: AbortController | null = null;
  private toolCallsThisMessage: Record<string, number> = {};
  private renderedThisMessage = 0;

  private constructor(
    opts: ConversationOpts,
    agentId: AgentId,
    systemParams: ReturnType<typeof buildSystemParams>,
  ) {
    this.opts = opts;
    this.agentId = agentId;
    this.systemParams = systemParams;
    this.client = opts.client ?? new Anthropic();
    this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

    this.planApproval = { approved: false, approvedPlans: [] };

    const discovery: ToolDiscovery = { discovered: new Set<string>() };
    this.state = {
      messages: [],
      discovery,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      toolCallsByName: {},
    };

    this.tools = editingAgentTools;
    const toolSearch = buildToolSearchTool(this.tools, discovery);
    const enterPlanMode = buildEnterPlanModeTool(this.planApproval);
    const exitPlanMode = buildExitPlanModeTool(
      this.planApproval,
      opts.approvePlans ?? defaultPlanApprover,
      () => newJobId("compact"),
    );
    this.loopTools = [toolSearch, enterPlanMode, exitPlanMode];

    this.hooks = {
      postToolUse: {
        RenderVariant: buildOnRenderComplete(
          opts.compliance ?? runComplianceCheck,
        ),
        DeliverToAdPlatform: extractCreativeInsights,
      },
      preToolUse: {
        DeliverToAdPlatform: preDeliverToAdPlatform,
      },
    };

    // Register the chat session's main agent with the activity registry
    // so the live status line in the renderer can show it. Activity is
    // updated as tools fire (see buildCycleOpts). Stays registered for
    // the lifetime of the process — there's only one Conversation in
    // chat mode.
    agentActivity.register(this.agentId, "editing", "EditingAgent (chat)");
    agentActivity.setActivity(this.agentId, "awaiting input");
  }

  static async create(opts: ConversationOpts): Promise<Conversation> {
    const agentId = newAgentId("editing");
    const systemBlocks = await buildEditingAgentContext(
      opts.brandId as Parameters<typeof buildEditingAgentContext>[0],
      opts.campaignId as Parameters<typeof buildEditingAgentContext>[1],
      opts.assetId as Parameters<typeof buildEditingAgentContext>[2],
      { chat: true },
    );
    const systemParams = buildSystemParams(systemBlocks);
    return new Conversation(opts, agentId, systemParams);
  }

  // Run one user message through the agent loop. Appends the user message
  // to history, then drives the per-turn cycle until end_turn or maxIters.
  // Persists new EditPlans + VariantBatch sidecars to disk on completion
  // if the turn produced any renders.
  async sendUserMessage(text: string): Promise<TurnResult> {
    const abort = new AbortController();
    this.currentTurnAbort = abort;
    this.toolCallsThisMessage = {};
    this.renderedThisMessage = 0;
    const usageBefore = { ...this.state.usage };

    agentActivity.setActivity(this.agentId, "thinking");
    this.state.messages.push({ role: "user", content: text });

    const cycleOpts = this.buildCycleOpts(abort.signal);

    let finalText = "";
    let iterations = 0;
    let aborted = false;

    try {
      for (let iter = 1; iter <= this.maxIterations; iter++) {
        iterations = iter;
        const result = await runOneTurnCycle(this.state, cycleOpts, iter);
        if (result.done) {
          finalText = result.finalText;
          break;
        }
      }
    } catch (e) {
      if (isAbortError(e) || abort.signal.aborted) {
        aborted = true;
      } else {
        throw e;
      }
    } finally {
      this.currentTurnAbort = null;
      agentActivity.setActivity(this.agentId, "awaiting input");
    }

    let persisted: TurnResult["persisted"];
    if (!aborted && this.dirtySinceLastFlush) {
      persisted = await this.flushToDisk();
    }

    return {
      finalText,
      iterations,
      usage: {
        input_tokens: this.state.usage.input_tokens - usageBefore.input_tokens,
        output_tokens:
          this.state.usage.output_tokens - usageBefore.output_tokens,
        cache_creation_input_tokens:
          this.state.usage.cache_creation_input_tokens -
          usageBefore.cache_creation_input_tokens,
        cache_read_input_tokens:
          this.state.usage.cache_read_input_tokens -
          usageBefore.cache_read_input_tokens,
      },
      toolCallsThisMessage: this.toolCallsThisMessage,
      aborted,
      ...(persisted !== undefined ? { persisted } : {}),
    };
  }

  // Cancel the in-flight turn (if any). The runOneTurnCycle abort recovery
  // synthesises tool_result stubs for any pending tool_use blocks so the
  // messages array stays valid.
  cancel(): void {
    this.currentTurnAbort?.abort();
  }

  // Drop conversation state but keep the session env (brand/campaign/asset)
  // and the registered hooks/tools. Equivalent to /clear.
  reset(): void {
    this.state.messages = [];
    this.state.discovery.discovered.clear();
    this.state.usage.input_tokens = 0;
    this.state.usage.output_tokens = 0;
    this.state.usage.cache_creation_input_tokens = 0;
    this.state.usage.cache_read_input_tokens = 0;
    for (const k of Object.keys(this.state.toolCallsByName)) {
      delete this.state.toolCallsByName[k];
    }
    this.planApproval.approved = false;
    this.planApproval.approvedPlans = [];
    this.renderedVariants.length = 0;
    this.cumulativeEditPlans.length = 0;
    this.seenEditPlanIds.clear();
    this.dirtySinceLastFlush = false;
  }

  snapshot(): Snapshot {
    let toolCalls = 0;
    for (const n of Object.values(this.state.toolCallsByName)) toolCalls += n;
    return {
      messages: this.state.messages.length,
      toolCalls,
      tokens: {
        input: this.state.usage.input_tokens,
        output: this.state.usage.output_tokens,
        cacheRead: this.state.usage.cache_read_input_tokens,
        cacheCreation: this.state.usage.cache_creation_input_tokens,
      },
      approvedPlans: this.cumulativeEditPlans.length,
      renderedVariants: this.renderedVariants.length,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────

  private buildCycleOpts(signal: AbortSignal): TurnCycleOpts {
    const ctx: ToolUseContext = {
      agentId: this.agentId,
      brandId: this.opts.brandId,
      campaignId: this.opts.campaignId,
      assetId: this.opts.assetId,
      abortSignal: signal,
    };
    const gatedCanUseTool: typeof canUseTool = async (tool, input, c) => {
      if (tool.name === "RenderVariant" && !this.planApproval.approved) {
        return {
          action: "deny",
          reason:
            "RenderVariant requires plan approval. Call ExitPlanMode with your edit plans first.",
        };
      }
      return await canUseTool(tool, input, c);
    };
    return {
      client: this.client,
      model: this.opts.model ?? DEFAULT_MODEL,
      maxTokens: this.maxTokens,
      systemParams: this.systemParams,
      tools: this.tools,
      loopTools: this.loopTools,
      ctx,
      canUseTool: gatedCanUseTool,
      hooks: this.hooks,
      compactStrategy: this.compactStrategy,
      modelContextLimit: this.modelContextLimit,
      reactiveOpts: this.reactiveOpts,
      onTurnStart: (turn) => {
        agentActivity.setActivity(this.agentId, "thinking");
        this.opts.ui?.turnStart(turn);
      },
      onTurnEnd: (turn, info) => {
        // Heuristic stage label after the model returns: if the agent
        // has been invoking analysis tools, it's likely synthesising
        // findings next; after planning tools, it's drafting plans;
        // after render tools, it's preparing the final reply.
        agentActivity.setActivity(this.agentId, this.deriveStage());
        this.opts.ui?.turnEnd(turn, info);
      },
      onToolCall: (name, input) => {
        this.toolCallsThisMessage[name] =
          (this.toolCallsThisMessage[name] ?? 0) + 1;
        agentActivity.setActivity(this.agentId, activityForTool(name));
        this.opts.ui?.toolCall(name, input);
      },
      onToolSuccess: (name, _input, output) => {
        if (name === "ExitPlanMode") {
          // Capture freshly minted plans into the session-wide cumulative
          // list. EnterPlanMode resets `planApproval.approvedPlans` on the
          // next planning cycle, so we must snapshot here.
          for (const p of this.planApproval.approvedPlans) {
            if (!this.seenEditPlanIds.has(p.id)) {
              this.cumulativeEditPlans.push(p);
              this.seenEditPlanIds.add(p.id);
              this.dirtySinceLastFlush = true;
            }
          }
        } else if (name === "RenderVariant") {
          const r = output as Pick<
            RenderedVariant,
            "variant_spec_id" | "output_path" | "duration_ms" | "size_bytes"
          >;
          this.renderedVariants.push({
            variant_spec_id:
              r.variant_spec_id as RenderedVariant["variant_spec_id"],
            output_path: r.output_path,
            duration_ms: r.duration_ms,
            size_bytes: r.size_bytes,
            rendered_at_ms: Date.now(),
          });
          this.renderedThisMessage++;
          this.dirtySinceLastFlush = true;
        }
        this.opts.ui?.toolSuccess(name, output);
      },
      onToolError: (name, error) => this.opts.ui?.toolError(name, error),
    };
  }

  // Best-guess label for what the agent is "doing" right now after a
  // model turn completes. Looks at the most recently called tools to
  // pick a stage. The label is informational only — used in the live
  // renderer line to make the chat feel alive.
  private deriveStage(): string {
    const calls = this.toolCallsThisMessage;
    const has = (n: string): boolean => (calls[n] ?? 0) > 0;
    if (has("RenderVariant")) return "preparing reply";
    if (has("ExitPlanMode") && this.planApproval.approved) {
      return "preparing renders";
    }
    if (has("EnterPlanMode") && !has("ExitPlanMode")) {
      return "drafting plans";
    }
    if (
      has("VideoAnalyse") ||
      has("SceneDetect") ||
      has("TranscriptExtract") ||
      has("DescribeScenes")
    ) {
      return "synthesising findings";
    }
    if (has("ToolSearch")) return "discovering tools";
    return "thinking";
  }

  private async flushToDisk(): Promise<TurnResult["persisted"]> {
    const batch: VariantBatch = {
      source_asset_id: this.opts.assetId as VariantBatch["source_asset_id"],
      variants: [...this.renderedVariants],
      edit_plans: [...this.cumulativeEditPlans],
      compliance_status:
        this.renderedVariants.length > 0 ? "passed" : "pending",
    };
    const editPlanFiles = await recordEditPlans(
      this.opts.brandId as Parameters<typeof recordEditPlans>[0],
      this.opts.campaignId as Parameters<typeof recordEditPlans>[1],
      this.cumulativeEditPlans,
    );
    const { batchPath, variantPaths } = await recordVariantBatch(
      this.opts.brandId as Parameters<typeof recordVariantBatch>[0],
      this.opts.campaignId as Parameters<typeof recordVariantBatch>[1],
      this.opts.assetId as Parameters<typeof recordVariantBatch>[2],
      batch,
    );
    this.dirtySinceLastFlush = false;
    return {
      editPlanFiles,
      batchFile: batchPath,
      variantFiles: variantPaths,
    };
  }
}

// Mirror of TOOL_VERBS in cli.ts but expressed as activity strings
// (tool-name → "what the agent is doing right now"). Kept here so the
// registry stays UI-agnostic — the renderer just reads activity strings,
// and any new agent (Compliance, Generation) can use the same vocabulary.
function activityForTool(name: string): string {
  const map: Record<string, string> = {
    VideoAnalyse: "probing source video",
    SceneDetect: "detecting scene boundaries",
    TranscriptExtract: "transcribing audio",
    DescribeScenes: "describing scenes",
    ExtractFrames: "extracting frames",
    ToolSearch: "discovering tools",
    EnterPlanMode: "entering plan mode",
    ExitPlanMode: "submitting plans",
    TrimClip: "trimming clip",
    OverlayAsset: "applying overlay",
    AdjustAudio: "adjusting audio",
    RenderVariant: "rendering variant",
    DeliverToAdPlatform: "delivering to platform",
    GenerateShot: "generating shot",
  };
  return map[name] ?? `running ${name}`;
}

function isAbortError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === "AbortError") return true;
  // Anthropic SDK throws APIUserAbortError on signal abort.
  const msg = e.message.toLowerCase();
  return msg.includes("abort") || msg.includes("user cancelled");
}

// Re-exports for tests + main.ts.
export type { ContentBlock };
