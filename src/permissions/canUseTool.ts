import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ComplianceClearance } from "../compliance/ComplianceResult.ts";
import { loadBudget, remaining } from "../storage/budget.ts";
import { storagePaths } from "../storage/paths.ts";
import type { Tool, ToolUseContext } from "../Tool.ts";
import type {
  AssetId,
  BrandId,
  CampaignId,
} from "../types/video.ts";

// Pattern 4 (plan §4) — three tiers.
//   Tier 1 — auto-approve readonly.
//   Tier 2 (T3.2) — compliance clearance gate for DeliverToAdPlatform.
//                   Reads the per-variant clearance JSON written by the
//                   onRenderComplete hook.
//   Tier 3 (T3.3) — budget threshold gate. Returns `needs_leader` when
//                   estimated_spend would exceed remaining budget; the
//                   loop routes this through the swarm permission bus
//                   (§N) so the leader can decide.
export type PermissionDecision =
  | { action: "allow"; reason: string }
  | { action: "deny"; reason: string }
  | {
      action: "needs_leader";
      reason: string;
      escalateTo: "orchestrator";
    };

// Shape DeliverToAdPlatform's input must conform to for the gates to
// reason about it. Defined here rather than in the tool because the gate
// runs BEFORE the tool's own validateInput. Defensive: missing fields
// return `deny`.
interface DeliveryInput {
  readonly variant_spec_id?: string;
  readonly asset_id?: string;
  readonly estimated_spend?: number;
}

const DELIVERY_TOOL_NAME = "DeliverToAdPlatform";

export async function canUseTool(
  tool: Tool,
  input: unknown,
  ctx: ToolUseContext,
): Promise<PermissionDecision> {
  // Tier 1 — auto-approve readonly.
  if (tool.readonly) {
    return { action: "allow", reason: "read-only operation" };
  }

  if (tool.name === DELIVERY_TOOL_NAME) {
    const tier2 = await checkClearance(input, ctx);
    if (tier2.action !== "allow") return tier2;
    const tier3 = await checkBudget(input, ctx);
    if (tier3.action !== "allow") return tier3;
    return { action: "allow", reason: "delivery: cleared + within budget" };
  }

  return {
    action: "allow",
    reason: "Tier 1 default-allow (no agent-specific gate matched)",
  };
}

// T3.2 — clearance gate. Reads `<variant>_clearance.json` written by
// onRenderComplete. Deny when missing, status != "cleared", or passed=false.
async function checkClearance(
  input: unknown,
  ctx: ToolUseContext,
): Promise<PermissionDecision> {
  const i = input as DeliveryInput;
  if (i.variant_spec_id === undefined || i.asset_id === undefined) {
    return {
      action: "deny",
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
      action: "deny",
      reason: `no compliance clearance for ${i.variant_spec_id}`,
    };
  }
  let clearance: ComplianceClearance;
  try {
    clearance = JSON.parse(
      await readFile(clearancePath, "utf-8"),
    ) as ComplianceClearance;
  } catch (e) {
    return {
      action: "deny",
      reason: `clearance file unreadable: ${(e as Error).message}`,
    };
  }
  if (!clearance.passed) {
    return { action: "deny", reason: "clearance did not pass" };
  }
  if (clearance.status !== "cleared") {
    return {
      action: "deny",
      reason: `clearance status: ${clearance.status}`,
    };
  }
  return { action: "allow", reason: "clearance present and cleared" };
}

// T3.3 — budget gate. Returns `needs_leader` when over budget so the loop
// can route through the swarm bridge.
async function checkBudget(
  input: unknown,
  ctx: ToolUseContext,
): Promise<PermissionDecision> {
  const i = input as DeliveryInput;
  const budget = await loadBudget(ctx.brandId as BrandId);
  if (budget === null) {
    // No budget configured for this brand — Phase-1 default is "no
    // constraint" (allow). Production should invert this.
    return { action: "allow", reason: "no budget configured for brand" };
  }
  const wouldSpend = i.estimated_spend ?? 0;
  const left = remaining(budget);
  if (wouldSpend > left) {
    return {
      action: "needs_leader",
      reason: `delivery would exceed budget: requested ${wouldSpend} ${budget.currency}, remaining ${left} ${budget.currency}`,
      escalateTo: "orchestrator",
    };
  }
  return { action: "allow", reason: "within budget" };
}
