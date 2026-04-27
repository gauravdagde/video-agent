import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolUseContext } from "../../Tool.ts";
import { runFfmpeg } from "../ffmpeg.ts";
import { getWhisperModel, runWhisper } from "./whisper.ts";

const Input = z.object({ source_path: z.string() });

const Output = z.object({
  language: z.string(),
  words: z.array(
    z.object({
      text: z.string(),
      start_ms: z.number(),
      end_ms: z.number(),
    }),
  ),
});

type In = z.infer<typeof Input>;
type Out = z.infer<typeof Output>;

// whisper-cli's JSON output. Each entry in `transcription` is a segment;
// with --max-len 1 + --split-on-word, segments approximate word boundaries.
interface WhisperJson {
  result?: { language?: string };
  transcription?: ReadonlyArray<{
    offsets?: { from: number; to: number };
    text: string;
  }>;
}

export const TranscriptExtractTool: Tool<In, Out> = {
  name: "TranscriptExtract",
  description:
    "Extract spoken audio as a word-timestamped transcript using whisper.cpp. " +
    "Requires WHISPER_MODEL env var to point at a ggml-*.bin model file.",
  inputSchema: Input,
  shouldDefer: true,
  alwaysLoad: false,
  searchHint: "extract transcript captions speech audio words",
  readonly: true,
  microCompactable: true,

  validateInput(input: unknown): In {
    return Input.parse(input);
  },

  async call(input: In, ctx: ToolUseContext) {
    const model = getWhisperModel();
    if (model === null) {
      return {
        ok: false as const,
        error:
          "WHISPER_MODEL env var not set. Point it at a ggml-*.bin model file (e.g. ggml-base.en.bin).",
        retryable: false,
      };
    }

    const tmpDir = path.join(
      process.env.TMPDIR ?? "/tmp",
      `transcript-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await mkdir(tmpDir, { recursive: true });
    const wavPath = path.join(tmpDir, "audio.wav");
    const outPrefix = path.join(tmpDir, "out");
    const jsonPath = `${outPrefix}.json`;

    try {
      // Step 1 — extract audio to 16kHz mono PCM WAV (whisper.cpp's preferred input).
      await runFfmpeg(
        [
          "-i",
          input.source_path,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-c:a",
          "pcm_s16le",
          wavPath,
        ],
        ctx.abortSignal,
      );

      // Step 2 — transcribe. -ml 1 + -sow gives word-level segments.
      await runWhisper(
        [
          "-m",
          model,
          "-f",
          wavPath,
          "-oj",
          "-of",
          outPrefix,
          "-ml",
          "1",
          "-sow",
          // Suppress whisper-cli's verbose stderr printf — we don't surface it.
          "-np",
        ],
        ctx.abortSignal,
      );

      // Step 3 — parse the JSON sidecar.
      const raw = JSON.parse(
        await readFile(jsonPath, "utf-8"),
      ) as WhisperJson;
      const language = raw.result?.language ?? "und";
      const segments = raw.transcription ?? [];
      const words: Out["words"] = segments
        .map((seg) => ({
          text: seg.text.trim(),
          start_ms: seg.offsets?.from ?? 0,
          end_ms: seg.offsets?.to ?? 0,
        }))
        // whisper-cli sometimes emits empty-text segments (silence boundaries).
        .filter((w) => w.text.length > 0);

      return {
        ok: true as const,
        output: { language, words },
      };
    } catch (e) {
      return {
        ok: false as const,
        error: (e as Error).message,
        retryable: false,
      };
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  },
};

export const _TranscriptExtractOutputSchema = Output;
