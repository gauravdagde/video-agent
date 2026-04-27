import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { ExtractFramesTool } from "../compliance/tools/ExtractFrames.ts";
import { runFfmpeg } from "../tools/ffmpeg.ts";
import type { ToolUseContext } from "../Tool.ts";

const TMP = path.join(
  process.env.TMPDIR ?? "/tmp",
  `video-agent-extract-${Date.now()}`,
);
const SOURCE = path.join(TMP, "source.mp4");

const ffmpegAvailable =
  Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

const ctx: ToolUseContext = {
  agentId: "atest-0000000000000000",
  brandId: "demo-brand",
  campaignId: "demo-campaign",
  abortSignal: new AbortController().signal,
};

describe.skipIf(!ffmpegAvailable)("integration: ExtractFrames", () => {
  beforeAll(async () => {
    await mkdir(TMP, { recursive: true });
    await runFfmpeg(
      [
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=8:size=640x360:rate=30",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        SOURCE,
      ],
      new AbortController().signal,
    );
  });

  afterAll(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("extracts the requested number of frames as PNGs and inline images", async () => {
    const r = await ExtractFramesTool.call(
      ExtractFramesTool.validateInput({
        source_path: SOURCE,
        num_frames: 4,
      }),
      ctx,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.output.frames).toHaveLength(4);
    for (const f of r.output.frames) {
      expect(existsSync(f.file_path)).toBe(true);
      expect(f.timestamp_ms).toBeGreaterThan(0);
      expect(f.timestamp_ms).toBeLessThan(8000);
    }
    // multipart: 1 text + 4 image blocks
    expect(r.multipart).toBeDefined();
    expect(r.multipart!.length).toBe(5);
    expect(r.multipart![0]!.type).toBe("text");
    for (let i = 1; i < r.multipart!.length; i++) {
      const block = r.multipart![i]!;
      expect(block.type).toBe("image");
      if (block.type !== "image") throw new Error("type narrow");
      if (block.source.type !== "base64") throw new Error("expected base64");
      expect(block.source.media_type).toBe("image/png");
      expect(block.source.data.length).toBeGreaterThan(100);
    }
    // Cleanup the temp dir for this run.
    const tmpDir = path.dirname(r.output.frames[0]!.file_path);
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("respects num_frames=1 and PNG default", async () => {
    const r = await ExtractFramesTool.call(
      ExtractFramesTool.validateInput({
        source_path: SOURCE,
        num_frames: 1,
      }),
      ctx,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.output.frames).toHaveLength(1);
    const tmpDir = path.dirname(r.output.frames[0]!.file_path);
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns retryable=false on a missing source", async () => {
    const r = await ExtractFramesTool.call(
      ExtractFramesTool.validateInput({
        source_path: "/nonexistent/path/source.mp4",
        num_frames: 2,
      }),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.retryable).toBe(false);
  });
});
