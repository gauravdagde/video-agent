import {
  getAssetMetadata,
  getVariantSpecs,
  loadBrandGuidelines,
  loadCampaignRules,
  loadPerformanceMemory,
} from "./loaders.ts";
import { EDITING_AGENT_BASE_PROMPT } from "./prompts.ts";
import { loadSessionMemory } from "../sessionMemory/sessionMemory.ts";
import type {
  AssetId,
  BrandId,
  CampaignId,
  VariantSpec,
  VideoAsset,
} from "../types/video.ts";

// A context block is one ordered piece of system prompt content. The
// `kind` field tells the SDK call site whether to attach cache_control
// — stable blocks get cached, dynamic blocks do not.
export interface ContextBlock {
  readonly kind: "stable" | "dynamic";
  readonly source: ContextBlockSource;
  readonly content: string;
}

export type ContextBlockSource =
  | "agent_identity"
  | "brand_guidelines"
  | "campaign_rules"
  | "performance_memory"
  | "session_memory"
  | "asset_metadata"
  | "variant_specs";

// Pattern 1 (plan §I) — six layers, stable first, dynamic last.
//
// Layer 1   — agent identity (stable, always cached)
// Layer 2   — brand guidelines (MagicDoc; updated only between agent runs)
// Layer 3   — campaign rules
// Layer 4   — performance memory (capped — see loaders.ts)
// Layer 4.5 — session memory (T1.2, capped — present only when sessionId given)
// Layer 5   — asset metadata + variant specs (DYNAMIC; goes last so the
//             stable layers stay byte-identical across runs)
//
// §I cache-key note: when sessionId is omitted the layer is omitted, NOT
// emitted as an empty string. Two builds with the same (brand, campaign,
// asset) but no sessionId produce byte-identical output to a build of an
// older spawn that didn't pass sessionId at all. Adding sessionId is a
// deliberate cache-key change.
export async function buildEditingAgentContext(
  brandId: BrandId,
  campaignId: CampaignId,
  assetId: AssetId,
  sessionId?: string,
): Promise<readonly ContextBlock[]> {
  const [guidelines, campaignRules, performance, sessionMem, asset, specs] =
    await Promise.all([
      loadBrandGuidelines(brandId),
      loadCampaignRules(brandId, campaignId),
      loadPerformanceMemory(brandId),
      sessionId !== undefined
        ? loadSessionMemory(brandId, campaignId, sessionId)
        : Promise.resolve(null),
      getAssetMetadata(brandId, campaignId, assetId),
      getVariantSpecs(brandId, campaignId),
    ]);

  const blocks: ContextBlock[] = [
    {
      kind: "stable",
      source: "agent_identity",
      content: EDITING_AGENT_BASE_PROMPT,
    },
    { kind: "stable", source: "brand_guidelines", content: guidelines },
    { kind: "stable", source: "campaign_rules", content: campaignRules },
    { kind: "stable", source: "performance_memory", content: performance },
  ];
  if (sessionMem !== null) {
    blocks.push({
      kind: "stable",
      source: "session_memory",
      content: sessionMem,
    });
  }
  blocks.push(
    {
      kind: "dynamic",
      source: "asset_metadata",
      content: formatAsset(asset),
    },
    {
      kind: "dynamic",
      source: "variant_specs",
      content: formatVariantSpecs(specs),
    },
  );
  return blocks;
}

// Render to a stable string. Field order is fixed; numeric values render
// with no locale-dependent formatting.
function formatAsset(a: VideoAsset): string {
  return [
    "# Source asset",
    `id: ${a.id}`,
    `path: ${a.path}`,
    `duration_ms: ${a.duration_ms}`,
    `resolution: ${a.resolution.width}x${a.resolution.height}`,
    `frame_rate: ${a.frame_rate}`,
    `has_audio: ${a.has_audio}`,
    "",
  ].join("\n");
}

function formatVariantSpecs(specs: readonly VariantSpec[]): string {
  if (specs.length === 0) {
    return "# Variant specs\n(none — empty list)\n";
  }
  const lines: string[] = ["# Variant specs"];
  for (const s of specs) {
    lines.push(`- id: ${s.id}`);
    lines.push(`  platform: ${s.platform}`);
    lines.push(`  max_duration_ms: ${s.max_duration_ms}`);
    lines.push(`  aspect_ratio: ${s.aspect_ratio}`);
    if (s.audience_segment !== undefined) {
      lines.push(`  audience_segment: ${s.audience_segment}`);
    }
    if (s.market !== undefined) lines.push(`  market: ${s.market}`);
    if (s.cta_override !== undefined) {
      lines.push(`  cta_override: ${s.cta_override}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
