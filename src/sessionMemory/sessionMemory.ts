import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { storagePaths } from "../storage/paths.ts";
import type {
  BrandId,
  CampaignId,
} from "../types/video.ts";

// Plan §L — per-session forked-subagent scratchpad. Distinct from MEMORY.md
// (durable, cross-session) and performance_memory.md (durable, brand-scoped).
// SessionMemory is per-session notes a forked subagent maintains during the
// session: which variants were tried, which platforms rate-limited today,
// which approval the human just gave 5 minutes ago. Not persisted across
// campaigns.
//
// Capping: same shape as performance_memory (200 lines / 25KB) so the
// dynamic-layer hygiene from §I holds when this layer enters the prompt.

export const MAX_SESSION_LINES = 200;
export const MAX_SESSION_BYTES = 25_000;

const EMPTY_TEMPLATE = (sessionId: string): string =>
  `# Session memory: ${sessionId}\n# Lines: 0 / ${MAX_SESSION_LINES} max\n(no observations yet)\n`;

export async function loadSessionMemory(
  brandId: BrandId,
  campaignId: CampaignId,
  sessionId: string,
): Promise<string> {
  const file = storagePaths.sessionMemory(brandId, campaignId, sessionId);
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_TEMPLATE(sessionId);
    }
    throw e;
  }
  // Apply caps on read so a stale oversized file doesn't bust the prompt
  // cache key.
  let trimmed = raw.split("\n").slice(0, MAX_SESSION_LINES).join("\n");
  if (Buffer.byteLength(trimmed, "utf-8") > MAX_SESSION_BYTES) {
    trimmed = trimmed.slice(0, MAX_SESSION_BYTES);
  }
  return trimmed;
}

export type SessionMemoryUpdater = (
  current: string,
  observations: readonly string[],
) => Promise<string>;

// Atomic in-place rewrite. Caller passes an updater (typically a forked-
// subagent call) that transforms the current content + new observations
// into the new content. We cap-enforce on write and rename atomically so
// readers never see a half-written file.
export async function updateSessionMemory(
  brandId: BrandId,
  campaignId: CampaignId,
  sessionId: string,
  observations: readonly string[],
  updater: SessionMemoryUpdater,
): Promise<{ readonly path: string; readonly bytes: number }> {
  const file = storagePaths.sessionMemory(brandId, campaignId, sessionId);
  await mkdir(path.dirname(file), { recursive: true });

  const current = await loadSessionMemory(brandId, campaignId, sessionId);
  const next = await updater(current, observations);

  // Cap before write — caller-provided updater might exceed.
  let capped = next.split("\n").slice(0, MAX_SESSION_LINES).join("\n");
  if (Buffer.byteLength(capped, "utf-8") > MAX_SESSION_BYTES) {
    capped = capped.slice(0, MAX_SESSION_BYTES);
  }

  const tmpPath = `${file}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, capped, "utf-8");
  await rename(tmpPath, file);

  return { path: file, bytes: Buffer.byteLength(capped, "utf-8") };
}
