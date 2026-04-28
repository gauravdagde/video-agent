import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { runFfmpeg } from "../ffmpeg.ts";

// Per-scene OCR — extract on-screen text from a single frame near the
// midpoint of each scene. Pure JS via tesseract.js (~12MB language data
// downloaded on first use, then cached). No daemon, no GPU, no API.
//
// Why per-scene rather than per-frame: ad creative usually has one
// caption per scene (a hook line, a CTA). Sampling the midpoint catches
// it; sampling every frame is 30× the cost for ~no extra signal.

import {
  createWorker,
  type Worker as TesseractWorker,
} from "tesseract.js";

export interface SceneOcrResult {
  readonly scene_index: number;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly text: string;
  // 0-100; tesseract's mean confidence. Below ~70 usually means no
  // real text was present and the model hallucinated noise.
  readonly confidence: number;
}

export interface TimeRange {
  readonly start_ms: number;
  readonly end_ms: number;
}

const MIN_CONFIDENCE = 60;

// Tesseract's WASM core prints diagnostic warnings ("Image too small to
// scale!!", "Line cannot be recognized!!") directly to stderr/stdout.
// These can't be silenced via the JS API because they originate in the
// compiled C++ leptonica layer. We patch process.stderr.write +
// process.stdout.write for the duration of the OCR run, dropping lines
// that match the known noise patterns.
const TESSERACT_NOISE = [
  /Image too small to scale!!/,
  /Line cannot be recognized!!/,
  /Empty page!!/,
];

interface WriteFn {
  (chunk: string | Uint8Array, ...rest: unknown[]): boolean;
}

function suppressTesseractNoise<T>(body: () => Promise<T>): Promise<T> {
  const origStderr = process.stderr.write.bind(process.stderr) as WriteFn;
  const origStdout = process.stdout.write.bind(process.stdout) as WriteFn;
  const filter =
    (orig: WriteFn): WriteFn =>
    (chunk, ...rest) => {
      const s =
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString("utf-8");
      if (TESSERACT_NOISE.some((re) => re.test(s))) return true;
      return orig(chunk, ...rest);
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as unknown as { write: WriteFn }).write = filter(origStderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as unknown as { write: WriteFn }).write = filter(origStdout);
  return body().finally(() => {
    (process.stderr as unknown as { write: WriteFn }).write = origStderr;
    (process.stdout as unknown as { write: WriteFn }).write = origStdout;
  });
}

// Single worker for the whole session — loading language data is the
// expensive part (~1-2s). Reuse for every scene.
async function withWorker<T>(
  fn: (worker: TesseractWorker) => Promise<T>,
): Promise<T> {
  const worker = await createWorker("eng", undefined, {
    // Silence tesseract.js's own progress logger.
    logger: () => {},
    errorHandler: () => {},
  });
  try {
    return await fn(worker);
  } finally {
    await worker.terminate();
  }
}

export async function runScenesOcr(
  sourcePath: string,
  scenes: readonly TimeRange[],
  signal: AbortSignal,
): Promise<readonly SceneOcrResult[]> {
  const tmpDir = path.join(
    process.env.TMPDIR ?? "/tmp",
    `scenes-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(tmpDir, { recursive: true });

  try {
    return await suppressTesseractNoise(() => withWorker(async (worker) => {
      const results: SceneOcrResult[] = [];
      for (const [i, scene] of scenes.entries()) {
        const ts = (scene.start_ms + scene.end_ms) / 2 / 1000;
        const framePath = path.join(tmpDir, `scene-${i}.png`);

        try {
          await runFfmpeg(
            [
              "-ss",
              ts.toFixed(3),
              "-i",
              sourcePath,
              "-frames:v",
              "1",
              // Upscale + threshold: tesseract loves clean high-contrast
              // input; downscaled video frames are tough on it.
              "-vf",
              "scale=iw*2:ih*2:flags=lanczos",
              framePath,
            ],
            signal,
          );
        } catch {
          results.push({
            scene_index: i,
            start_ms: scene.start_ms,
            end_ms: scene.end_ms,
            text: "",
            confidence: 0,
          });
          continue;
        }

        try {
          const recognised = await worker.recognize(framePath);
          const cleaned = cleanupText(recognised.data.text);
          const conf = Math.round(recognised.data.confidence ?? 0);
          // Tesseract reports phantom characters with low confidence on
          // text-free frames. Drop anything below the threshold.
          const keep = conf >= MIN_CONFIDENCE && cleaned.length >= 2;
          results.push({
            scene_index: i,
            start_ms: scene.start_ms,
            end_ms: scene.end_ms,
            text: keep ? cleaned : "",
            confidence: keep ? conf : 0,
          });
        } catch {
          results.push({
            scene_index: i,
            start_ms: scene.start_ms,
            end_ms: scene.end_ms,
            text: "",
            confidence: 0,
          });
        }
      }
      return results;
    }));
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function cleanupText(raw: string): string {
  // Collapse whitespace, drop OCR noise tokens that are obviously junk.
  const collapsed = raw.replace(/\s+/g, " ").trim();
  // Remove sequences of non-printable / single-character noise.
  const filtered = collapsed
    .split(" ")
    .filter((w) => w.length >= 2 || /^[A-Za-z0-9]$/.test(w))
    .join(" ");
  return filtered;
}
