import { editingAgentCompactStrategy } from "../compact/CompactStrategy.ts";
import { buildEditingAgentContext } from "../context/buildEditingAgentContext.ts";
import { extractCreativeInsights } from "../hooks/extractCreativeInsights.ts";
import {
  buildOnRenderComplete,
  type ComplianceCheckFn,
} from "../hooks/onRenderComplete.ts";
import { preDeliverToAdPlatform } from "../hooks/preDeliverToAdPlatform.ts";
import { canUseTool } from "../permissions/canUseTool.ts";
import { runComplianceCheck } from "../compliance/runComplianceCheck.ts";
import {
  recordEditPlans,
  recordVariantBatch,
} from "../storage/recorder.ts";
import { editingAgentTools } from "../tools/registry.ts";
import { newAgentId, newJobId } from "../types/ids.ts";
import type {
  AssetId,
  BrandId,
  CampaignId,
  EditPlan,
  RenderedVariant,
  VariantBatch,
} from "../types/video.ts";
import type { TaskRecord } from "../Task.ts";
import type { CliRenderer } from "../ui/cli.ts";
import {
  buildEnterPlanModeTool,
  buildExitPlanModeTool,
  defaultPlanApprover,
  type PlanApprover,
} from "./loopTools.ts";
import { runAgentLoop, type RunResult } from "./runAgentLoop.ts";

export interface EditingBrief {
  readonly brandId: BrandId;
  readonly campaignId: CampaignId;
  readonly assetId: AssetId;
  readonly extraInstructions?: string;
  readonly approvePlans?: PlanApprover;
  // Defaults to the always-pass stub. Pass `runComplianceAgent` here to
  // run the real ComplianceAgent on every render (costs API tokens per
  // render — opt in deliberately).
  readonly compliance?: ComplianceCheckFn;
  // Optional UI renderer. When provided, turn-boundaries + tool-calls
  // are surfaced through it. Without one, the run is silent.
  readonly ui?: CliRenderer;
}

export interface SpawnResult {
  readonly task: TaskRecord;
  readonly run: RunResult;
  readonly approvedPlans: readonly EditPlan[];
  readonly batch: VariantBatch;
  readonly persistedTo: {
    readonly editPlanFiles: readonly string[];
    readonly batchFile: string;
    readonly variantFiles: readonly string[];
  };
}

const DEFAULT_MODEL = process.env.MODEL ?? "claude-opus-4-7";

export async function spawnEditingAgent(brief: EditingBrief): Promise<SpawnResult> {
  const agentId = newAgentId("editing");
  const startedAtMs = Date.now();

  const task: TaskRecord = {
    id: agentId,
    type: "editing_agent",
    status: "running",
    startedAtMs,
    summaryLabel: "starting",
    summaryUpdatedAtMs: startedAtMs,
    recentActivities: [],
    brandId: brief.brandId,
    campaignId: brief.campaignId,
  };

  const systemBlocks = await buildEditingAgentContext(
    brief.brandId,
    brief.campaignId,
    brief.assetId,
  );

  const initialMessage = formatBrief(brief);
  const renderedVariants: RenderedVariant[] = [];
  const abort = new AbortController();

  // §C — plan-approval state lives here, not in the loop. EditingAgent is
  // the only agent that needs plan-mode; ComplianceAgent / PerformanceAgent
  // do not. The state is read by both ExitPlanMode (mutates) and our
  // canUseTool wrapper (reads to gate RenderVariant).
  const planApproval = {
    approved: false,
    approvedPlans: [] as readonly EditPlan[],
  };
  const exitPlanMode = buildExitPlanModeTool(
    planApproval,
    brief.approvePlans ?? defaultPlanApprover,
    () => newJobId("compact"),
  );
  const gatedCanUseTool: typeof canUseTool = async (tool, input, ctx) => {
    if (tool.name === "RenderVariant" && !planApproval.approved) {
      return {
        action: "deny",
        reason:
          "RenderVariant requires plan approval. Call ExitPlanMode with your edit plans first.",
      };
    }
    return await canUseTool(tool, input, ctx);
  };

  try {
    const run = await runAgentLoop({
      model: DEFAULT_MODEL,
      systemBlocks,
      tools: editingAgentTools,
      extraLoopTools: [buildEnterPlanModeTool(planApproval), exitPlanMode],
      initialMessage,
      ctx: {
        agentId,
        brandId: brief.brandId,
        campaignId: brief.campaignId,
        assetId: brief.assetId,
        abortSignal: abort.signal,
      },
      canUseTool: gatedCanUseTool,
      compactStrategy: editingAgentCompactStrategy,
      // §D — PostToolUse compliance gate on every render + PreToolUse
      // freshness gate on every delivery. Default compliance is the stub;
      // caller can opt into runComplianceAgent by passing `compliance`.
      hooks: {
        postToolUse: {
          RenderVariant: buildOnRenderComplete(
            brief.compliance ?? runComplianceCheck,
          ),
          // T2.3 — record a learning row in performance_memory.md after
          // every successful delivery. Default extractor is a placeholder
          // until metrics flow back from the platform.
          DeliverToAdPlatform: extractCreativeInsights,
        },
        preToolUse: {
          DeliverToAdPlatform: preDeliverToAdPlatform,
        },
      },
      onToolCall: (name, input) => {
        const startedAt = Date.now();
        task.recentActivities = [
          ...task.recentActivities.slice(-4),
          { tool: name, startedAtMs: startedAt, inputPreview: "" },
        ];
        brief.ui?.toolCall(name, input);
      },
      onToolSuccess: (name, _input, output) => {
        if (name === "RenderVariant") {
          const r = output as Pick<
            RenderedVariant,
            "variant_spec_id" | "output_path" | "duration_ms" | "size_bytes"
          >;
          renderedVariants.push({
            variant_spec_id: r.variant_spec_id as RenderedVariant["variant_spec_id"],
            output_path: r.output_path,
            duration_ms: r.duration_ms,
            size_bytes: r.size_bytes,
            rendered_at_ms: Date.now(),
          });
        }
        brief.ui?.toolSuccess(name, output);
      },
      onToolError: (name, error) => brief.ui?.toolError(name, error),
      onTurnStart: (turn) => brief.ui?.turnStart(turn),
      onTurnEnd: (turn, info) => brief.ui?.turnEnd(turn, info),
    });

    const batch: VariantBatch = {
      source_asset_id: brief.assetId,
      variants: renderedVariants,
      edit_plans: [...planApproval.approvedPlans],
      compliance_status: renderedVariants.length > 0 ? "passed" : "pending",
    };

    const editPlanFiles = await recordEditPlans(
      brief.brandId,
      brief.campaignId,
      planApproval.approvedPlans,
    );
    const { batchPath, variantPaths } = await recordVariantBatch(
      brief.brandId,
      brief.campaignId,
      brief.assetId,
      batch,
    );

    task.status = "succeeded";
    task.endedAtMs = Date.now();

    return {
      task,
      run,
      approvedPlans: planApproval.approvedPlans,
      batch,
      persistedTo: {
        editPlanFiles,
        batchFile: batchPath,
        variantFiles: variantPaths,
      },
    };
  } catch (e) {
    task.status = "failed";
    task.endedAtMs = Date.now();
    throw e;
  }
}

function formatBrief(brief: EditingBrief): string {
  const parts = [
    `Edit source asset \`${brief.assetId}\` for campaign \`${brief.campaignId}\` (brand \`${brief.brandId}\`).`,
    `The full list of variant specifications is in your system context under "Variant specs."`,
    `Process them in order. Begin by analysing the source video, then produce an edit plan, then render each variant.`,
  ];
  if (brief.extraInstructions !== undefined) {
    parts.push(`Additional instructions:\n${brief.extraInstructions}`);
  }
  return parts.join("\n\n");
}
