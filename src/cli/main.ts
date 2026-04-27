// Phase 1 entrypoint. Three modes:
//   bun run dev                  — dry run: assemble context + tool params, print, exit
//   bun run dev -- --prep        — generate a synthetic source.mp4 at the demo asset path
//   bun run dev -- --execute     — call Claude with the editing brief (needs ANTHROPIC_API_KEY)
//
// Typical first-time flow:
//   bun run dev -- --prep && export ANTHROPIC_API_KEY=… && bun run dev -- --execute

import { existsSync } from "node:fs";
import { editingAgentCompactStrategy } from "../compact/CompactStrategy.ts";
import { buildEditingAgentContext } from "../context/buildEditingAgentContext.ts";
import { spawnEditingAgent } from "../agent/spawnEditingAgent.ts";
import { storagePaths } from "../storage/paths.ts";
import { runFfmpeg } from "../tools/ffmpeg.ts";
import { editingAgentTools } from "../tools/registry.ts";
import {
  deferredTools,
  loadedToolsForTurn1,
} from "../Tool.ts";
import type {
  AssetId,
  BrandId,
  CampaignId,
} from "../types/video.ts";
import { createCliRenderer } from "../ui/cli.ts";

const BRAND = "demo-brand" as BrandId;
const CAMPAIGN = "demo-campaign" as CampaignId;
const ASSET = "demo-asset" as AssetId;

async function main(): Promise<void> {
  if (process.argv.includes("--prep")) {
    await prep();
    return;
  }

  const execute = process.argv.includes("--execute");

  if (!execute) {
    await dryRun();
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY not set. Run without --execute for a dry run.",
    );
    process.exit(1);
  }

  const sourcePath = storagePaths.assetSource(BRAND, CAMPAIGN, ASSET);
  if (!existsSync(sourcePath)) {
    console.error(
      `Source video missing: ${sourcePath}\nRun \`bun run dev -- --prep\` first to generate a synthetic source.mp4.`,
    );
    process.exit(1);
  }

  const ui = createCliRenderer();
  ui.banner(
    "EditingAgent",
    `${BRAND} / ${CAMPAIGN} / ${ASSET}`,
  );

  const startedAt = Date.now();
  let result: Awaited<ReturnType<typeof spawnEditingAgent>>;
  try {
    result = await spawnEditingAgent({
      brandId: BRAND,
      campaignId: CAMPAIGN,
      assetId: ASSET,
      ui,
    });
  } catch (e) {
    ui.fail(e as Error);
    process.exit(1);
  }

  ui.finish({
    agentId: result.task.id,
    status: result.task.status,
    iterations: result.run.iterations,
    elapsedMs: Date.now() - startedAt,
    tokens: {
      input: result.run.totalUsage.input_tokens,
      output: result.run.totalUsage.output_tokens,
      cacheRead: result.run.totalUsage.cache_read_input_tokens,
      cacheCreation: result.run.totalUsage.cache_creation_input_tokens,
    },
    toolCallsByName: result.run.toolCallsByName,
    extras: {
      "Approved plans": result.approvedPlans.length,
      "Rendered variants":
        result.run.toolCallsByName.RenderVariant ?? 0,
      "Batch file": result.persistedTo.batchFile,
    },
  });
}

async function prep(): Promise<void> {
  const sourcePath = storagePaths.assetSource(BRAND, CAMPAIGN, ASSET);
  if (existsSync(sourcePath)) {
    console.log(`Source already exists at ${sourcePath} — nothing to do.`);
    return;
  }

  const { mkdir } = await import("node:fs/promises");
  await mkdir(
    storagePaths.asset(BRAND, CAMPAIGN, ASSET),
    { recursive: true },
  );

  console.log(`Generating synthetic source video → ${sourcePath}`);
  await runFfmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=30:size=1920x1080:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=30",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      sourcePath,
    ],
    new AbortController().signal,
  );
  console.log("Done. Now run: bun run dev -- --execute");
}

async function dryRun(): Promise<void> {
  console.log("=== Dry run ===\n");

  console.log("Compaction strategy:", editingAgentCompactStrategy);

  const blocks = await buildEditingAgentContext(BRAND, CAMPAIGN, ASSET);
  console.log(`\nContext: ${blocks.length} blocks`);
  for (const b of blocks) {
    const bytes = Buffer.byteLength(b.content, "utf-8");
    console.log(`  [${b.kind}] ${b.source} — ${bytes} bytes`);
  }

  const turn1 = loadedToolsForTurn1(editingAgentTools);
  const deferred = deferredTools(editingAgentTools);
  console.log(
    `\nTools: ${editingAgentTools.length} total — turn-1 loaded: ${turn1.length}, deferred: ${deferred.length}`,
  );
  for (const t of editingAgentTools) {
    const flags = t.shouldDefer
      ? "deferred"
      : t.alwaysLoad
        ? "always-load"
        : "default";
    console.log(`  ${t.name.padEnd(20)} ${flags.padEnd(12)} ${t.description.slice(0, 60)}…`);
  }

  console.log(
    "\nNo API call made. Set ANTHROPIC_API_KEY and pass --execute to run a real EditingAgent loop.",
  );
}

await main();
