import path from "node:path";
import { z } from "zod";
import type { Tool, ToolUseContext } from "../../Tool.ts";
import { ensureDir, runFfmpeg } from "../ffmpeg.ts";

// Flat-object schema with a `kind` discriminator + runtime refine.
// Why not `z.discriminatedUnion`: Anthropic's tool input_schema requires
// `type: "object"` at the root, and zod-to-json-schema emits
// `{anyOf:[...]}` for discriminated unions. We keep the same runtime
// validation guarantees via .superRefine().
const Input = z
  .object({
    kind: z.enum(["image", "logo", "text"]),
    source_path: z.string(),
    start_ms: z.number().int().nonnegative(),
    end_ms: z.number().int().positive(),
    position: z.object({
      x: z.union([z.number(), z.string()]),
      y: z.union([z.number(), z.string()]),
    }),
    output_path: z.string(),
    // Image/logo branch
    asset_path: z.string().optional(),
    scale: z.number().positive().optional(),
    // Text branch
    text: z.string().max(200).optional(),
    font_path: z.string().optional(),
    font_size: z.number().int().positive().default(48),
    color: z.string().default("white"),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "text") {
      if (v.text === undefined) {
        ctx.addIssue({
          code: "custom",
          message: 'kind="text" requires `text`',
          path: ["text"],
        });
      }
    } else {
      if (v.asset_path === undefined) {
        ctx.addIssue({
          code: "custom",
          message: `kind="${v.kind}" requires \`asset_path\``,
          path: ["asset_path"],
        });
      }
    }
  });

const Output = z.object({ output_path: z.string() });

type In = z.infer<typeof Input>;
type Out = z.infer<typeof Output>;

export const OverlayAssetTool: Tool<In, Out> = {
  name: "OverlayAsset",
  description:
    "Composite an image, logo, or text onto a clip. Specify a time range and position. Non-destructive — writes a new file at output_path.",
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
    const enable = `enable='between(t,${(input.start_ms / 1000).toFixed(3)},${(input.end_ms / 1000).toFixed(3)})'`;
    const args =
      input.kind === "text"
        ? buildTextArgs(input, enable)
        : buildImageArgs(input, enable);

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

function buildImageArgs(input: In, enable: string): string[] {
  // superRefine guarantees asset_path is present for kind in {image,logo}.
  const assetPath = input.asset_path!;
  const scale = input.scale ?? 1;
  const filter =
    scale === 1
      ? `[0:v][1:v]overlay=${formatPos(input.position.x)}:${formatPos(input.position.y)}:${enable}`
      : `[1:v]scale=iw*${scale}:ih*${scale}[ovr];[0:v][ovr]overlay=${formatPos(input.position.x)}:${formatPos(input.position.y)}:${enable}`;
  return [
    "-i",
    input.source_path,
    "-i",
    assetPath,
    "-filter_complex",
    filter,
    "-c:a",
    "copy",
    input.output_path,
  ];
}

function buildTextArgs(input: In, enable: string): string[] {
  // superRefine guarantees text is present for kind="text".
  const text = input.text!;
  const drawtextParts = [
    `text='${escapeDrawtext(text)}'`,
    `x=${formatPos(input.position.x)}`,
    `y=${formatPos(input.position.y)}`,
    `fontsize=${input.font_size}`,
    `fontcolor=${input.color}`,
    enable,
  ];
  if (input.font_path !== undefined) {
    drawtextParts.push(`fontfile='${escapeDrawtext(input.font_path)}'`);
  }
  return [
    "-i",
    input.source_path,
    "-vf",
    `drawtext=${drawtextParts.join(":")}`,
    "-c:a",
    "copy",
    input.output_path,
  ];
}

function formatPos(v: number | string): string {
  return typeof v === "number" ? v.toString() : v;
}

// drawtext filter is ffmpeg-quoting-sensitive; escape the chars that bite.
function escapeDrawtext(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}

export const _OverlayAssetOutputSchema = Output;
