import type { ContextBlock } from "../../context/buildEditingAgentContext.ts";
import {
  loadBrandGuidelines,
  loadCampaignRules,
  loadPerformanceMemory,
} from "../../context/loaders.ts";
import type { BrandId, CampaignId } from "../../types/video.ts";
import { GENERATION_AGENT_BASE_PROMPT } from "./prompts.ts";

// Pattern 1 — GenerationAgent's layered context.
// Layer 1: agent identity
// Layer 2: brand guidelines (MagicDoc)
// Layer 3: campaign brief
// Layer 4: performance memory — load-bearing for "generate informed by
//          observed patterns" (Phase 2's reason for existing).
export async function buildGenerationAgentContext(
  brandId: BrandId,
  campaignId: CampaignId,
): Promise<readonly ContextBlock[]> {
  const [guidelines, campaignRules, perf] = await Promise.all([
    loadBrandGuidelines(brandId),
    loadCampaignRules(brandId, campaignId),
    loadPerformanceMemory(brandId),
  ]);
  return [
    {
      kind: "stable",
      source: "agent_identity",
      content: GENERATION_AGENT_BASE_PROMPT,
    },
    { kind: "stable", source: "brand_guidelines", content: guidelines },
    { kind: "stable", source: "campaign_rules", content: campaignRules },
    { kind: "stable", source: "performance_memory", content: perf },
  ];
}
