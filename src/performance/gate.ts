import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { storagePaths } from "../storage/paths.ts";
import type { BrandId, CampaignId } from "../types/video.ts";

// Plan §H corrected — the PerformanceAgent gate is on TIME + NEW DATAPOINTS,
// not impression volume. Volume gates produce no signal in the first 24h
// because most variants haven't crossed any meaningful threshold yet.
//
// We track (lastRunAtMs, lastSeenReceiptCount) per brand in a tiny state
// file. Gate passes only when BOTH the minimum interval has elapsed AND
// the new-datapoint threshold is met.

export interface PerformanceGateState {
  readonly lastRunAtMs: number;
  readonly lastReceiptCount: number;
}

const DEFAULT_STATE: PerformanceGateState = {
  lastRunAtMs: 0,
  lastReceiptCount: 0,
};

function gateStatePath(brandId: BrandId): string {
  return path.join(
    process.env.VIDEO_AGENT_STORAGE ?? "./storage",
    "brand",
    brandId,
    "performance_gate.json",
  );
}

export async function loadGateState(
  brandId: BrandId,
): Promise<PerformanceGateState> {
  try {
    const raw = await readFile(gateStatePath(brandId), "utf-8");
    return JSON.parse(raw) as PerformanceGateState;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_STATE;
    throw e;
  }
}

export async function saveGateState(
  brandId: BrandId,
  state: PerformanceGateState,
): Promise<void> {
  const file = gateStatePath(brandId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2), "utf-8");
}

// Count delivery receipts across all campaigns for a brand. Phase-1
// proxy for "datapoints" — every delivered variant is one datapoint.
// Production would weight by impression count or similar.
export async function countDeliveryReceipts(
  brandId: BrandId,
): Promise<number> {
  const brandDir = storagePaths.brand(brandId);
  let count = 0;
  let entries: string[];
  try {
    entries = await readdir(path.join(brandDir, "campaigns"));
  } catch {
    return 0;
  }
  for (const c of entries) {
    const dir = path.join(brandDir, "campaigns", c, "deliveries");
    try {
      const items = await readdir(dir);
      count += items.filter((f) => f.endsWith(".json")).length;
    } catch {
      continue;
    }
  }
  return count;
}

export interface PerformanceGateOpts {
  readonly minIntervalMs: number;
  readonly minNewDatapoints: number;
}

export interface PerformanceGateDecision {
  readonly shouldRun: boolean;
  readonly reason: string;
  readonly currentReceiptCount: number;
  readonly state: PerformanceGateState;
}

export async function checkPerformanceGate(
  brandId: BrandId,
  opts: PerformanceGateOpts,
): Promise<PerformanceGateDecision> {
  const state = await loadGateState(brandId);
  const now = Date.now();
  const elapsed = now - state.lastRunAtMs;
  if (elapsed < opts.minIntervalMs) {
    return {
      shouldRun: false,
      reason: `interval not met: ${elapsed}ms < ${opts.minIntervalMs}ms`,
      currentReceiptCount: state.lastReceiptCount,
      state,
    };
  }
  const current = await countDeliveryReceipts(brandId);
  const delta = current - state.lastReceiptCount;
  if (delta < opts.minNewDatapoints) {
    return {
      shouldRun: false,
      reason: `not enough new datapoints: ${delta} < ${opts.minNewDatapoints}`,
      currentReceiptCount: current,
      state,
    };
  }
  return {
    shouldRun: true,
    reason: `interval ok (${elapsed}ms) and ${delta} new datapoint(s)`,
    currentReceiptCount: current,
    state,
  };
}

// Touched intentionally so collateral imports (e.g. cron registration)
// can find the path without re-implementing it.
export { gateStatePath as _gateStatePathForTest };
export type { CampaignId };
