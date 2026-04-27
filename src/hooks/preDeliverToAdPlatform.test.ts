import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { preDeliverToAdPlatform } from "./preDeliverToAdPlatform.ts";
import type { ComplianceClearance } from "../compliance/ComplianceResult.ts";
import { storagePaths } from "../storage/paths.ts";
import type { ToolUseContext } from "../Tool.ts";
import type {
  AssetId,
  BrandId,
  CampaignId,
} from "../types/video.ts";

const TMP = path.join(
  process.env.TMPDIR ?? "/tmp",
  `video-agent-predeliver-${Date.now()}`,
);

const BRAND = "demo-brand" as BrandId;
const CAMPAIGN = "demo-campaign" as CampaignId;
const ASSET = "demo-asset" as AssetId;
const VARIANT = "v-tiktok-1";

const ctx: ToolUseContext = {
  agentId: "atest-0000000000000000",
  brandId: BRAND,
  campaignId: CAMPAIGN,
  abortSignal: new AbortController().signal,
};

async function writeClearance(checkedAtMs: number): Promise<void> {
  const file = storagePaths.variantClearance(BRAND, CAMPAIGN, ASSET, VARIANT);
  await mkdir(path.dirname(file), { recursive: true });
  const c: ComplianceClearance = {
    check_id: "test",
    asset_path: "/x.mp4",
    checked_at_ms: checkedAtMs,
    passed: true,
    auto_fixable: [],
    human_required: [],
    escalateTo: "orchestrator",
    status: "cleared",
  };
  await writeFile(file, JSON.stringify(c));
}

async function writeGuidelines(mtimeMs: number): Promise<void> {
  const file = storagePaths.guidelines(BRAND);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "# Acme Co Brand Guidelines\n");
  // Set a specific mtime so freshness comparisons are deterministic.
  await utimes(file, mtimeMs / 1000, mtimeMs / 1000);
}

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  process.env.VIDEO_AGENT_STORAGE = TMP;
});
afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
  delete process.env.VIDEO_AGENT_STORAGE;
});
afterEach(async () => {
  await rm(path.join(TMP, "brand"), { recursive: true, force: true });
});

describe("preDeliverToAdPlatform", () => {
  test("non-DeliverToAdPlatform tool: continue", async () => {
    const d = await preDeliverToAdPlatform(
      "TrimClip",
      { variant_spec_id: VARIANT, asset_id: ASSET },
      ctx,
    );
    expect(d.action).toBe("continue");
  });

  test("missing clearance: block", async () => {
    const d = await preDeliverToAdPlatform(
      "DeliverToAdPlatform",
      { variant_spec_id: VARIANT, asset_id: ASSET },
      ctx,
    );
    expect(d.action).toBe("block");
    if (d.action !== "block") throw new Error("type narrow");
    expect(d.reason).toContain("missing");
  });

  test("clearance present and fresh: continue", async () => {
    await writeClearance(2_000_000_000_000);
    await writeGuidelines(1_000_000_000_000); // older than clearance
    const d = await preDeliverToAdPlatform(
      "DeliverToAdPlatform",
      { variant_spec_id: VARIANT, asset_id: ASSET },
      ctx,
    );
    expect(d.action).toBe("continue");
  });

  test("guidelines updated after clearance: block as stale", async () => {
    await writeClearance(1_000_000_000_000);
    await writeGuidelines(2_000_000_000_000); // newer than clearance
    const d = await preDeliverToAdPlatform(
      "DeliverToAdPlatform",
      { variant_spec_id: VARIANT, asset_id: ASSET },
      ctx,
    );
    expect(d.action).toBe("block");
    if (d.action !== "block") throw new Error("type narrow");
    expect(d.reason).toContain("stale");
  });

  test("missing variant_spec_id in input: block with explanation", async () => {
    const d = await preDeliverToAdPlatform(
      "DeliverToAdPlatform",
      { asset_id: ASSET },
      ctx,
    );
    expect(d.action).toBe("block");
    if (d.action !== "block") throw new Error("type narrow");
    expect(d.reason).toContain("variant_spec_id");
  });

  test("clearance with passed=false: block", async () => {
    const file = storagePaths.variantClearance(BRAND, CAMPAIGN, ASSET, VARIANT);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        check_id: "x",
        asset_path: "/x.mp4",
        checked_at_ms: 1_000_000_000_000,
        passed: false,
        auto_fixable: [],
        human_required: [],
        escalateTo: "orchestrator",
        status: "failed",
      }),
    );
    const d = await preDeliverToAdPlatform(
      "DeliverToAdPlatform",
      { variant_spec_id: VARIANT, asset_id: ASSET },
      ctx,
    );
    expect(d.action).toBe("block");
  });
});
