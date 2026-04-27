import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runFfmpeg } from "../../tools/ffmpeg.ts";
import type { GeneratedShot, Shot } from "../../types/generation.ts";
import { checkVertexAuth } from "../vertex/auth.ts";
import { lavfiStubAdapter } from "./lavfiStub.ts";
import type { ModelAdapter } from "./types.ts";

// Plan §4.3 — Veo 3 adapter. Photorealistic, native audio support, longer
// shots. Default for product demos. Same shape as Veo 2 — different
// model id and capabilities.

export const videoGenV2Adapter: ModelAdapter = {
  id: "veo-3",
  modelName: "veo-3.0-generate-001",
  async generate(
    shot: Shot,
    output_path: string,
    signal: AbortSignal,
  ): Promise<GeneratedShot> {
    const auth = checkVertexAuth();
    if (!auth.ok) {
      console.warn(
        `[videoGenV2] Vertex not configured (${auth.reason}) — falling back to lavfi stub`,
      );
      return lavfiStubAdapter.generate(shot, output_path, signal);
    }
    // Phase-1: SDK integration deferred. Production flow mirrors Veo 2
    // (long-running operation + GCS download).
    const startedAtMs = Date.now();
    await mkdir(path.dirname(output_path), { recursive: true });

    const durationSec = (shot.duration_ms / 1000).toFixed(3);
    await runFfmpeg(
      [
        "-f",
        "lavfi",
        "-i",
        `mandelbrot=duration=${durationSec}:size=1920x1080:rate=30`,
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=523:duration=${durationSec}`,
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
      model_used: "veo-3-stub",
      took_ms: Date.now() - startedAtMs,
    };
  },
};
