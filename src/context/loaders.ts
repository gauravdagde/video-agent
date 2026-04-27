import { readFile } from "node:fs/promises";
import { storagePaths } from "../storage/paths.ts";
import type {
  AssetId,
  BrandId,
  CampaignId,
  VariantSpec,
  VideoAsset,
} from "../types/video.ts";

// §I — caps on Layer 4 are about cache-key stability, not disk space.
// Numbers match Claude Code's memdir/memdir.ts (verified MAX_ENTRYPOINT_LINES
// = 200, MAX_ENTRYPOINT_BYTES = 25_000).
export const MAX_PERFORMANCE_LINES = 200;
export const MAX_PERFORMANCE_BYTES = 25_000;

export async function loadBrandGuidelines(brandId: BrandId): Promise<string> {
  const content = await readFileOrEmpty(storagePaths.guidelines(brandId));
  return content ?? `# Brand guidelines: ${brandId}\n(none on file yet)\n`;
}

export async function loadCampaignRules(
  brandId: BrandId,
  campaignId: CampaignId,
): Promise<string> {
  const content = await readFileOrEmpty(
    storagePaths.campaignBrief(brandId, campaignId),
  );
  return content ?? `# Campaign brief: ${campaignId}\n(none on file yet)\n`;
}

export async function loadPerformanceMemory(
  brandId: BrandId,
): Promise<string> {
  const raw = await readFileOrEmpty(storagePaths.performanceMemory(brandId));
  if (raw === null) {
    return `# Performance memory: ${brandId}\n# Lines: 0 / ${MAX_PERFORMANCE_LINES} max\n(no data yet)\n`;
  }
  // Hard caps applied in this order: lines, then bytes.
  let trimmed = raw.split("\n").slice(0, MAX_PERFORMANCE_LINES).join("\n");
  if (Buffer.byteLength(trimmed, "utf-8") > MAX_PERFORMANCE_BYTES) {
    trimmed = trimmed.slice(0, MAX_PERFORMANCE_BYTES);
  }
  return trimmed;
}

// §I — must be deterministic for a given (brand, campaign, asset) tuple.
// No mtime, no lastAccessed, no timestamps anywhere.
export async function getAssetMetadata(
  brandId: BrandId,
  campaignId: CampaignId,
  assetId: AssetId,
): Promise<VideoAsset> {
  const raw = await readFileOrEmpty(
    storagePaths.assetMetadata(brandId, campaignId, assetId),
  );
  if (raw === null) {
    throw new Error(
      `asset metadata not found: ${storagePaths.assetMetadata(brandId, campaignId, assetId)} — run VideoAnalyse first`,
    );
  }
  const parsed = JSON.parse(raw) as VideoAsset;
  return canonicaliseAsset(parsed, assetId);
}

// §I — sorted by spec id for canonical ordering. No set semantics.
export async function getVariantSpecs(
  brandId: BrandId,
  campaignId: CampaignId,
): Promise<VariantSpec[]> {
  const raw = await readFileOrEmpty(
    storagePaths.variantSpecs(brandId, campaignId),
  );
  if (raw === null) return [];
  const parsed = JSON.parse(raw) as VariantSpec[];
  return [...parsed].sort((a, b) => a.id.localeCompare(b.id));
}

// --- helpers ---

async function readFileOrEmpty(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function canonicaliseAsset(a: VideoAsset, expectedId: AssetId): VideoAsset {
  return {
    id: expectedId,
    path: a.path,
    duration_ms: a.duration_ms,
    resolution: { width: a.resolution.width, height: a.resolution.height },
    frame_rate: a.frame_rate,
    has_audio: a.has_audio,
  };
}
