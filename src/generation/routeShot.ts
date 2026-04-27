import type { Shot } from "../types/generation.ts";
import { imageGenAdapter } from "./models/imageGen.ts";
import { lavfiStubAdapter } from "./models/lavfiStub.ts";
import type { ModelAdapter } from "./models/types.ts";
import { shouldUseRealGen } from "./models/types.ts";
import { videoGenV1Adapter } from "./models/videoGenV1.ts";
import { videoGenV2Adapter } from "./models/videoGenV2.ts";

// Plan §4.3 — dispatcher. Picks the adapter for a shot based on the
// shot's structural fields. Until a real-cost run informs the default
// tier, we route conservatively: short static → Imagen, product demos
// → Veo 3, everything else → Veo 2.
//
// USE_REAL_VIDEO_GEN env flag must be set for any real adapter to be
// picked at all — when unset, every shot routes to the lavfi stub.

export function routeShot(shot: Shot): ModelAdapter {
  if (!shouldUseRealGen()) return lavfiStubAdapter;

  // Short + static → Imagen + upscale (cheaper than video-gen)
  if (shot.duration_ms < 4_000 && shot.motion === "static") {
    return imageGenAdapter;
  }

  // Photorealistic product demos justify the Veo 3 premium.
  if (shot.type === "product_demo" && shot.style === "photorealistic") {
    return videoGenV2Adapter;
  }

  // TODO: pick default tier after first real-cost run.
  // For now everything else takes the cheaper Veo 2 path.
  return videoGenV1Adapter;
}
