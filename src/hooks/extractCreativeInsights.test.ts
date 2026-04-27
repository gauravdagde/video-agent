import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  buildExtractCreativeInsights,
  defaultInsightExtractor,
} from "./extractCreativeInsights.ts";
import { storagePaths } from "../storage/paths.ts";
import type { ToolUseContext } from "../Tool.ts";
import type { BrandId } from "../types/video.ts";

const TMP = path.join(
  process.env.TMPDIR ?? "/tmp",
  `video-agent-insights-${Date.now()}`,
);
const BRAND = "demo-brand" as BrandId;

const ctx: ToolUseContext = {
  agentId: "atest-0000000000000000",
  brandId: BRAND,
  campaignId: "demo-campaign",
  abortSignal: new AbortController().signal,
};

const sampleReceipt = {
  receipt_id: "mock_TEST",
  platform: "tiktok",
  status: "submitted" as const,
  submitted_at_ms: 1700_000_000_000,
};

const sampleInput = {
  variant_spec_id: "v-tiktok-1",
  asset_id: "a1",
  platform: "tiktok",
  output_path: "/x.mp4",
};

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

describe("extractCreativeInsights", () => {
  test("non-DeliverToAdPlatform tool: continue, no write", async () => {
    const hook = buildExtractCreativeInsights();
    const d = await hook("TrimClip", sampleInput, sampleReceipt, ctx);
    expect(d.action).toBe("continue");
  });

  test("appends a line to performance_memory.md on successful delivery", async () => {
    const hook = buildExtractCreativeInsights();
    const d = await hook(
      "DeliverToAdPlatform",
      sampleInput,
      sampleReceipt,
      ctx,
    );
    expect(d.action).toBe("continue");
    const file = storagePaths.performanceMemory(BRAND);
    const content = await readFile(file, "utf-8");
    expect(content).toContain("v-tiktok-1");
    expect(content).toContain("tiktok");
    expect(content).toContain("mock_TEST");
  });

  test("custom extractor sees ctx and produces multiple lines", async () => {
    const hook = buildExtractCreativeInsights(async (extractCtx) => [
      `- platform: ${extractCtx.receipt.platform}`,
      `- variant: ${extractCtx.input.variant_spec_id}`,
      `- brand: ${extractCtx.brandId}`,
    ]);
    await hook("DeliverToAdPlatform", sampleInput, sampleReceipt, ctx);
    const content = await readFile(
      storagePaths.performanceMemory(BRAND),
      "utf-8",
    );
    expect(content).toContain("- platform: tiktok");
    expect(content).toContain("- variant: v-tiktok-1");
    expect(content).toContain("- brand: demo-brand");
  });

  test("extractor that throws does not break the hook chain", async () => {
    const hook = buildExtractCreativeInsights(async () => {
      throw new Error("LLM melted");
    });
    const d = await hook(
      "DeliverToAdPlatform",
      sampleInput,
      sampleReceipt,
      ctx,
    );
    expect(d.action).toBe("continue");
  });

  test("non-submitted status: skipped (delivery wasn't actually accepted)", async () => {
    const hook = buildExtractCreativeInsights();
    await hook(
      "DeliverToAdPlatform",
      sampleInput,
      { ...sampleReceipt, status: "failed" },
      ctx,
    );
    // No file written.
    const file = storagePaths.performanceMemory(BRAND);
    let exists = true;
    try {
      await readFile(file, "utf-8");
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test("default extractor returns one summary line", async () => {
    const lines = await defaultInsightExtractor({
      brandId: BRAND,
      campaignId: "demo-campaign",
      receipt: sampleReceipt,
      input: sampleInput,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("delivered");
  });
});
