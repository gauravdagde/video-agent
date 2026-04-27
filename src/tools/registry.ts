import type { Tool } from "../Tool.ts";
import { AdjustAudioTool } from "./editing/AdjustAudio.ts";
import { OverlayAssetTool } from "./editing/OverlayAsset.ts";
import { RenderVariantTool } from "./editing/RenderVariant.ts";
import { TrimClipTool } from "./editing/TrimClip.ts";
import { DeliverToAdPlatformTool } from "./delivery/DeliverToAdPlatform.ts";
import { SceneDetectTool } from "./analysis/SceneDetect.ts";
import { TranscriptExtractTool } from "./analysis/TranscriptExtract.ts";
import { VideoAnalyseTool } from "./analysis/VideoAnalyse.ts";

// claude-code-src/tools.ts equivalent — central registry per agent.
export const editingAgentTools: readonly Tool[] = [
  // Editing — alwaysLoad true, on every cached turn.
  TrimClipTool,
  OverlayAssetTool,
  AdjustAudioTool,
  RenderVariantTool,
  // Delivery — alwaysLoad true. Compliance + budget gated by canUseTool.
  DeliverToAdPlatformTool,
  // Analysis — shouldDefer true, behind ToolSearch on turn 1.
  VideoAnalyseTool,
  SceneDetectTool,
  TranscriptExtractTool,
];
