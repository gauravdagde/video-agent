import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runFfmpeg } from "../../tools/ffmpeg.ts";
import type { GeneratedShot, Shot } from "../../types/generation.ts";
import { checkVertexAuth } from "../vertex/auth.ts";
import { lavfiStubAdapter } from "./lavfiStub.ts";
import type { ModelAdapter } from "./types.ts";

// Plan §4.3 — Imagen 4 adapter. For static short shots the dispatcher
// routes here to avoid paying video-gen prices. The adapter generates a
// PNG via Imagen, then ffmpeg-stretches it to the requested duration as
// a static clip with a slow Ken-Burns pan if motion === "camera_pan".
//
// Phase-1 scope: when USE_REAL_VIDEO_GEN is unset OR the
// @google-cloud/aiplatform dep is missing, this adapter falls through to
// the lavfi stub so callers always get a working mp4 back. Real Imagen
// integration lands when the user runs `bun add @google-cloud/aiplatform`.

export const imageGenAdapter: ModelAdapter = {
  id: "imagen-4",
  modelName: "imagen-4",
  async generate(
    shot: Shot,
    output_path: string,
    signal: AbortSignal,
  ): Promise<GeneratedShot> {
    const auth = checkVertexAuth();
    if (!auth.ok) {
      // Fall through to lavfi so the rest of the pipeline still works.
      // The caller already opted into the real path via env flag — but
      // we don't have credentials, so we degrade rather than crash.
      console.warn(
        `[imageGen] Vertex not configured (${auth.reason}) — falling back to lavfi stub`,
      );
      return lavfiStubAdapter.generate(shot, output_path, signal);
    }
    // Phase-1: SDK integration deferred. The architecture is in place —
    // real implementation flow would be:
    //   1. const png = await predictImage({prompt: shot.prompt, ...})
    //   2. await writeFile(`${output_path}.png`, png)
    //   3. ffmpeg loop the PNG into a video of shot.duration_ms
    //   4. (optional) Ken-Burns pan if shot.motion === "camera_pan"
    const startedAtMs = Date.now();
    await mkdir(path.dirname(output_path), { recursive: true });

    const durationSec = (shot.duration_ms / 1000).toFixed(3);
    // Until Imagen wiring lands: produce a single-colour still + audio
    // that's still consumable as a real mp4.
    await runFfmpeg(
      [
        "-f",
        "lavfi",
        "-i",
        `color=c=0x16213E:s=1920x1080:d=${durationSec}`,
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
      model_used: "imagen-4-stub",
      took_ms: Date.now() - startedAtMs,
    };
  },
};
