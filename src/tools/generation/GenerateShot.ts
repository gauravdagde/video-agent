import path from "node:path";
import { z } from "zod";
import { routeShot } from "../../generation/routeShot.ts";
import { storagePaths } from "../../storage/paths.ts";
import type { Tool, ToolUseContext } from "../../Tool.ts";
import type {
  AssetId,
  BrandId,
  CampaignId,
} from "../../types/video.ts";

// Plan §4.3-4.4 — the agent's interface to generation. Calls routeShot
// to pick the right adapter, runs it, returns the local mp4 path.

const Input = z.object({
  shot_id: z.string(),
  type: z.enum([
    "product_demo",
    "lifestyle",
    "talking_head",
    "logo_card",
    "transition",
  ]),
  motion: z.enum(["static", "dynamic", "camera_pan", "camera_zoom"]),
  style: z.enum(["photorealistic", "stylised", "animation", "graphic"]),
  duration_ms: z.number().int().positive().max(15_000),
  prompt: z.string().min(1).max(2000),
  reference_image_path: z.string().optional(),
});

const Output = z.object({
  shot_id: z.string(),
  output_path: z.string(),
  duration_ms: z.number(),
  model_used: z.string(),
  took_ms: z.number(),
});

type In = z.infer<typeof Input>;
type Out = z.infer<typeof Output>;

export const GenerateShotTool: Tool<In, Out> = {
  name: "GenerateShot",
  description:
    "Generate a single shot from structured spec. routeShot picks the " +
    "model (Imagen / Veo 2 / Veo 3 — or lavfi stub when USE_REAL_VIDEO_GEN " +
    "is unset). Returns the local mp4 path.",
  inputSchema: Input,
  shouldDefer: false,
  alwaysLoad: true,
  readonly: false,
  microCompactable: false,

  validateInput(input: unknown): In {
    return Input.parse(input);
  },

  async call(input: In, ctx: ToolUseContext) {
    const adapter = routeShot({
      id: input.shot_id,
      type: input.type,
      motion: input.motion,
      style: input.style,
      duration_ms: input.duration_ms,
      prompt: input.prompt,
      ...(input.reference_image_path !== undefined
        ? { reference_image_path: input.reference_image_path }
        : {}),
    });

    // Output goes under the campaign tree as a shot in a synthetic
    // "generated" asset. The GenerationAgent's final return value is a
    // storyboard linking these together.
    const assetId = (ctx.assetId ?? "generated") as AssetId;
    const sourceDir = path.dirname(
      storagePaths.assetSource(
        ctx.brandId as BrandId,
        ctx.campaignId as CampaignId,
        assetId,
      ),
    );
    const outputPath = path.join(sourceDir, "shots", `${input.shot_id}.mp4`);

    try {
      const result = await adapter.generate(
        {
          id: input.shot_id,
          type: input.type,
          motion: input.motion,
          style: input.style,
          duration_ms: input.duration_ms,
          prompt: input.prompt,
          ...(input.reference_image_path !== undefined
            ? { reference_image_path: input.reference_image_path }
            : {}),
        },
        outputPath,
        ctx.abortSignal,
      );
      return { ok: true as const, output: result };
    } catch (e) {
      return {
        ok: false as const,
        error: (e as Error).message,
        retryable: true,
      };
    }
  },
};

export const _GenerateShotOutputSchema = Output;
