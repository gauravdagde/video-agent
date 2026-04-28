import { editingAgentCompactStrategy } from "../../compact/CompactStrategy.ts";
import { runAgentLoop, type RunResult } from "../../agent/runAgentLoop.ts";
import { canUseTool } from "../../permissions/canUseTool.ts";
import type { TaskRecord } from "../../Task.ts";
import { GenerateShotTool } from "../../tools/generation/GenerateShot.ts";
import { newAgentId } from "../../types/ids.ts";
import type {
  BrandId,
  CampaignId,
} from "../../types/video.ts";
import { agentActivity } from "../../ui/agentActivity.ts";
import { buildGenerationAgentContext } from "./buildGenerationAgentContext.ts";

// Plan §4.4 — GenerationAgent. Reads creative brief, produces shots via
// GenerateShot calls (which fan out to model adapters), returns the
// stitched source asset path so the EditingAgent can take over.
//
// Phase-1 scope: skeleton agent loop. Stitching the generated shots into
// a final source.mp4 is left to the host (call ffmpeg concat outside the
// agent loop) since the loop itself only orchestrates generation calls.

export interface GenerationBrief {
  readonly brandId: BrandId;
  readonly campaignId: CampaignId;
  readonly creativeBrief: string;
}

export interface GenerationSpawnResult {
  readonly task: TaskRecord;
  readonly run: RunResult;
}

const DEFAULT_MODEL = process.env.MODEL ?? "claude-opus-4-7";

export async function spawnGenerationAgent(
  brief: GenerationBrief,
): Promise<GenerationSpawnResult> {
  const agentId = newAgentId("generation");
  const startedAtMs = Date.now();

  const task: TaskRecord = {
    id: agentId,
    type: "generation_agent",
    status: "running",
    startedAtMs,
    summaryLabel: "starting",
    summaryUpdatedAtMs: startedAtMs,
    recentActivities: [],
    brandId: brief.brandId,
    campaignId: brief.campaignId,
  };

  const systemBlocks = await buildGenerationAgentContext(
    brief.brandId,
    brief.campaignId,
  );

  const initialMessage =
    `Generate a source asset for this campaign brief:\n\n` +
    `${brief.creativeBrief}\n\n` +
    `Plan your storyboard, then call GenerateShot for each shot in order. ` +
    `Return the JSON storyboard summary as your final response.`;

  const abort = new AbortController();
  agentActivity.register(agentId, "generation", "GenerationAgent");
  agentActivity.setActivity(agentId, "planning storyboard");
  try {
    const run = await runAgentLoop({
      model: DEFAULT_MODEL,
      systemBlocks,
      tools: [GenerateShotTool],
      initialMessage,
      ctx: {
        agentId,
        brandId: brief.brandId,
        campaignId: brief.campaignId,
        abortSignal: abort.signal,
      },
      canUseTool,
      compactStrategy: editingAgentCompactStrategy,
      onToolCall: (name) => {
        agentActivity.setActivity(agentId, `running ${name}`);
      },
    });
    task.status = "succeeded";
    task.endedAtMs = Date.now();
    return { task, run };
  } catch (e) {
    task.status = "failed";
    task.endedAtMs = Date.now();
    throw e;
  } finally {
    agentActivity.unregister(agentId);
  }
}
