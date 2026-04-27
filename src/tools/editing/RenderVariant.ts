import path from "node:path";
import { z } from "zod";
import type { Tool, ToolUseContext } from "../../Tool.ts";
import { ensureDir, runFfmpeg } from "../ffmpeg.ts";

// RenderVariant is the "assemble final output" tool. It takes an ordered
// list of input clips, concatenates them, conforms to the variant aspect
// ratio, and writes a single mp4. canUseTool gates this on a compliance
// clearance (Pattern 4 Tier 2).
const Input = z.object({
  variant_spec_id: z.string(),
  // Ordered list of clips already produced by TrimClip / OverlayAsset.
  clips: z.array(z.string()).min(1),
  output_path: z.string(),
  aspect_ratio: z.string().regex(/^\d+:\d+$/),
  max_duration_ms: z.number().int().positive(),
});

const Output = z.object({
  variant_spec_id: z.string(),
  output_path: z.string(),
  duration_ms: z.number(),
  size_bytes: z.number(),
});

type In = z.infer<typeof Input>;
type Out = z.infer<typeof Output>;

export const RenderVariantTool: Tool<In, Out> = {
  name: "RenderVariant",
  description:
    "Assemble an ordered list of clips into a final variant. Conforms to the requested aspect ratio (centred crop/pad). Output is gated on compliance clearance.",
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

    const concatList = input.clips
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");
    const concatPath = `${input.output_path}.concat.txt`;
    await Bun.write(concatPath, concatList);

    const [w, h] = input.aspect_ratio.split(":").map((s) => parseInt(s, 10));
    if (!w || !h) {
      return {
        ok: false as const,
        error: `aspect_ratio parse failed: ${input.aspect_ratio}`,
        retryable: false,
      };
    }
    // Pad rather than crop so we never lose subject. Caller can swap to
    // crop later if a brand prefers it.
    const aspect = w / h;
    const filter = `scale='if(gt(iw/ih,${aspect}),-2,iw)':'if(gt(iw/ih,${aspect}),ih,-2)',pad='if(gt(iw/ih,${aspect}),iw,ih*${aspect})':'if(gt(iw/ih,${aspect}),iw/${aspect},ih)':(ow-iw)/2:(oh-ih)/2:black,setsar=1`;

    try {
      await runFfmpeg(
        [
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          concatPath,
          "-vf",
          filter,
          "-t",
          (input.max_duration_ms / 1000).toFixed(3),
          "-c:v",
          "libx264",
          "-c:a",
          "aac",
          "-movflags",
          "+faststart",
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

    const { stat } = await import("node:fs/promises");
    const s = await stat(input.output_path);

    return {
      ok: true as const,
      output: {
        variant_spec_id: input.variant_spec_id,
        output_path: input.output_path,
        duration_ms: input.max_duration_ms,
        size_bytes: s.size,
      },
    };
  },
};

export const _RenderVariantOutputSchema = Output;
