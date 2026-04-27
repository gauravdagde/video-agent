import type { ContextBlock } from "../context/buildEditingAgentContext.ts";
import {
  loadBrandGuidelines,
  loadCampaignRules,
  loadPerformanceMemory,
} from "../context/loaders.ts";
import { loadSessionMemory } from "../sessionMemory/sessionMemory.ts";
import type { BrandId, CampaignId } from "../types/video.ts";
import { ORCHESTRATOR_COORDINATOR_PROMPT } from "./prompts.ts";

// Pattern 1 — Orchestrator's layered context.
// Layer 1: coordinator-mode prompt
// Layer 2: brand guidelines (MagicDoc)
// Layer 3: performance memory (capped)
// Layer 4: session memory (per-session forked subagent — §L)
// Layer 5: campaign brief
// Layer 6 (dynamic): active task list — JSON, sorted for cache stability
export async function buildOrchestratorContext(
  brandId: BrandId,
  campaignId: CampaignId,
  sessionId: string,
  activeTaskIds: readonly string[],
): Promise<readonly ContextBlock[]> {
  const [guidelines, perf, session, brief] = await Promise.all([
    loadBrandGuidelines(brandId),
    loadPerformanceMemory(brandId),
    loadSessionMemory(brandId, campaignId, sessionId),
    loadCampaignRules(brandId, campaignId),
  ]);
  // §I — sort task ids canonically; the byte content of this layer must
  // be deterministic for a given input set.
  const sortedTaskIds = [...activeTaskIds].sort();
  return [
    {
      kind: "stable",
      source: "agent_identity",
      content: ORCHESTRATOR_COORDINATOR_PROMPT,
    },
    { kind: "stable", source: "brand_guidelines", content: guidelines },
    { kind: "stable", source: "performance_memory", content: perf },
    { kind: "stable", source: "session_memory", content: session },
    { kind: "stable", source: "campaign_rules", content: brief },
    {
      kind: "dynamic",
      source: "asset_metadata", // re-using the dynamic-source tag for tasks
      content:
        "# Active task list\n" +
        (sortedTaskIds.length === 0
          ? "(none)\n"
          : sortedTaskIds.map((id) => `- ${id}`).join("\n") + "\n"),
    },
  ];
}
