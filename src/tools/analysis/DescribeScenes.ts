import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolUseContext } from "../../Tool.ts";
import { runFfmpeg } from "../ffmpeg.ts";
import {
  describeImageWithClaude,
  isClaudeConfigured,
} from "./claudeVision.ts";
import {
  getLlamaVisionConfig,
  LlamaVisionSession,
} from "./llamaVision.ts";

// Per-scene visual description via a vision-language model.
//
// Two backends, picked by `LLAMA_VLM_BACKEND` or auto:
//   - "claude": uses ANTHROPIC_API_KEY directly; parallel calls;
//               no install, fastest, ~$0.005-0.0075 per scene.
//   - "local":  spawns llama-server + Qwen2.5-VL or similar from
//               LLAMA_VLM_HF_REPO or LLAMA_VLM_MODEL/MMPROJ; sequential;
//               offline, free per call.
//
// Auto-selection: prefer Claude if API key present, else local llama
// if configured, else return a clear "not configured" error.

export type VlmBackend = "claude" | "local";

export function pickBackend(): VlmBackend | null {
  const explicit = process.env.LLAMA_VLM_BACKEND;
  if (explicit === "claude" || explicit === "local") return explicit;
  if (isClaudeConfigured()) return "claude";
  if (getLlamaVisionConfig() !== null) return "local";
  return null;
}

// Concurrency for Claude — Anthropic API supports parallel chat
// completions; 4 in flight is well below most accounts' rate limits and
// gives ~4x speedup over sequential.
const CLAUDE_CONCURRENCY = 4;

const SceneRange = z.object({
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().positive(),
});

const Input = z.object({
  source_path: z.string(),
  scenes: z.array(SceneRange).min(1).max(64),
  // Sample point inside each scene, normalised to [0, 1]. 0.5 = middle.
  sample_position: z.number().min(0).max(1).default(0.5),
});

const Description = z.object({
  scene_index: z.number().int().nonnegative(),
  start_ms: z.number(),
  end_ms: z.number(),
  summary: z.string(),
  subject: z.string(),
  setting: z.string(),
  has_people: z.boolean(),
  has_visible_text: z.boolean(),
  visible_text: z.string(),
  mood: z.string(),
  composition: z.string(),
});

const Output = z.object({
  descriptions: z.array(Description),
});

type In = z.infer<typeof Input>;
type Out = z.infer<typeof Output>;

// JSON schema passed via response_format=json_schema on llama-server.
// Constrains the model to exactly these fields.
const SCENE_JSON_SCHEMA = {
  type: "object",
  required: [
    "summary",
    "subject",
    "setting",
    "has_people",
    "has_visible_text",
    "visible_text",
    "mood",
    "composition",
  ],
  properties: {
    summary: { type: "string", maxLength: 240 },
    subject: { type: "string", maxLength: 80 },
    setting: {
      type: "string",
      enum: ["indoor", "outdoor", "studio", "graphic", "abstract", "unclear"],
    },
    has_people: { type: "boolean" },
    has_visible_text: { type: "boolean" },
    visible_text: { type: "string", maxLength: 200 },
    mood: {
      type: "string",
      enum: [
        "energetic",
        "calm",
        "dramatic",
        "playful",
        "neutral",
        "melancholic",
      ],
    },
    composition: {
      type: "string",
      enum: [
        "centered",
        "rule_of_thirds",
        "close_up",
        "wide",
        "extreme_close_up",
        "abstract",
      ],
    },
  },
};

const SCENE_PROMPT =
  "Describe this video frame for ad-creative editing decisions. Be concise " +
  "and concrete. Focus on what's shown, the primary subject, whether people " +
  "are visible, whether on-screen text exists (and what it says verbatim), " +
  "the mood, and the framing. Output strictly JSON matching the schema.";

export const DescribeScenesTool: Tool<In, Out> = {
  name: "DescribeScenes",
  description:
    "Run a local vision model (llama.cpp + Qwen2.5-VL or similar) over " +
    "representative frames of each scene, returning structured descriptions: " +
    "subject, setting, people/text presence, mood, composition. Requires " +
    "LLAMA_VLM_MODEL + LLAMA_VLM_MMPROJ env vars; offline, no API costs.",
  inputSchema: Input,
  // Deferred — only surfaces when the agent searches for vision-based
  // signal. Keeps turn-1 cache prefix small for runs that don't need it.
  shouldDefer: true,
  alwaysLoad: false,
  searchHint: "describe scenes vision content visual semantic",
  readonly: true,
  microCompactable: true,

  validateInput(input: unknown): In {
    return Input.parse(input);
  },

  async call(input: In, ctx: ToolUseContext) {
    const backend = pickBackend();
    if (backend === null) {
      return {
        ok: false as const,
        error:
          "no VLM backend configured. Set ANTHROPIC_API_KEY for hosted Claude vision (recommended), OR LLAMA_VLM_HF_REPO / (LLAMA_VLM_MODEL + LLAMA_VLM_MMPROJ) for local llama.cpp. Override automatic selection with LLAMA_VLM_BACKEND=claude|local.",
        retryable: false,
      };
    }

    const tmpDir = path.join(
      process.env.TMPDIR ?? "/tmp",
      `describe-scenes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await mkdir(tmpDir, { recursive: true });

    try {
      // Extract one frame per scene up front. Cheap (~50ms each) and the
      // frames are reused regardless of backend choice.
      const framePaths = await Promise.all(
        input.scenes.map(async (scene, i) => {
          const ts = Math.round(
            scene.start_ms +
              (scene.end_ms - scene.start_ms) * input.sample_position,
          );
          const p = path.join(tmpDir, `scene-${i}.png`);
          await runFfmpeg(
            [
              "-ss",
              (ts / 1000).toFixed(3),
              "-i",
              input.source_path,
              "-frames:v",
              "1",
              "-q:v",
              "2",
              p,
            ],
            ctx.abortSignal,
          );
          return p;
        }),
      );

      const descriptions: Out["descriptions"] = [];
      if (backend === "claude") {
        const result = await runClaudeBackend(
          input.scenes,
          framePaths,
          ctx.abortSignal,
        );
        if (!result.ok) return result;
        descriptions.push(...result.descriptions);
      } else {
        const result = await runLocalBackend(
          input.scenes,
          framePaths,
          ctx.abortSignal,
        );
        if (!result.ok) return result;
        descriptions.push(...result.descriptions);
      }
      return { ok: true as const, output: { descriptions } };
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  },
};

// Claude backend — parallel calls capped at CLAUDE_CONCURRENCY. Each
// scene gets its own Anthropic chat completion; results merged in order.
async function runClaudeBackend(
  scenes: readonly { start_ms: number; end_ms: number }[],
  framePaths: readonly string[],
  signal: AbortSignal,
): Promise<
  | { readonly ok: true; readonly descriptions: Out["descriptions"] }
  | { readonly ok: false; readonly error: string; readonly retryable: boolean }
> {
  const results: (Out["descriptions"][number] | null)[] = new Array(
    scenes.length,
  ).fill(null);
  // TS can't narrow a closed-over `let` after Promise.all (concurrent
  // workers might set it from any of them), so we keep it as a typed
  // mutable container and read .current at the end.
  const errBox: { current: { error: string; retryable: boolean } | null } = {
    current: null,
  };

  // Tiny fixed-pool concurrency limiter. Avoids pulling in p-limit.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= scenes.length) return;
      if (errBox.current !== null) return;
      const scene = scenes[i]!;
      try {
        const stdout = await describeImageWithClaude({
          imagePath: framePaths[i]!,
          prompt: SCENE_PROMPT,
          jsonSchema: SCENE_JSON_SCHEMA,
          signal,
        });
        const parsed = parseSceneJson(stdout);
        if (parsed === null) {
          errBox.current = {
            error: `failed to parse JSON for scene ${i}: ${truncate(stdout, 200)}`,
            retryable: true,
          };
          return;
        }
        results[i] = {
          scene_index: i,
          start_ms: scene.start_ms,
          end_ms: scene.end_ms,
          ...parsed,
        };
      } catch (e) {
        errBox.current = {
          error: `describe failed for scene ${i}: ${(e as Error).message}`,
          retryable: false,
        };
        return;
      }
    }
  }
  const pool = Array.from(
    { length: Math.min(CLAUDE_CONCURRENCY, scenes.length) },
    () => worker(),
  );
  await Promise.all(pool);
  const err = errBox.current;
  if (err !== null) {
    return { ok: false, error: err.error, retryable: err.retryable };
  }
  return {
    ok: true,
    descriptions: results.filter(
      (d): d is Out["descriptions"][number] => d !== null,
    ),
  };
}

// Local llama-server backend — single session, sequential calls.
async function runLocalBackend(
  scenes: readonly { start_ms: number; end_ms: number }[],
  framePaths: readonly string[],
  signal: AbortSignal,
): Promise<
  | { readonly ok: true; readonly descriptions: Out["descriptions"] }
  | { readonly ok: false; readonly error: string; readonly retryable: boolean }
> {
  const session = new LlamaVisionSession();
  try {
    try {
      await session.start();
    } catch (e) {
      return {
        ok: false,
        error: `llama-server failed to start: ${(e as Error).message}`,
        retryable: false,
      };
    }
    const descriptions: Out["descriptions"] = [];
    for (const [i, scene] of scenes.entries()) {
      let stdout: string;
      try {
        stdout = await session.describe({
          imagePath: framePaths[i]!,
          prompt: SCENE_PROMPT,
          jsonSchema: SCENE_JSON_SCHEMA,
          signal,
        });
      } catch (e) {
        return {
          ok: false,
          error: `describe failed for scene ${i}: ${(e as Error).message}`,
          retryable: false,
        };
      }
      const parsed = parseSceneJson(stdout);
      if (parsed === null) {
        return {
          ok: false,
          error: `failed to parse JSON for scene ${i}: ${truncate(stdout, 200)}`,
          retryable: true,
        };
      }
      descriptions.push({
        scene_index: i,
        start_ms: scene.start_ms,
        end_ms: scene.end_ms,
        ...parsed,
      });
    }
    return { ok: true, descriptions };
  } finally {
    await session.stop().catch(() => {});
  }
}

interface SceneJsonShape {
  readonly summary: string;
  readonly subject: string;
  readonly setting: string;
  readonly has_people: boolean;
  readonly has_visible_text: boolean;
  readonly visible_text: string;
  readonly mood: string;
  readonly composition: string;
}

function parseSceneJson(stdout: string): SceneJsonShape | null {
  // The grammar constrains output to JSON, but the binary sometimes
  // echoes the prompt or progress text first. Find the first {...}.
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < stdout.length; i++) {
    const ch = stdout[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return null;
  try {
    const raw = JSON.parse(stdout.slice(start, end)) as Record<
      string,
      unknown
    >;
    return {
      summary: String(raw.summary ?? ""),
      subject: String(raw.subject ?? ""),
      setting: String(raw.setting ?? "unclear"),
      has_people: Boolean(raw.has_people),
      has_visible_text: Boolean(raw.has_visible_text),
      visible_text: String(raw.visible_text ?? ""),
      mood: String(raw.mood ?? "neutral"),
      composition: String(raw.composition ?? "centered"),
    };
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

export const _DescribeScenesOutputSchema = Output;
export const _SCENE_JSON_SCHEMA_FOR_TEST = SCENE_JSON_SCHEMA;
export const _parseSceneJsonForTest = parseSceneJson;
