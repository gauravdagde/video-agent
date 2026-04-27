import { z } from "zod";
import type { Tool, ToolUseContext } from "../../Tool.ts";
import { runFfprobe } from "../ffmpeg.ts";

const Input = z.object({ source_path: z.string() });

const Output = z.object({
  duration_ms: z.number(),
  resolution: z.object({
    width: z.number(),
    height: z.number(),
  }),
  frame_rate: z.number(),
  has_audio: z.boolean(),
  format: z.string(),
  bitrate_kbps: z.number(),
});

type In = z.infer<typeof Input>;
type Out = z.infer<typeof Output>;

interface FfprobeStream {
  codec_type: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
}

interface FfprobeFormat {
  format_name: string;
  duration?: string;
  bit_rate?: string;
}

interface FfprobeOutput {
  streams: FfprobeStream[];
  format: FfprobeFormat;
}

export const VideoAnalyseTool: Tool<In, Out> = {
  name: "VideoAnalyse",
  description:
    "Inspect a video file and return canonical metadata: duration, resolution, frame rate, audio presence, container format, and bitrate. Read-only.",
  inputSchema: Input,
  // §E — deferred. Used only on the first 1-3 turns; behind ToolSearch after.
  shouldDefer: true,
  alwaysLoad: false,
  searchHint: "analyse video metadata duration resolution frame rate",
  readonly: true,
  microCompactable: true,

  validateInput(input: unknown): In {
    return Input.parse(input);
  },

  async call(input: In, ctx: ToolUseContext) {
    let parsed: FfprobeOutput;
    try {
      const { stdout } = await runFfprobe(
        [
          "-v",
          "error",
          "-print_format",
          "json",
          "-show_format",
          "-show_streams",
          input.source_path,
        ],
        ctx.abortSignal,
      );
      parsed = JSON.parse(stdout) as FfprobeOutput;
    } catch (e) {
      return {
        ok: false as const,
        error: (e as Error).message,
        retryable: false,
      };
    }

    const video = parsed.streams.find((s) => s.codec_type === "video");
    const audio = parsed.streams.find((s) => s.codec_type === "audio");
    if (!video) {
      return {
        ok: false as const,
        error: `no video stream in ${input.source_path}`,
        retryable: false,
      };
    }

    return {
      ok: true as const,
      output: {
        duration_ms: Math.round(
          parseFloat(parsed.format.duration ?? "0") * 1000,
        ),
        resolution: { width: video.width ?? 0, height: video.height ?? 0 },
        frame_rate: parseRational(video.r_frame_rate ?? "0/1"),
        has_audio: audio !== undefined,
        format: parsed.format.format_name,
        bitrate_kbps: Math.round(
          parseInt(parsed.format.bit_rate ?? "0", 10) / 1000,
        ),
      },
    };
  },
};

function parseRational(s: string): number {
  const [num, den] = s.split("/").map((n) => parseInt(n, 10));
  if (!num || !den) return 0;
  return Math.round((num / den) * 1000) / 1000;
}

export const _VideoAnalyseOutputSchema = Output;
