import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { TranscriptExtractTool } from "../tools/analysis/TranscriptExtract.ts";
import { runFfmpeg } from "../tools/ffmpeg.ts";
import type { ToolUseContext } from "../Tool.ts";

const TMP = path.join(
  process.env.TMPDIR ?? "/tmp",
  `video-agent-transcript-${Date.now()}`,
);
const SOURCE = path.join(TMP, "jfk-clip.mp4");

const TEST_MODEL = "/opt/homebrew/share/whisper-cpp/for-tests-ggml-tiny.bin";
const TEST_AUDIO = "/opt/homebrew/share/whisper-cpp/jfk.wav";

const ffmpegOk = Bun.which("ffmpeg") !== null;
const whisperOk = Bun.which("whisper-cli") !== null;
const fixturesPresent = existsSync(TEST_MODEL) && existsSync(TEST_AUDIO);
const canRun = ffmpegOk && whisperOk && fixturesPresent;

const ctx: ToolUseContext = {
  agentId: "atest-0000000000000000",
  brandId: "demo-brand",
  campaignId: "demo-campaign",
  abortSignal: new AbortController().signal,
};

describe.skipIf(!canRun)("integration: TranscriptExtract (whisper.cpp)", () => {
  beforeAll(async () => {
    await mkdir(TMP, { recursive: true });
    // Build a real mp4 by combining a synthetic video stream with the
    // bundled jfk.wav audio. TranscriptExtract takes a video file.
    await runFfmpeg(
      [
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=11:size=320x240:rate=15",
        "-i",
        TEST_AUDIO,
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
    process.env.WHISPER_MODEL = TEST_MODEL;
  });

  afterAll(async () => {
    await rm(TMP, { recursive: true, force: true });
    delete process.env.WHISPER_MODEL;
  });

  test("pipeline succeeds: extracts audio, runs whisper, parses JSON, returns shape", async () => {
    const r = await TranscriptExtractTool.call(
      TranscriptExtractTool.validateInput({ source_path: SOURCE }),
      ctx,
    );
    if (!r.ok) throw new Error(r.error);
    // The bundled `for-tests-ggml-tiny.bin` is a 562KB stub model used by
    // whisper.cpp's own CI — it returns 0 transcription entries by design.
    // What we CAN verify with this fixture: the binary ran, JSON parsed,
    // language was detected (whisper does language detection from the audio
    // even when transcription is empty).
    expect(r.output.language.length).toBeGreaterThan(0);
    expect(Array.isArray(r.output.words)).toBe(true);
    // Any words returned must have valid timestamps.
    for (const w of r.output.words) {
      expect(w.start_ms).toBeGreaterThanOrEqual(0);
      expect(w.end_ms).toBeLessThanOrEqual(12_000);
      expect(w.end_ms).toBeGreaterThanOrEqual(w.start_ms);
    }
  }, 60_000);

  // Accuracy-on-content test, gated on TEST_REAL_WHISPER_MODEL pointing at
  // a real production model (e.g. ggml-base.en.bin). Skipped by default
  // because the 562KB stub model produces no transcription. Run manually
  // after `curl -L -o ~/whisper-models/ggml-base.en.bin <hf-url>` and
  // `export TEST_REAL_WHISPER_MODEL=~/whisper-models/ggml-base.en.bin`.
  const haveRealModel =
    process.env.TEST_REAL_WHISPER_MODEL !== undefined &&
    process.env.TEST_REAL_WHISPER_MODEL !== "";
  test.skipIf(!haveRealModel)(
    "real model: detects expected words from JFK clip",
    async () => {
      process.env.WHISPER_MODEL = process.env.TEST_REAL_WHISPER_MODEL!;
      const r = await TranscriptExtractTool.call(
        TranscriptExtractTool.validateInput({ source_path: SOURCE }),
        ctx,
      );
      if (!r.ok) throw new Error(r.error);
      expect(r.output.words.length).toBeGreaterThan(3);
      const allText = r.output.words
        .map((w) => w.text.toLowerCase())
        .join(" ");
      expect(allText).toMatch(/fellow|americans|country/);
      // Reset to the default test model.
      process.env.WHISPER_MODEL = TEST_MODEL;
    },
    60_000,
  );

  test("returns retryable=false when WHISPER_MODEL is unset", async () => {
    const saved = process.env.WHISPER_MODEL;
    delete process.env.WHISPER_MODEL;
    try {
      const r = await TranscriptExtractTool.call(
        TranscriptExtractTool.validateInput({ source_path: SOURCE }),
        ctx,
      );
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("expected failure");
      expect(r.retryable).toBe(false);
      expect(r.error).toContain("WHISPER_MODEL");
    } finally {
      if (saved !== undefined) process.env.WHISPER_MODEL = saved;
    }
  });
});
