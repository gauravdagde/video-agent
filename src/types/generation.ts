// Plan §4.1 — generation domain types. The agent reasons over Storyboards;
// each Storyboard is a list of Shots; each Shot is a self-contained piece
// of generated content that gets stitched into a source asset.

export type ShotType =
  | "product_demo"
  | "lifestyle"
  | "talking_head"
  | "logo_card"
  | "transition";

export type ShotMotion = "static" | "dynamic" | "camera_pan" | "camera_zoom";

export type ShotStyle =
  | "photorealistic"
  | "stylised"
  | "animation"
  | "graphic";

export interface Shot {
  readonly id: string;
  readonly type: ShotType;
  readonly motion: ShotMotion;
  readonly style: ShotStyle;
  readonly duration_ms: number;
  // Free-form prompt for the model. The adapter combines this with the
  // shot type / style hints when calling the underlying model.
  readonly prompt: string;
  // Optional path to a reference image — used by image-to-video models
  // for brand-consistent generation (e.g. logo/product reference frame).
  readonly reference_image_path?: string;
  // Optional voiceover the shot is timed against.
  readonly voiceover?: {
    readonly script: string;
    readonly approx_duration_ms: number;
  };
}

export interface Storyboard {
  readonly id: string;
  readonly campaign_brief_summary: string;
  readonly shots: readonly Shot[];
  readonly target_total_duration_ms: number;
}

// What an adapter returns. Output_path is local-disk after any GCS download.
export interface GeneratedShot {
  readonly shot_id: string;
  readonly output_path: string;
  readonly duration_ms: number;
  readonly model_used: string;
  readonly took_ms: number;
}
