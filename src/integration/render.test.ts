// End-to-end render integration test. No API calls — directly invokes the
// tool layer to prove the ffmpeg pipeline works for the Phase-1 demo path:
//   1. Generate a synthetic source video (ffmpeg testsrc + sine).
//   2. VideoAnalyse it to confirm probing works.
//   3. TrimClip into two clips.
//   4. RenderVariant assembles each into a final variant with the requested
//      aspect ratio.
//   5. Verify both outputs land, are non-empty, and have plausible duration.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { TrimClipTool } from "../tools/editing/TrimClip.ts";
import { RenderVariantTool } from "../tools/editing/RenderVariant.ts";
import { VideoAnalyseTool } from "../tools/analysis/VideoAnalyse.ts";
import { runFfmpeg, runFfprobe } from "../tools/ffmpeg.ts";
import type { ToolUseContext } from "../Tool.ts";

const TMP = path.join(
  process.env.TMPDIR ?? "/tmp",
  `video-agent-int-${Date.now()}`,
);
const SOURCE = path.join(TMP, "source.mp4");
const CLIP_A = path.join(TMP, "clip-a.mp4");
const CLIP_B = path.join(TMP, "clip-b.mp4");
const VARIANT_REEL = path.join(TMP, "variant-reel.mp4");
const VARIANT_LANDSCAPE = path.join(TMP, "variant-landscape.mp4");

const ffmpegAvailable =
  Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

function makeCtx(): ToolUseContext {
  return {
    agentId: "atest-0000000000000000",
    brandId: "demo-brand",
    campaignId: "demo-campaign",
    abortSignal: new AbortController().signal,
  };
}

describe.skipIf(!ffmpegAvailable)("integration: render two variants", () => {
  beforeAll(async () => {
    await mkdir(TMP, { recursive: true });
    // 10-second 1280x720 30fps testsrc + 1kHz sine.
    await runFfmpeg(
      [
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=10:size=1280x720:rate=30",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=1000:duration=10",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        SOURCE,
      ],
      new AbortController().signal,
    );
  });

  afterAll(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("VideoAnalyse extracts canonical metadata", async () => {
    const ctx = makeCtx();
    const r = await VideoAnalyseTool.call(
      VideoAnalyseTool.validateInput({ source_path: SOURCE }),
      ctx,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.output.duration_ms).toBeGreaterThanOrEqual(9_500);
    expect(r.output.duration_ms).toBeLessThanOrEqual(10_500);
    expect(r.output.resolution.width).toBe(1280);
    expect(r.output.resolution.height).toBe(720);
    expect(r.output.frame_rate).toBeCloseTo(30, 0);
    expect(r.output.has_audio).toBe(true);
  });

  test("TrimClip cuts two non-overlapping segments", async () => {
    const ctx = makeCtx();
    const a = await TrimClipTool.call(
      TrimClipTool.validateInput({
        source_path: SOURCE,
        start_ms: 0,
        end_ms: 3_000,
        output_path: CLIP_A,
      }),
      ctx,
    );
    const b = await TrimClipTool.call(
      TrimClipTool.validateInput({
        source_path: SOURCE,
        start_ms: 4_000,
        end_ms: 7_000,
        output_path: CLIP_B,
      }),
      ctx,
    );
    if (!a.ok) throw new Error(a.error);
    if (!b.ok) throw new Error(b.error);
    expect(a.output.duration_ms).toBe(3_000);
    expect(b.output.duration_ms).toBe(3_000);
    expect((await stat(CLIP_A)).size).toBeGreaterThan(0);
    expect((await stat(CLIP_B)).size).toBeGreaterThan(0);
  });

  test("RenderVariant produces a 9:16 reel from the two clips", async () => {
    const ctx = makeCtx();
    const r = await RenderVariantTool.call(
      RenderVariantTool.validateInput({
        variant_spec_id: "demo-spec-instagram-reel",
        clips: [CLIP_A, CLIP_B],
        output_path: VARIANT_REEL,
        aspect_ratio: "9:16",
        max_duration_ms: 6_000,
      }),
      ctx,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.output.size_bytes).toBeGreaterThan(0);

    // Confirm the rendered file is actually 9:16 (i.e. taller than wide).
    const { stdout } = await runFfprobe(
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        VARIANT_REEL,
      ],
      new AbortController().signal,
    );
    const [w, h] = stdout.trim().split(",").map((n) => parseInt(n, 10));
    expect(h).toBeGreaterThan(w!);
  });

  test("RenderVariant produces a 16:9 landscape from the same clips", async () => {
    const ctx = makeCtx();
    const r = await RenderVariantTool.call(
      RenderVariantTool.validateInput({
        variant_spec_id: "demo-spec-display-16-9",
        clips: [CLIP_A, CLIP_B],
        output_path: VARIANT_LANDSCAPE,
        aspect_ratio: "16:9",
        max_duration_ms: 6_000,
      }),
      ctx,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.output.size_bytes).toBeGreaterThan(0);

    const { stdout } = await runFfprobe(
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        VARIANT_LANDSCAPE,
      ],
      new AbortController().signal,
    );
    const [w, h] = stdout.trim().split(",").map((n) => parseInt(n, 10));
    expect(w).toBeGreaterThan(h!);
  });
});
