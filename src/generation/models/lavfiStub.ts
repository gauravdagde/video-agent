import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runFfmpeg } from "../../tools/ffmpeg.ts";
import type { GeneratedShot, Shot } from "../../types/generation.ts";
import type { ModelAdapter } from "./types.ts";

// Default adapter when USE_REAL_VIDEO_GEN is unset. Produces a colour-bar
// `testsrc` clip of the requested duration so the rest of the pipeline
// (assembly, editing, compliance) can run end-to-end without GCP access.
//
// Each shot type gets a slightly different testsrc pattern to make the
// resulting source asset visually distinguishable while debugging.

export const lavfiStubAdapter: ModelAdapter = {
  id: "lavfi-stub",
  modelName: "ffmpeg-lavfi-testsrc",
  async generate(
    shot: Shot,
    output_path: string,
    signal: AbortSignal,
  ): Promise<GeneratedShot> {
    const startedAtMs = Date.now();
    await mkdir(path.dirname(output_path), { recursive: true });

    const durationSec = (shot.duration_ms / 1000).toFixed(3);
    const filter = filterForShotType(shot);

    await runFfmpeg(
      [
        "-f",
        "lavfi",
        "-i",
        `${filter}=duration=${durationSec}:size=1920x1080:rate=30`,
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=440:duration=${durationSec}`,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        output_path,
      ],
      signal,
    );

    return {
      shot_id: shot.id,
      output_path,
      duration_ms: shot.duration_ms,
      model_used: "lavfi-stub",
      took_ms: Date.now() - startedAtMs,
    };
  },
};

function filterForShotType(shot: Shot): string {
  switch (shot.type) {
    case "product_demo":
      return "smptebars";
    case "lifestyle":
      return "testsrc";
    case "talking_head":
      return "rgbtestsrc";
    case "logo_card":
      return "smptehdbars";
    case "transition":
      return "color=c=black";
  }
}
