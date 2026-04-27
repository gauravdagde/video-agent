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
    // ffmpeg's `select=gt(scene\,T)` writes scene-change times to stderr
    // via showinfo. We parse the `pts_time:` field.
    let stderr: string;
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
      stderr = r.stderr;
    } catch (e) {
      return {
        ok: false as const,
        error: (e as Error).message,
        retryable: false,
      };
    }

    const cuts: number[] = [0];
    for (const line of stderr.split("\n")) {
      const m = line.match(/pts_time:([\d.]+)/);
      if (m) cuts.push(Math.round(parseFloat(m[1]!) * 1000));
    }

    // Append duration as a final boundary so the last scene closes.
    const durationMs = await getDurationMs(input.source_path, ctx.abortSignal);
    if (durationMs > (cuts.at(-1) ?? 0)) cuts.push(durationMs);

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
