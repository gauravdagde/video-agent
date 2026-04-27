import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ContextBlock } from "../context/buildEditingAgentContext.ts";
import {
  loadBrandGuidelines,
  loadPerformanceMemory,
} from "../context/loaders.ts";
import { storagePaths } from "../storage/paths.ts";
import type { BrandId } from "../types/video.ts";
import { PERFORMANCE_AGENT_PROMPT } from "./prompts.ts";

// Layered context for PerformanceAgent. The dynamic layer is the recent
// delivery receipts — that's the data the agent reasons over.

export async function buildPerformanceAgentContext(
  brandId: BrandId,
  receiptLimit = 200,
): Promise<readonly ContextBlock[]> {
  const [guidelines, perfMem, receipts] = await Promise.all([
    loadBrandGuidelines(brandId),
    loadPerformanceMemory(brandId),
    loadRecentReceipts(brandId, receiptLimit),
  ]);
  return [
    {
      kind: "stable",
      source: "agent_identity",
      content: PERFORMANCE_AGENT_PROMPT,
    },
    { kind: "stable", source: "brand_guidelines", content: guidelines },
    { kind: "stable", source: "performance_memory", content: perfMem },
    {
      kind: "dynamic",
      source: "asset_metadata",
      content: receipts,
    },
  ];
}

async function loadRecentReceipts(
  brandId: BrandId,
  limit: number,
): Promise<string> {
  const brandDir = storagePaths.brand(brandId);
  let campaigns: string[];
  try {
    campaigns = await readdir(path.join(brandDir, "campaigns"));
  } catch {
    return "# Recent deliveries\n(none)\n";
  }
  const entries: { campaign: string; receipt: unknown; mtime: number }[] = [];
  for (const c of campaigns) {
    const dir = path.join(brandDir, "campaigns", c, "deliveries");
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const file = path.join(dir, f);
      try {
        const raw = await readFile(file, "utf-8");
        const stat = (await import("node:fs/promises")).stat;
        const s = await stat(file);
        entries.push({
          campaign: c,
          receipt: JSON.parse(raw),
          mtime: s.mtimeMs,
        });
      } catch {
        continue;
      }
    }
  }
  // Sort newest first; truncate to limit. mtime ordering is deterministic
  // on a snapshot of the filesystem — fine for cache-key stability.
  entries.sort((a, b) => b.mtime - a.mtime);
  const slice = entries.slice(0, limit);
  const lines: string[] = [
    `# Recent deliveries — ${slice.length} of ${entries.length} loaded`,
  ];
  for (const e of slice) {
    lines.push(JSON.stringify({ campaign: e.campaign, ...e.receipt as object }));
  }
  return lines.join("\n");
}
