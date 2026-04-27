import { forkVideoSubagent, snapshotForFork } from "../agent/forkVideoSubagent.ts";
import { cronScheduler } from "../cron/scheduler.ts";
import { appendToPerformanceMemory } from "../storage/performanceMemoryWriter.ts";
import type { BrandId } from "../types/video.ts";
import { buildPerformanceAgentContext } from "./buildPerformanceAgentContext.ts";
import {
  checkPerformanceGate,
  saveGateState,
  type PerformanceGateOpts,
} from "./gate.ts";

// Plan §H/§K (T2.4) — PerformanceAgent. Cron-driven, gated on time + new
// datapoints, forked with state isolation, writes capped lines to
// performance_memory.md. Mirrors Claude Code's autoDream shape.

const DEFAULT_GATE_OPTS: PerformanceGateOpts = {
  minIntervalMs: 24 * 60 * 60 * 1000, // 24h
  minNewDatapoints: 20,
};

export interface RunPerformanceAgentOpts {
  readonly brandId: BrandId;
  readonly gate?: PerformanceGateOpts;
  // Injectable consolidator. Default: forkVideoSubagent + JSON parser.
  // Tests pass a fake.
  readonly consolidate?: ConsolidatorFn;
}

export type ConsolidatorFn = (brandId: BrandId) => Promise<readonly string[]>;

export async function runPerformanceAgent(
  opts: RunPerformanceAgentOpts,
): Promise<{
  readonly ran: boolean;
  readonly reason: string;
  readonly linesWritten: number;
}> {
  const decision = await checkPerformanceGate(
    opts.brandId,
    opts.gate ?? DEFAULT_GATE_OPTS,
  );
  if (!decision.shouldRun) {
    return { ran: false, reason: decision.reason, linesWritten: 0 };
  }

  const consolidate = opts.consolidate ?? defaultForkedConsolidator;
  let lines: readonly string[];
  try {
    lines = await consolidate(opts.brandId);
  } catch (e) {
    return {
      ran: false,
      reason: `consolidator threw: ${(e as Error).message}`,
      linesWritten: 0,
    };
  }

  if (lines.length > 0) {
    await appendToPerformanceMemory(opts.brandId, lines);
  }
  await saveGateState(opts.brandId, {
    lastRunAtMs: Date.now(),
    lastReceiptCount: decision.currentReceiptCount,
  });
  return { ran: true, reason: decision.reason, linesWritten: lines.length };
}

const defaultForkedConsolidator: ConsolidatorFn = async (brandId) => {
  const systemBlocks = await buildPerformanceAgentContext(brandId);
  const result = await forkVideoSubagent({
    parentCtx: { brandId, campaignId: "" },
    cacheSafe: snapshotForFork({}),
    role: "performance_agent",
    tools: [], // PerformanceAgent reads receipts via context, no tool calls
    systemBlocks,
    initialMessage:
      "Analyse the recent deliveries in your context. Emit factual " +
      "learnings as instructed in your final JSON response.",
  });
  return parseConsolidatorOutput(result.finalText);
};

interface ConsolidatorOutput {
  readonly lines: readonly string[];
}

export function parseConsolidatorOutput(
  finalText: string,
): readonly string[] {
  const match =
    finalText.match(/```json\s*\n([\s\S]*?)\n```/) ??
    finalText.match(/```\s*\n([\s\S]*?)\n```/);
  const candidate = match?.[1] ?? findFirstObject(finalText);
  if (candidate === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return [];
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as ConsolidatorOutput).lines)
  ) {
    return [];
  }
  return (parsed as ConsolidatorOutput).lines.filter(
    (l) => typeof l === "string" && l.trim().length > 0,
  );
}

function findFirstObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// Cron registration helper. Hosts call this for every brand they want
// the PerformanceAgent to run for.
export function registerPerformanceAgentCron(
  brandId: BrandId,
  schedule = "0 2 * * *", // 02:00 daily
): void {
  cronScheduler.register(
    {
      id: `performance-agent:${brandId}`,
      schedule,
      jitterMs: 30 * 60 * 1000, // ±30min
      lockKey: () => brandId,
      lockTtlMs: 60 * 60 * 1000, // 1h
      run: async () => {
        const r = await runPerformanceAgent({ brandId });
        if (r.ran) {
          console.log(
            `[performance-agent] ${brandId} ran — wrote ${r.linesWritten} lines`,
          );
        } else {
          console.log(
            `[performance-agent] ${brandId} skipped — ${r.reason}`,
          );
        }
      },
    },
    undefined,
  );
}
