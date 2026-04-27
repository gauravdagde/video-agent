import { loadBrandGuidelines } from "../context/loaders.ts";
import type { ContextBlock } from "../context/buildEditingAgentContext.ts";
import type { BrandId } from "../types/video.ts";
import { COMPLIANCE_AGENT_BASE_PROMPT } from "./prompts.ts";

// Pattern 1 — ComplianceAgent's layered context.
// Per the plan §3 (Phase 3):
//   Layer 1: COMPLIANCE_AGENT_BASE_PROMPT
//   Layer 2: brand guidelines (MagicDoc — §F)
//   Layer 3: market legal spec
//   Layer 4: platform technical spec
//   No dynamic layer — compliance is stateless per asset.
//
// Phase 1 wires layer 1 + layer 2 only. Layers 3 and 4 are skeleton
// placeholders that fall through to a stub if no spec file is on disk;
// real market/platform specs land when those tools are actually used.
export async function buildComplianceAgentContext(
  brandId: BrandId,
  market: string | undefined,
  platform: string | undefined,
): Promise<readonly ContextBlock[]> {
  const guidelines = await loadBrandGuidelines(brandId);
  return [
    {
      kind: "stable",
      source: "agent_identity",
      content: COMPLIANCE_AGENT_BASE_PROMPT,
    },
    { kind: "stable", source: "brand_guidelines", content: guidelines },
    {
      kind: "stable",
      source: "campaign_rules",
      content: marketSpecStub(market),
    },
    {
      kind: "stable",
      source: "performance_memory",
      content: platformSpecStub(platform),
    },
  ];
}

function marketSpecStub(market: string | undefined): string {
  if (market === undefined) {
    return "# Market legal spec\n(no market specified; default rules apply)\n";
  }
  return `# Market legal spec — ${market}\n(no on-disk spec for this market yet — use general advertising standards)\n`;
}

function platformSpecStub(platform: string | undefined): string {
  if (platform === undefined) {
    return "# Platform technical spec\n(no platform specified)\n";
  }
  // Quick reference table — not authoritative, but lets the model judge
  // basic platform spec violations without a full spec on disk.
  const table: Record<string, string> = {
    instagram_reel:
      "aspect_ratio: 9:16; max_duration: 90s; safe_zone: avoid bottom 15% (UI overlays)",
    tiktok:
      "aspect_ratio: 9:16; max_duration: 60s; safe_zone: avoid right 15% (interaction icons)",
    youtube_pre:
      "aspect_ratio: 16:9; max_duration: 30s for skippable, 6s/15s for non-skip; no safe zone",
    display_16_9:
      "aspect_ratio: 16:9; no duration cap; no safe-zone constraints",
  };
  const spec = table[platform] ?? "(no quick-reference for this platform)";
  return `# Platform technical spec — ${platform}\n${spec}\n`;
}
