// llama.cpp multimodal — session-based.
//
// First version of this file used `llama-mtmd-cli` per scene. That
// reloads the 5GB model on every invocation (~1-3s × N scenes = 30-60s
// of pure model-loading overhead for a 22-scene video). Unusable.
//
// This version uses `llama-server`: spawn once, hit the OpenAI-compatible
// /v1/chat/completions endpoint per scene, kill on close. Model stays
// resident → ~10s startup + ~1s per scene = ~30s total for 22 scenes
// (was ~60-90s).
//
// Two ways to configure the model:
//
// 1. Hugging Face repo (easiest — auto-downloads, caches at
//    ~/Library/Caches/llama.cpp/ on macOS, picks up the mmproj automatically):
//      brew install llama.cpp
//      export LLAMA_VLM_HF_REPO=ggml-org/Qwen2.5-VL-7B-Instruct-GGUF
//      # optional: pin a specific quantisation
//      export LLAMA_VLM_HF_QUANT=Q4_K_M
//
// 2. Local files (when you've already downloaded GGUFs):
//      export LLAMA_VLM_MODEL=~/llama-models/qwen2.5-vl-7b/...Q4_K_M.gguf
//      export LLAMA_VLM_MMPROJ=~/llama-models/qwen2.5-vl-7b/mmproj-...-f16.gguf

import { readFile } from "node:fs/promises";

const DEFAULT_BIN = "llama-server";
const DEFAULT_PORT = 18080;
const STARTUP_TIMEOUT_MS = 120_000; // bumped to cover first-run HF download
const STARTUP_POLL_MS = 200;

function llamaServerBin(): string {
  return process.env.LLAMA_BIN ?? DEFAULT_BIN;
}

function llamaServerPort(): number {
  const env = process.env.LLAMA_VLM_PORT;
  if (env === undefined || env === "") return DEFAULT_PORT;
  const parsed = parseInt(env, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_PORT;
}

// Two configuration shapes — HF auto-download or explicit local files.
export type LlamaVisionConfig =
  | { readonly kind: "hf"; readonly repo: string; readonly quant?: string }
  | {
      readonly kind: "files";
      readonly model: string;
      readonly mmproj: string;
    };

export function getLlamaVisionConfig(): LlamaVisionConfig | null {
  // HF repo path takes precedence — it's the more ergonomic option.
  const repo = process.env.LLAMA_VLM_HF_REPO ?? "";
  if (repo.length > 0) {
    const quant = process.env.LLAMA_VLM_HF_QUANT ?? "";
    return quant.length > 0
      ? { kind: "hf", repo, quant }
      : { kind: "hf", repo };
  }
  const model = process.env.LLAMA_VLM_MODEL ?? "";
  const mmproj = process.env.LLAMA_VLM_MMPROJ ?? "";
  if (model.length === 0 || mmproj.length === 0) return null;
  return { kind: "files", model, mmproj };
}

// Build the model-source args from a config. -hf includes mmproj
// auto-download; --no-mmproj disables that behaviour for non-vision
// repos, but we want it ENABLED for VLMs (the default).
function modelArgs(cfg: LlamaVisionConfig): readonly string[] {
  if (cfg.kind === "hf") {
    const ref = cfg.quant !== undefined ? `${cfg.repo}:${cfg.quant}` : cfg.repo;
    return ["-hf", ref];
  }
  return ["-m", cfg.model, "--mmproj", cfg.mmproj];
}

export interface DescribeImageOpts {
  readonly imagePath: string;
  readonly prompt: string;
  // When present, constrains output via response_format=json_schema on
  // llama-server's OpenAI-compatible endpoint.
  readonly jsonSchema?: unknown;
  readonly maxTokens?: number;
  readonly signal: AbortSignal;
}

const DEFAULT_MAX_TOKENS = 400;

// Manages the lifecycle of one llama-server process. Spawn once, reuse
// for every describe() call within a session, kill on close. Drains
// stdio so the OS pipe buffer doesn't fill and stall the server.
export class LlamaVisionSession {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private port: number = DEFAULT_PORT;
  private baseUrl: string = "";
  private startupAbort: AbortController | null = null;
  private stderrTail: string = "";

  async start(): Promise<void> {
    const cfg = getLlamaVisionConfig();
    if (cfg === null) {
      throw new Error(
        "llama vision not configured — set LLAMA_VLM_HF_REPO or (LLAMA_VLM_MODEL + LLAMA_VLM_MMPROJ)",
      );
    }
    this.port = llamaServerPort();
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    this.startupAbort = new AbortController();

    this.proc = Bun.spawn(
      [
        llamaServerBin(),
        ...modelArgs(cfg),
        "--host",
        "127.0.0.1",
        "--port",
        String(this.port),
        "-ngl",
        "99",
        "--log-disable",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        signal: this.startupAbort.signal,
      },
    );

    // Drain pipes so the kernel buffer doesn't fill. We keep a rolling
    // tail of stderr so a startup-failure error includes useful context.
    if (this.proc.stdout !== undefined) {
      this.drainPipe(this.proc.stdout, () => {});
    }
    if (this.proc.stderr !== undefined) {
      this.drainPipe(this.proc.stderr, (chunk) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-2000);
      });
    }

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const exited = this.proc.exitCode;
      if (exited !== null) {
        throw new Error(
          `llama-server exited ${exited} during startup: ${truncate(this.stderrTail, 800)}`,
        );
      }
      try {
        const r = await fetch(`${this.baseUrl}/health`);
        if (r.ok) return;
      } catch {
        // Connection refused — server not listening yet.
      }
      await Bun.sleep(STARTUP_POLL_MS);
    }
    throw new Error(
      `llama-server did not become ready within ${STARTUP_TIMEOUT_MS}ms — port ${this.port} may be in use, or model load is slow. Set LLAMA_VLM_PORT to override.`,
    );
  }

  async describe(opts: DescribeImageOpts): Promise<string> {
    if (this.proc === null) {
      throw new Error("LlamaVisionSession.describe called before start()");
    }
    const bytes = await readFile(opts.imagePath);
    const b64 = bytes.toString("base64");

    const body: Record<string, unknown> = {
      model: "default",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${b64}` },
            },
            { type: "text", text: opts.prompt },
          ],
        },
      ],
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: 0,
    };
    if (opts.jsonSchema !== undefined) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "scene", schema: opts.jsonSchema },
      };
    }

    const r = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "<unreadable>");
      throw new Error(`llama-server ${r.status}: ${truncate(text, 400)}`);
    }
    const data = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content ?? "";
  }

  async stop(): Promise<void> {
    if (this.proc !== null) {
      this.proc.kill();
      try {
        await this.proc.exited;
      } catch {
        // Killed — ignore.
      }
      this.proc = null;
    }
    if (this.startupAbort !== null) {
      this.startupAbort.abort();
      this.startupAbort = null;
    }
  }

  private drainPipe(
    stream: ReadableStream<Uint8Array> | number,
    onChunk: (s: string) => void,
  ): void {
    if (typeof stream === "number") return;
    void (async () => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const r = await reader.read();
          if (r.done) return;
          onChunk(decoder.decode(r.value, { stream: true }));
        }
      } catch {
        // Stream closed — done.
      }
    })();
  }
}

// One-shot describe: open session, run, close. For multi-frame use,
// hold a LlamaVisionSession yourself so the model stays resident across
// calls.
export async function describeImage(
  opts: DescribeImageOpts,
): Promise<string> {
  const session = new LlamaVisionSession();
  await session.start();
  try {
    return await session.describe(opts);
  } finally {
    await session.stop();
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
