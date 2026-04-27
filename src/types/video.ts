// Domain types — kept deterministic so they can land in the prompt without
// busting the cache (see plan §I dynamic-layer hygiene).

export type AssetId = string & { readonly __brand: "AssetId" };
export type BrandId = string & { readonly __brand: "BrandId" };
export type CampaignId = string & { readonly __brand: "CampaignId" };
export type VariantSpecId = string & { readonly __brand: "VariantSpecId" };
export type EditPlanId = string & { readonly __brand: "EditPlanId" };

export interface VideoAsset {
  id: AssetId;
  path: string;
  duration_ms: number;
  resolution: { width: number; height: number };
  frame_rate: number;
  has_audio: boolean;
}

export type Platform =
  | "instagram_reel"
  | "youtube_pre"
  | "tiktok"
  | "display_16_9"
  // Open-ended for new platforms; canonicalisation lives in canonicalise().
  | (string & { readonly __platform: never });

export interface VariantSpec {
  id: VariantSpecId;
  platform: Platform;
  max_duration_ms: number;
  aspect_ratio: string;
  audience_segment?: string;
  market?: string;
  cta_override?: string;
}

export interface SceneInstruction {
  source_start_ms: number;
  source_end_ms: number;
  // Output position is implicit: scenes are concatenated in array order.
}

export interface OverlayInstruction {
  kind: "image" | "text" | "logo";
  asset_path?: string;
  text?: string;
  start_ms: number;
  end_ms: number;
  position: { x: number; y: number };
  scale?: number;
}

export interface AudioInstruction {
  source: "original" | "voiceover" | "music";
  voiceover_path?: string;
  music_path?: string;
  duck_db?: number;
  normalise_lufs?: number;
}

export interface EditPlan {
  id: EditPlanId;
  variant_spec_id: VariantSpecId;
  scenes: SceneInstruction[];
  overlays: OverlayInstruction[];
  audio: AudioInstruction;
  estimated_duration_ms: number;
}

export type ComplianceStatus = "pending" | "passed" | "failed" | "auto_fixed";

export interface RenderedVariant {
  variant_spec_id: VariantSpecId;
  output_path: string;
  duration_ms: number;
  size_bytes: number;
  rendered_at_ms: number;
}

export interface VariantBatch {
  source_asset_id: AssetId;
  variants: RenderedVariant[];
  edit_plans: EditPlan[];
  compliance_status: ComplianceStatus;
}
