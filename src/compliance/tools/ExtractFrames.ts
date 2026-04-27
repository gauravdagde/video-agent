import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolResultContent, ToolUseContext } from "../../Tool.ts";
import { runFfmpeg, runFfprobe } from "../../tools/ffmpeg.ts";

// ExtractFrames samples N frames evenly across the source duration and
// returns them as inline image blocks the model can see. Used by
// ComplianceAgent to inspect rendered output for logo placement, colour,
// typography, and platform-spec compliance.
//
// Defaults to 4 frames — enough to spot most issues without exploding
// token costs (each image is ~1k tokens at default size).
const Input = z.object({
  source_path: z.string(),
  num_frames: z.number().int().min(1).max(12).default(4),
  // PNG output preserves crisp text/logos; JPEG would be smaller but lossy.
  format: z.enum(["png", "jpeg"]).default("png"),
});

const Output = z.object({
  frames: z.array(
    z.object({
      timestamp_ms: z.number(),
      file_path: z.string(),
    }),
  ),
});

type In = z.infer<typeof Input>;
type Out = z.infer<typeof Output>;

export const ExtractFramesTool: Tool<In, Out> = {
  name: "ExtractFrames",
  description:
    "Sample N evenly-spaced frames from a video and return them as inline " +
    "images you can see directly. Use this BEFORE making any compliance " +
    "judgement — you cannot reason about visual compliance without seeing " +
    "the actual pixels.",
  inputSchema: Input,
  shouldDefer: false,
  alwaysLoad: true,
  readonly: true,
  microCompactable: false,

  validateInput(input: unknown): In {
    return Input.parse(input);
  },

  async call(input: In, ctx: ToolUseContext) {
    let durationMs: number;
    try {
      durationMs = await getDurationMs(input.source_path, ctx.abortSignal);
    } catch (e) {
      return {
        ok: false as const,
        error: `ffprobe failed: ${(e as Error).message}`,
        retryable: false,
      };
    }
    if (durationMs <= 0) {
      return {
        ok: false as const,
        error: `source has no duration: ${input.source_path}`,
        retryable: false,
      };
    }

    const tmpDir = path.join(
      process.env.TMPDIR ?? "/tmp",
      `extract-frames-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await mkdir(tmpDir, { recursive: true });

    try {
      const timestamps = pickTimestamps(durationMs, input.num_frames);
      const frames = await Promise.all(
        timestamps.map(async (tsMs, i) => {
          const file = path.join(tmpDir, `frame-${i}.${input.format}`);
          await runFfmpeg(
            [
              "-ss",
              (tsMs / 1000).toFixed(3),
              "-i",
              input.source_path,
              "-frames:v",
              "1",
              "-q:v",
              "2",
              file,
            ],
            ctx.abortSignal,
          );
          return { timestamp_ms: tsMs, file_path: file };
        }),
      );

      const multipart: ToolResultContent[] = [
        {
          type: "text",
          text: `Extracted ${frames.length} frame(s) at timestamps (ms): ${frames.map((f) => f.timestamp_ms).join(", ")}.`,
        },
      ];
      for (const f of frames) {
        const bytes = await readFile(f.file_path);
        multipart.push({
          type: "image",
          source: {
            type: "base64",
            media_type:
              input.format === "png" ? "image/png" : "image/jpeg",
            data: bytes.toString("base64"),
          },
        });
      }

      return {
        ok: true as const,
        output: { frames } satisfies Out,
        multipart,
      };
    } catch (e) {
      // Clean up partial extraction on failure.
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return {
        ok: false as const,
        error: (e as Error).message,
        retryable: false,
      };
    }
    // Note: tmpDir is intentionally NOT cleaned up on success — the agent
    // may reference frame files in subsequent tool calls. The host's
    // process exit cleans /tmp eventually.
  },
};

function pickTimestamps(durationMs: number, n: number): number[] {
  // Evenly spaced; skip the very edges (frame 0 and last frame are often
  // black or fade-in/out artifacts).
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const frac = (i + 1) / (n + 1);
    out.push(Math.round(durationMs * frac));
  }
  return out;
}

async function getDurationMs(
  source: string,
  signal: AbortSignal,
): Promise<number> {
  const { stdout } = await runFfprobe(
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      source,
    ],
    signal,
  );
  return Math.round(parseFloat(stdout.trim()) * 1000);
}

export const _ExtractFramesOutputSchema = Output;
