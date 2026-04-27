import { runComplianceCheck } from "../compliance/runComplianceCheck.ts";
import { spawnGenerationAgent } from "../agents/generation/spawnGenerationAgent.ts";
import {
  spawnEditingAgent,
  type SpawnResult as EditSpawnResult,
} from "../agent/spawnEditingAgent.ts";
import type {
  AssetId,
  BrandId,
  CampaignId,
} from "../types/video.ts";

// Plan §2 (Pattern 2 / T5.4) — dispatcher. Routes incoming briefs by type
// to the right downstream pipeline. Slash-command and bash-mode style
// fast paths skip the full agent loop; AI paths spawn the appropriate
// agent.

export type Brief =
  | {
      readonly type: "compliance_check_only";
      readonly brand_id: BrandId;
      readonly asset_path: string;
      readonly market?: string;
      readonly platform?: string;
    }
  | {
      readonly type: "edit_existing";
      readonly brand_id: BrandId;
      readonly campaign_id: CampaignId;
      readonly asset_id: AssetId;
      readonly extra_instructions?: string;
    }
  | {
      readonly type: "generate_new";
      readonly brand_id: BrandId;
      readonly campaign_id: CampaignId;
      readonly creative_brief: string;
    };

export type BriefResult =
  | { readonly type: "compliance"; readonly clearance: unknown }
  | {
      readonly type: "edit_existing";
      readonly result: EditSpawnResult;
    }
  | { readonly type: "generate_new"; readonly result: unknown };

export async function processBrief(brief: Brief): Promise<BriefResult> {
  switch (brief.type) {
    case "compliance_check_only": {
      const clearance = await runComplianceCheck({
        assetPath: brief.asset_path,
        brandId: brief.brand_id,
        ...(brief.market !== undefined ? { market: brief.market } : {}),
        ...(brief.platform !== undefined ? { platform: brief.platform } : {}),
      });
      return { type: "compliance", clearance };
    }
    case "edit_existing": {
      const result = await spawnEditingAgent({
        brandId: brief.brand_id,
        campaignId: brief.campaign_id,
        assetId: brief.asset_id,
        ...(brief.extra_instructions !== undefined
          ? { extraInstructions: brief.extra_instructions }
          : {}),
      });
      return { type: "edit_existing", result };
    }
    case "generate_new": {
      const result = await spawnGenerationAgent({
        brandId: brief.brand_id,
        campaignId: brief.campaign_id,
        creativeBrief: brief.creative_brief,
      });
      return { type: "generate_new", result };
    }
  }
}
