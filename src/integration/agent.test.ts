// Opt-in end-to-end test that calls the real Anthropic API. Skipped by
// default unless ANTHROPIC_API_KEY is set AND ffmpeg/ffprobe are on PATH.
//
// What it proves: spawnEditingAgent, with the Phase-1 wiring (ToolSearch,
// ExitPlanMode gate, onRenderComplete compliance hook, recorder), can run
// a single source asset through to at least one rendered variant + a
// persisted batch sidecar. No mocking — the model is the real model.
//
// Cost: a few thousand tokens, depends on how the agent reasons. Run
// manually:
//   ANTHROPIC_API_KEY=... bun test src/integration/agent.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnEditingAgent } from "../agent/spawnEditingAgent.ts";
import { runFfmpeg } from "../tools/ffmpeg.ts";
import { storagePaths } from "../storage/paths.ts";
import type {
  AssetId,
  BrandId,
  CampaignId,
  VariantBatch,
  VariantSpec,
} from "../types/video.ts";

const BRAND = "demo-brand" as BrandId;
const CAMPAIGN = "demo-campaign" as CampaignId;
const ASSET = "demo-asset" as AssetId;

const TMP = path.join(
  process.env.TMPDIR ?? "/tmp",
  `video-agent-agent-int-${Date.now()}`,
);

const haveAll =
  process.env.ANTHROPIC_API_KEY !== undefined &&
  process.env.ANTHROPIC_API_KEY !== "" &&
  Bun.which("ffmpeg") !== null &&
  Bun.which("ffprobe") !== null;

describe.skipIf(!haveAll)(
  "integration: spawnEditingAgent end-to-end",
  () => {
    beforeAll(async () => {
      process.env.VIDEO_AGENT_STORAGE = TMP;
      const assetDir = storagePaths.asset(BRAND, CAMPAIGN, ASSET);
      await mkdir(assetDir, { recursive: true });
      const campaignDir = storagePaths.campaign(BRAND, CAMPAIGN);
      await mkdir(campaignDir, { recursive: true });
      await mkdir(storagePaths.brand(BRAND), { recursive: true });

      // Synthetic source — 15s of testsrc + sine.
      const source = storagePaths.assetSource(BRAND, CAMPAIGN, ASSET);
      await runFfmpeg(
        [
          "-f",
          "lavfi",
          "-i",
          "testsrc=duration=15:size=1280x720:rate=30",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=15",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-shortest",
          source,
        ],
        new AbortController().signal,
      );

      await writeFile(
        storagePaths.assetMetadata(BRAND, CAMPAIGN, ASSET),
        JSON.stringify(
          {
            id: ASSET,
            path: source,
            duration_ms: 15_000,
            resolution: { width: 1280, height: 720 },
            frame_rate: 30,
            has_audio: true,
          },
          null,
          2,
        ),
      );

      // One spec — keeps the run cheap. The agent has to discover analysis
      // tools, plan, get plan-approved, then render.
      const specs: VariantSpec[] = [
        {
          id: "agent-int-tiktok" as VariantSpec["id"],
          platform: "tiktok",
          max_duration_ms: 8_000,
          aspect_ratio: "9:16",
        },
      ];
      await writeFile(
        storagePaths.variantSpecs(BRAND, CAMPAIGN),
        JSON.stringify(specs, null, 2),
      );

      // Empty stubs so the loaders don't synthesise placeholders mid-run.
      await writeFile(storagePaths.guidelines(BRAND), "# brand: demo\n");
      await writeFile(
        storagePaths.performanceMemory(BRAND),
        "# perf memory: empty\n",
      );
      await writeFile(
        storagePaths.campaignBrief(BRAND, CAMPAIGN),
        "# brief: produce one tiktok variant from the source\n",
      );
    });

    afterAll(async () => {
      await rm(TMP, { recursive: true, force: true });
      delete process.env.VIDEO_AGENT_STORAGE;
    });

    test(
      "produces at least one rendered variant + persists batch.json",
      async () => {
        const result = await spawnEditingAgent({
          brandId: BRAND,
          campaignId: CAMPAIGN,
          assetId: ASSET,
        });

        expect(result.task.status).toBe("succeeded");
        expect(result.approvedPlans.length).toBeGreaterThanOrEqual(1);
        expect(result.batch.variants.length).toBeGreaterThanOrEqual(1);

        // Every reported output_path actually exists on disk.
        for (const v of result.batch.variants) {
          expect(existsSync(v.output_path)).toBe(true);
        }

        // batch.json is on disk and parses back to what we got.
        const batchOnDisk = JSON.parse(
          await readFile(result.persistedTo.batchFile, "utf-8"),
        ) as VariantBatch;
        expect(batchOnDisk.source_asset_id).toBe(ASSET);
        expect(batchOnDisk.variants.length).toBe(result.batch.variants.length);

        // Tool-call sanity. ToolSearch is expected at least once (analysis
        // tools are deferred). ExitPlanMode is expected exactly once.
        expect(result.run.toolCallsByName.ToolSearch ?? 0).toBeGreaterThanOrEqual(
          1,
        );
        expect(result.run.toolCallsByName.ExitPlanMode ?? 0).toBe(1);
      },
      // Generous timeout — the model may take a while if it discovers
      // multiple tools and renders take time.
      120_000,
    );
  },
);
