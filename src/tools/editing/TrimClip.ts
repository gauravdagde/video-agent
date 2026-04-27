import path from "node:path";
import { z } from "zod";
import type { Tool, ToolUseContext } from "../../Tool.ts";
import { ensureDir, runFfmpeg } from "../ffmpeg.ts";

const Input = z.object({
  source_path: z.string(),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().positive(),
  output_path: z.string(),
});

const Output = z.object({
  output_path: z.string(),
  duration_ms: z.number(),
});

type In = z.infer<typeof Input>;
type Out = z.infer<typeof Output>;

export const TrimClipTool: Tool<In, Out> = {
  name: "TrimClip",
  description:
    "Cut a clip from a source video between two timestamps. Stream-copy when possible. Non-destructive — writes a new file at output_path.",
  inputSchema: Input,
  shouldDefer: false,
  alwaysLoad: true,
  readonly: false,
  microCompactable: false,

  validateInput(input: unknown): In {
    return Input.parse(input);
  },

  async call(input: In, ctx: ToolUseContext) {
    if (input.end_ms <= input.start_ms) {
      return {
        ok: false as const,
        error: "end_ms must be greater than start_ms",
        retryable: false,
      };
    }
    await ensureDir(path.dirname(input.output_path));
    const startSec = (input.start_ms / 1000).toFixed(3);
    const durationSec = ((input.end_ms - input.start_ms) / 1000).toFixed(3);
    try {
      await runFfmpeg(
        [
          "-ss",
          startSec,
          "-i",
          input.source_path,
          "-t",
          durationSec,
          "-c",
          "copy",
          "-avoid_negative_ts",
          "make_zero",
          input.output_path,
        ],
        ctx.abortSignal,
      );
    } catch (e) {
      return {
        ok: false as const,
        error: (e as Error).message,
        retryable: false,
      };
    }
    return {
      ok: true as const,
      output: {
        output_path: input.output_path,
        duration_ms: input.end_ms - input.start_ms,
      },
    };
  },
};

export const _TrimClipOutputSchema = Output;
