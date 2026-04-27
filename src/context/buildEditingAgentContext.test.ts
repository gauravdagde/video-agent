import { describe, expect, test } from "bun:test";
import { buildEditingAgentContext } from "./buildEditingAgentContext.ts";
import type {
  AssetId,
  BrandId,
  CampaignId,
} from "../types/video.ts";

const BRAND = "demo-brand" as BrandId;
const CAMPAIGN = "demo-campaign" as CampaignId;
const ASSET = "demo-asset" as AssetId;

describe("buildEditingAgentContext", () => {
  test("returns six layers in plan order", async () => {
    const blocks = await buildEditingAgentContext(BRAND, CAMPAIGN, ASSET);
    expect(blocks.map((b) => b.source)).toEqual([
      "agent_identity",
      "brand_guidelines",
      "campaign_rules",
      "performance_memory",
      "asset_metadata",
      "variant_specs",
    ]);
  });

  test("stable layers come before dynamic layers", async () => {
    const blocks = await buildEditingAgentContext(BRAND, CAMPAIGN, ASSET);
    const firstDynamic = blocks.findIndex((b) => b.kind === "dynamic");
    const lastStable = blocks.map((b) => b.kind).lastIndexOf("stable");
    expect(lastStable).toBeLessThan(firstDynamic);
  });

  // §I — the cache-stability invariant. Two builds with identical inputs
  // must produce byte-for-byte identical content. If this ever fails, the
  // prompt cache will miss on every run and unit economics break.
  test("is byte-deterministic across builds for identical inputs", async () => {
    const a = await buildEditingAgentContext(BRAND, CAMPAIGN, ASSET);
    const b = await buildEditingAgentContext(BRAND, CAMPAIGN, ASSET);
    expect(a).toEqual(b);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.content).toBe(b[i]!.content);
    }
  });
});
