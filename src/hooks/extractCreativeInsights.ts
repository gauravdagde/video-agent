import { appendToPerformanceMemory } from "../storage/performanceMemoryWriter.ts";
import type { BrandId } from "../types/video.ts";
import type { HookDecision, PostToolUseHook } from "./types.ts";

// Plan §K (T2.3) — post-delivery insight extraction. Fires AFTER a
// successful DeliverToAdPlatform call. Forked subagent reads the batch
// + metrics (when metrics are wired) and appends factual learnings to
// performance_memory.md. NOT a stop-hook — agents stop for many reasons,
// and we'd get noise insights every time.
//
// Phase-1 scope: hook fires on every successful delivery. The "initial
// metrics" gate is deferred until there's a metrics source. The default
// insight extractor records the delivery as a placeholder learning;
// callers can swap in a forked-subagent extractor when richer signals
// land.

interface DeliveryResult {
  readonly receipt_id: string;
  readonly platform: string;
  readonly status: "submitted";
  readonly submitted_at_ms: number;
}

interface DeliveryInput {
  readonly variant_spec_id?: string;
  readonly asset_id?: string;
  readonly compliance_check_id?: string;
  readonly estimated_spend?: number;
}

export interface InsightExtractionContext {
  readonly brandId: string;
  readonly campaignId: string;
  readonly receipt: DeliveryResult;
  readonly input: DeliveryInput;
}

export type InsightExtractor = (
  ctx: InsightExtractionContext,
) => Promise<readonly string[]>;

// Default extractor — records the delivery event itself as the learning.
// Replace with a forkVideoSubagent-backed extractor once metrics arrive.
export const defaultInsightExtractor: InsightExtractor = async (ctx) => [
  `- delivered ${ctx.input.variant_spec_id ?? "?"} (asset ${ctx.input.asset_id ?? "?"}) to ${ctx.receipt.platform} — receipt ${ctx.receipt.receipt_id}`,
];

export function buildExtractCreativeInsights(
  extract: InsightExtractor = defaultInsightExtractor,
): PostToolUseHook {
  return async (toolName, input, output, ctx): Promise<HookDecision> => {
    if (toolName !== "DeliverToAdPlatform") return { action: "continue" };
    const r = output as DeliveryResult;
    if (r.status !== "submitted") return { action: "continue" };

    try {
      const lines = await extract({
        brandId: ctx.brandId,
        campaignId: ctx.campaignId,
        receipt: r,
        input: input as DeliveryInput,
      });
      if (lines.length > 0) {
        await appendToPerformanceMemory(ctx.brandId as BrandId, lines);
      }
    } catch (e) {
      // Extraction failure must NOT block delivery — the receipt is real
      // even if our learning pipeline broke. Log and continue.
      console.warn(
        `[extractCreativeInsights] extraction failed: ${(e as Error).message}`,
      );
    }
    return { action: "continue" };
  };
}

export const extractCreativeInsights: PostToolUseHook =
  buildExtractCreativeInsights();
