import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { canUseTool } from "./canUseTool.ts";
import type { ComplianceClearance } from "../compliance/ComplianceResult.ts";
import { storagePaths } from "../storage/paths.ts";
import type { Tool, ToolUseContext } from "../Tool.ts";
import type {
  AssetId,
  BrandId,
  CampaignId,
} from "../types/video.ts";

const TMP = path.join(
  process.env.TMPDIR ?? "/tmp",
  `video-agent-canuse-${Date.now()}`,
);

const BRAND = "demo-brand" as BrandId;
const CAMPAIGN = "demo-campaign" as CampaignId;
const ASSET = "demo-asset" as AssetId;
const VARIANT_ID = "v-tiktok-1";

const ctx: ToolUseContext = {
  agentId: "atest-0000000000000000",
  brandId: BRAND,
  campaignId: CAMPAIGN,
  abortSignal: new AbortController().signal,
};

function fakeTool(name: string, readonly: boolean): Tool {
  return {
    name,
    description: "",
    inputSchema: { parse: (x: unknown) => x } as Tool["inputSchema"],
    shouldDefer: false,
    alwaysLoad: true,
    readonly,
    microCompactable: false,
    validateInput: (x: unknown) => x,
    call: async () => ({ ok: true as const, output: undefined }),
  };
}

async function writeClearance(
  variantId: string,
  passed: boolean,
  status: ComplianceClearance["status"],
): Promise<void> {
  const file = storagePaths.variantClearance(BRAND, CAMPAIGN, ASSET, variantId);
  await mkdir(path.dirname(file), { recursive: true });
  const clearance: ComplianceClearance = {
    check_id: "compact_TEST" + variantId,
    asset_path: "/whatever.mp4",
    checked_at_ms: 1700_000_000_000,
    passed,
    auto_fixable: [],
    human_required: [],
    escalateTo: "orchestrator",
    status,
  };
  await writeFile(file, JSON.stringify(clearance), "utf-8");
}

async function writeBudget(total: number, spent: number): Promise<void> {
  const file = storagePaths.brandBudget(BRAND);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ total, spent, currency: "USD" }),
    "utf-8",
  );
}

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  process.env.VIDEO_AGENT_STORAGE = TMP;
});

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
  delete process.env.VIDEO_AGENT_STORAGE;
});

describe("canUseTool — Tier 1 (readonly)", () => {
  test("readonly tools auto-approve", async () => {
    const d = await canUseTool(fakeTool("VideoAnalyse", true), {}, ctx);
    expect(d.action).toBe("allow");
  });

  test("non-readonly non-delivery tools fall through to default-allow", async () => {
    const d = await canUseTool(fakeTool("TrimClip", false), {}, ctx);
    expect(d.action).toBe("allow");
  });
});

describe("canUseTool — Tier 2 (compliance clearance)", () => {
  test("DeliverToAdPlatform denied when input lacks variant_spec_id", async () => {
    const d = await canUseTool(
      fakeTool("DeliverToAdPlatform", false),
      { asset_id: ASSET },
      ctx,
    );
    expect(d.action).toBe("deny");
    if (d.action !== "deny") throw new Error("type narrow");
    expect(d.reason).toContain("variant_spec_id");
  });

  test("DeliverToAdPlatform denied when no clearance file exists", async () => {
    const d = await canUseTool(
      fakeTool("DeliverToAdPlatform", false),
      { variant_spec_id: "v-no-clearance", asset_id: ASSET },
      ctx,
    );
    expect(d.action).toBe("deny");
    if (d.action !== "deny") throw new Error("type narrow");
    expect(d.reason).toContain("no compliance clearance");
  });

  test("DeliverToAdPlatform denied when clearance.passed=false", async () => {
    await writeClearance("v-failed", false, "failed");
    const d = await canUseTool(
      fakeTool("DeliverToAdPlatform", false),
      { variant_spec_id: "v-failed", asset_id: ASSET },
      ctx,
    );
    expect(d.action).toBe("deny");
    if (d.action !== "deny") throw new Error("type narrow");
    expect(d.reason).toContain("did not pass");
  });

  test("DeliverToAdPlatform denied when clearance.status != cleared", async () => {
    await writeClearance("v-auto", true, "auto_fixed");
    const d = await canUseTool(
      fakeTool("DeliverToAdPlatform", false),
      { variant_spec_id: "v-auto", asset_id: ASSET },
      ctx,
    );
    expect(d.action).toBe("deny");
    if (d.action !== "deny") throw new Error("type narrow");
    expect(d.reason).toContain("auto_fixed");
  });

  test("DeliverToAdPlatform allowed when cleared and no budget configured", async () => {
    await writeClearance(VARIANT_ID, true, "cleared");
    const d = await canUseTool(
      fakeTool("DeliverToAdPlatform", false),
      { variant_spec_id: VARIANT_ID, asset_id: ASSET },
      ctx,
    );
    expect(d.action).toBe("allow");
  });
});

describe("canUseTool — Tier 3 (budget)", () => {
  test("within budget: allow", async () => {
    await writeClearance(VARIANT_ID, true, "cleared");
    await writeBudget(1000, 100);
    const d = await canUseTool(
      fakeTool("DeliverToAdPlatform", false),
      {
        variant_spec_id: VARIANT_ID,
        asset_id: ASSET,
        estimated_spend: 50,
      },
      ctx,
    );
    expect(d.action).toBe("allow");
  });

  test("over budget: needs_leader", async () => {
    await writeClearance(VARIANT_ID, true, "cleared");
    await writeBudget(1000, 950);
    const d = await canUseTool(
      fakeTool("DeliverToAdPlatform", false),
      {
        variant_spec_id: VARIANT_ID,
        asset_id: ASSET,
        estimated_spend: 100,
      },
      ctx,
    );
    expect(d.action).toBe("needs_leader");
    if (d.action !== "needs_leader") throw new Error("type narrow");
    expect(d.reason).toContain("budget");
    expect(d.escalateTo).toBe("orchestrator");
  });

  test("zero estimated_spend always allowed when budget configured", async () => {
    await writeClearance(VARIANT_ID, true, "cleared");
    await writeBudget(100, 100);
    const d = await canUseTool(
      fakeTool("DeliverToAdPlatform", false),
      {
        variant_spec_id: VARIANT_ID,
        asset_id: ASSET,
        // no estimated_spend
      },
      ctx,
    );
    expect(d.action).toBe("allow");
  });
});
