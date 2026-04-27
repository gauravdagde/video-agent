import type { GeneratedShot, Shot } from "../../types/generation.ts";

// One adapter per model. Same interface — `routeShot` picks which one
// based on shot type / motion / duration.
export interface ModelAdapter {
  readonly id: string;
  readonly modelName: string;
  generate(
    shot: Shot,
    output_path: string,
    signal: AbortSignal,
  ): Promise<GeneratedShot>;
}

// Phase-1 default — gated by USE_REAL_VIDEO_GEN. Unset = lavfi stubs;
// "1" = real Vertex calls.
export function shouldUseRealGen(): boolean {
  return process.env.USE_REAL_VIDEO_GEN === "1";
}
