import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ComplianceClearance } from "../compliance/ComplianceResult.ts";
import { storagePaths } from "../storage/paths.ts";
import type {
  AssetId,
  BrandId,
  CampaignId,
} from "../types/video.ts";
import type { HookDecision, PreToolUseHook } from "./types.ts";

// Plan §D / T2.2 — PreToolUse hook on DeliverToAdPlatform. Re-validates
// the compliance clearance freshness before money is spent. The Tier 2
// canUseTool gate already checks that a clearance EXISTS and is cleared;
// this hook adds the FRESHNESS axis: was the clearance invalidated by a
// brand-guidelines update happening between render-time and delivery-time?
//
// Why both checks: canUseTool runs once per tool call. The hook runs on
// the same call, but its purpose is the freshness axis specifically.
// Splitting them mirrors Claude Code's "permission classifier vs hook"
// distinction — they have different rationales and the redundancy is
// load-bearing for the $50M-customer money-protection gate.

interface DeliveryInput {
  readonly variant_spec_id?: string;
  readonly asset_id?: string;
}

export const preDeliverToAdPlatform: PreToolUseHook = async (
  toolName,
  input,
  ctx,
): Promise<HookDecision> => {
  if (toolName !== "DeliverToAdPlatform") return { action: "continue" };

  const i = input as DeliveryInput;
  if (i.variant_spec_id === undefined || i.asset_id === undefined) {
    return {
      action: "block",
      reason:
        "DeliverToAdPlatform input must include variant_spec_id and asset_id",
    };
  }

  const clearancePath = storagePaths.variantClearance(
    ctx.brandId as BrandId,
    ctx.campaignId as CampaignId,
    i.asset_id as AssetId,
    i.variant_spec_id,
  );
  if (!existsSync(clearancePath)) {
    return {
      action: "block",
      reason: `clearance missing for variant ${i.variant_spec_id}`,
    };
  }

  let clearance: ComplianceClearance;
  try {
    clearance = JSON.parse(
      await readFile(clearancePath, "utf-8"),
    ) as ComplianceClearance;
  } catch (e) {
    return {
      action: "block",
      reason: `clearance unreadable: ${(e as Error).message}`,
    };
  }
  if (!clearance.passed || clearance.status !== "cleared") {
    return {
      action: "block",
      reason: `clearance not in cleared state: passed=${clearance.passed}, status=${clearance.status}`,
    };
  }

  // Freshness: compare clearance check time to brand guidelines mtime.
  // If guidelines were updated since the clearance, the clearance is stale.
  const guidelinesPath = storagePaths.guidelines(ctx.brandId as BrandId);
  if (existsSync(guidelinesPath)) {
    try {
      const stat = statSync(guidelinesPath);
      if (stat.mtimeMs > clearance.checked_at_ms) {
        return {
          action: "block",
          reason: `clearance stale: brand guidelines updated at ${new Date(stat.mtimeMs).toISOString()}, clearance checked at ${new Date(clearance.checked_at_ms).toISOString()}`,
        };
      }
    } catch {
      // ENOENT race — fall through to allow.
    }
  }

  return { action: "continue" };
};
