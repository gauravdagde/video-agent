import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runFfmpeg } from "../../tools/ffmpeg.ts";
import type { GeneratedShot, Shot } from "../../types/generation.ts";
import { checkVertexAuth } from "../vertex/auth.ts";
import { lavfiStubAdapter } from "./lavfiStub.ts";
import type { ModelAdapter } from "./types.ts";

// Plan §4.3 — Veo 2 adapter. General-purpose text-to-video / image-to-video,
// faster + cheaper than Veo 3. Used as a default for non-photorealistic
// shots.
//
// Real flow (when @google-cloud/aiplatform is installed):
//   1. const op = await veoClient.predict({model: "veo-2.0-generate-001", ...})
//   2. await awaitOperation(op, signal, {pollIntervalMs: 5_000, maxWaitMs: 5*60_000})
//   3. await downloadGcsToLocal(op.result.gcs_uri, output_path, signal)
//   4. return GeneratedShot
// Until then: stub falls through to lavfi.

export const videoGenV1Adapter: ModelAdapter = {
  id: "veo-2",
  modelName: "veo-2.0-generate-001",
  async generate(
    shot: Shot,
    output_path: string,
    signal: AbortSignal,
  ): Promise<GeneratedShot> {
    const auth = checkVertexAuth();
    if (!auth.ok) {
      console.warn(
        `[videoGenV1] Vertex not configured (${auth.reason}) — falling back to lavfi stub`,
      );
      return lavfiStubAdapter.generate(shot, output_path, signal);
    }
    // Phase-1: SDK integration deferred (see comment at top of file).
    const startedAtMs = Date.now();
    await mkdir(path.dirname(output_path), { recursive: true });

    const durationSec = (shot.duration_ms / 1000).toFixed(3);
    await runFfmpeg(
      [
        "-f",
        "lavfi",
        "-i",
        `gradients=duration=${durationSec}:size=1920x1080:rate=30`,
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
      model_used: "veo-2-stub",
      took_ms: Date.now() - startedAtMs,
    };
  },
};
