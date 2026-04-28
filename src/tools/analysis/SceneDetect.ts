import { z } from "zod";
import type { Tool, ToolUseContext } from "../../Tool.ts";
import { runFfmpeg } from "../ffmpeg.ts";

const Input = z.object({
  source_path: z.string(),
  // 0.0–1.0; default 0.4 is a reasonable cut threshold for ad creative.
  threshold: z.number().min(0).max(1).default(0.4),
});

const Output = z.object({
  scenes: z.array(
    z.object({
      start_ms: z.number(),
      end_ms: z.number(),
      // Label is left blank by ffmpeg-only detection — ML classification
      // will land here when the model layer ships.
      label: z.string(),
    }),
  ),
});

type In = z.infer<typeof Input>;
type Out = z.infer<typeof Output>;

export const SceneDetectTool: Tool<In, Out> = {
  name: "SceneDetect",
  description:
    "Detect scene boundaries in a source video using ffmpeg's scene-change filter. Returns ordered scenes with timestamps. Labels are unclassified for now.",
  inputSchema: Input,
  shouldDefer: true,
  alwaysLoad: false,
  searchHint: "detect scenes shots cuts boundaries timeline",
  readonly: true,
  microCompactable: true,

  validateInput(input: unknown): In {
    return Input.parse(input);
  },

  async call(input: In, ctx: ToolUseContext) {
    // Two-strategy detector:
    //   1. Perceptual: ffmpeg's `select=gt(scene,T)` filter. Works well
    //      on real-world footage.
    //   2. Structural: ffprobe-emitted keyframe (I-frame) timestamps —
    //      encoders place I-frames at scene cuts. Catches cases where
    //      the perceptual metric misses (synthetic content, low-contrast
    //      transitions). Also surfaces cuts when (1) finds nothing.
    let perceptualCuts: number[] = [];
    try {
      const r = await runFfmpeg(
        [
          "-i",
          input.source_path,
          "-vf",
          `select='gt(scene,${input.threshold})',showinfo`,
          "-f",
          "null",
          "-",
        ],
        ctx.abortSignal,
      );
      for (const line of r.stderr.split("\n")) {
        const m = line.match(/pts_time:([\d.]+)/);
        if (m) perceptualCuts.push(Math.round(parseFloat(m[1]!) * 1000));
      }
    } catch (e) {
      return {
        ok: false as const,
        error: (e as Error).message,
        retryable: false,
      };
    }

    const keyframeCuts = await getKeyframeTimestampsMs(
      input.source_path,
      ctx.abortSignal,
    );
    const durationMs = await getDurationMs(input.source_path, ctx.abortSignal);

    // Merge + dedupe + drop sub-second jitter (we don't want every
    // intra-frame keyframe in long videos — only meaningful boundaries).
    const merged = [0, ...perceptualCuts, ...keyframeCuts]
      .filter((t) => t >= 0 && t < durationMs)
      .sort((a, b) => a - b);
    const cuts: number[] = [];
    const MIN_GAP_MS = 1500;
    for (const t of merged) {
      if (cuts.length === 0 || t - cuts[cuts.length - 1]! >= MIN_GAP_MS) {
        cuts.push(t);
      }
    }
    cuts.push(durationMs);

    const scenes: Out["scenes"] = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      scenes.push({
        start_ms: cuts[i]!,
        end_ms: cuts[i + 1]!,
        label: "",
      });
    }
    return { ok: true as const, output: { scenes } };
  },
};

// ffprobe keyframe positions — I-frames at scene cuts are a reliable
// structural signal even when perceptual scene-detection misses.
async function getKeyframeTimestampsMs(
  source: string,
  signal: AbortSignal,
): Promise<number[]> {
  const { runFfprobe } = await import("../ffmpeg.ts");
  try {
    const { stdout } = await runFfprobe(
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-skip_frame",
        "nokey",
        "-show_entries",
        "frame=pts_time",
        "-of",
        "csv=p=0",
        source,
      ],
      signal,
    );
    const out: number[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const t = parseFloat(trimmed);
      if (Number.isFinite(t)) out.push(Math.round(t * 1000));
    }
    return out;
  } catch {
    return [];
  }
}

async function getDurationMs(p: string, signal: AbortSignal): Promise<number> {
  const { runFfprobe } = await import("../ffmpeg.ts");
  const { stdout } = await runFfprobe(
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      p,
    ],
    signal,
  );
  return Math.round(parseFloat(stdout.trim()) * 1000);
}

export const _SceneDetectOutputSchema = Output;
