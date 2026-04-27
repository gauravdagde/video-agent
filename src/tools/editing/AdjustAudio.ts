import path from "node:path";
import { z } from "zod";
import type { Tool, ToolUseContext } from "../../Tool.ts";
import { ensureDir, runFfmpeg } from "../ffmpeg.ts";

const Input = z.object({
  source_path: z.string(),
  output_path: z.string(),
  // Operations are applied in this order: normalise → duck → replace.
  normalise_lufs: z.number().min(-30).max(-5).optional(),
  duck_db: z.number().min(-30).max(0).optional(),
  replace_with: z.string().optional(),
});

const Output = z.object({ output_path: z.string() });

type In = z.infer<typeof Input>;
type Out = z.infer<typeof Output>;

export const AdjustAudioTool: Tool<In, Out> = {
  name: "AdjustAudio",
  description:
    "Normalise loudness, duck the audio level, or replace the audio track. Non-destructive — writes a new file at output_path.",
  inputSchema: Input,
  shouldDefer: false,
  alwaysLoad: true,
  readonly: false,
  microCompactable: false,

  validateInput(input: unknown): In {
    return Input.parse(input);
  },

  async call(input: In, ctx: ToolUseContext) {
    await ensureDir(path.dirname(input.output_path));

    const inputs: string[] = ["-i", input.source_path];
    let audioFilter: string | undefined;

    if (input.replace_with !== undefined) {
      inputs.push("-i", input.replace_with);
      const filters: string[] = ["[1:a]"];
      if (input.normalise_lufs !== undefined) {
        filters.push(`loudnorm=I=${input.normalise_lufs}`);
      }
      if (input.duck_db !== undefined) {
        filters.push(`volume=${input.duck_db}dB`);
      }
      filters.push("[aout]");
      audioFilter = filters.join(",").replace(",[aout]", "[aout]");
    } else {
      const filters: string[] = ["[0:a]"];
      if (input.normalise_lufs !== undefined) {
        filters.push(`loudnorm=I=${input.normalise_lufs}`);
      }
      if (input.duck_db !== undefined) {
        filters.push(`volume=${input.duck_db}dB`);
      }
      if (filters.length === 1) {
        return {
          ok: false as const,
          error:
            "AdjustAudio called with no operation — set at least one of normalise_lufs / duck_db / replace_with",
          retryable: false,
        };
      }
      filters.push("[aout]");
      audioFilter = filters.join(",").replace(",[aout]", "[aout]");
    }

    const args =
      input.replace_with !== undefined
        ? [
            ...inputs,
            "-filter_complex",
            audioFilter!,
            "-map",
            "0:v",
            "-map",
            "[aout]",
            "-c:v",
            "copy",
            "-shortest",
            input.output_path,
          ]
        : [
            ...inputs,
            "-filter_complex",
            audioFilter!,
            "-map",
            "0:v",
            "-map",
            "[aout]",
            "-c:v",
            "copy",
            input.output_path,
          ];

    try {
      await runFfmpeg(args, ctx.abortSignal);
    } catch (e) {
      return {
        ok: false as const,
        error: (e as Error).message,
        retryable: false,
      };
    }
    return {
      ok: true as const,
      output: { output_path: input.output_path },
    };
  },
};

export const _AdjustAudioOutputSchema = Output;
