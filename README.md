# video-agent

An agentic video editing pipeline that turns long-form footage into platform-specific ad variants. Built on Claude (Anthropic SDK), with ffmpeg for media work, optional whisper.cpp for transcripts, and optional vision-language models for per-scene descriptions.

The system mirrors the architecture patterns of Claude Code: layered system prompts with cache-stable ordering, deferred tool loading via `ToolSearch`, plan-mode approval gates, magic-doc memory, and per-message persistence. Point it at a video and it analyses, plans, edits, renders, and (optionally) submits to ad platforms.

---

## What it does

Given a brand, a campaign, and a source video, the **EditingAgent**:

1. Loads a 5-layer system prompt — identity, brand guidelines, campaign rules, performance memory, and the current asset spec.
2. Analyses the video — `VideoAnalyse` (probe), `SceneDetect` (cut detection), `RichAnalysis` (loudness, palette, motion), optional `OCR`, `TranscriptExtract`, and `DescribeScenes` (VLM).
3. Plans the edit — enters plan mode, drafts an `EditPlan` per variant spec, and submits via `ExitPlanMode` for approval (auto-approve in `--execute`, interactive y/N in `--chat`).
4. Renders — `TrimClip`, `OverlayAsset`, `AdjustAudio` produce intermediates; `RenderVariant` assembles each output.
5. Compliance — an opt-in `ComplianceAgent` reasons over rendered frames against brand guidelines and platform spec.
6. Persists — `EditPlan` sidecars and a `batch.json` flush to disk under `storage/<brand>/<campaign>/<asset>/`.

Optional layers add real ASR (whisper.cpp), real video generation (Vertex AI: Veo + Imagen), and real ad delivery (per-platform MCP servers).

---

## Quick start

```bash
brew install bun ffmpeg
git clone <this-repo> video-agent && cd video-agent
bun install
bun run typecheck    # strict TS
bun test             # 171 pass / 4 skip / 0 fail

# Dry run — no API key, no API call. Prints the assembled context, tool registry, and compaction strategy.
bun run dev

# With an API key, run the agent end-to-end on a synthetic source.
export ANTHROPIC_API_KEY=sk-ant-…
bun run dev -- --prep            # generates a 30s synthetic source.mp4
bun run dev -- --execute         # runs the EditingAgent on the demo source

# Or chat with the agent interactively against your own footage.
bun run dev -- --chat --source ~/Downloads/ad.mp4
```

---

## Modes

The CLI has six modes. Pick by flag.

| Command | What it does |
|---|---|
| `bun run dev` | Dry run. Prints assembled context, tool list, compaction strategy. No API call. |
| `bun run dev -- --prep` | Generate a 30s synthetic multi-scene source.mp4 + a tiny logo.png at the demo asset path. |
| `bun run dev -- --analyse <path>` | Analyse any video — `VideoAnalyse` + `SceneDetect` + `RichAnalysis` + `OCR` + per-scene VLM. No agent loop. |
| `bun run dev -- --analyse <path> --no-vision` | Same, but skip the VLM pass (cheaper, no API/model cost). |
| `bun run dev -- --execute` | Run the EditingAgent against the demo source. Needs `ANTHROPIC_API_KEY`. |
| `bun run dev -- --execute --source <path>` | Same, but ingest your own video at `<path>` first. |
| `bun run dev -- --chat` | Interactive REPL. Conversation persists across turns; plan-mode is y/N. |
| `bun run dev -- --chat --source <path>` | Chat against your own footage. |

---

## Layer 1 — pipeline-only (no API key)

Verifies the wiring. No tokens spent.

```bash
brew install bun ffmpeg
bun --version    # ≥ 1.0
ffmpeg -version  # any recent build

cd video-agent
bun install
bun run typecheck
bun test

bun run dev                 # dry run: prints context + tool registry
bun run dev -- --prep       # generate synthetic source.mp4
```

After `--prep`, the synthetic source lives at `storage/brand/demo-brand/campaigns/demo-campaign/assets/demo-asset/source.mp4`.

---

## Layer 2 — real EditingAgent (Anthropic API key)

```bash
export ANTHROPIC_API_KEY=sk-ant-…              # https://console.anthropic.com/
export MODEL=claude-sonnet-4-6                 # optional — defaults to claude-opus-4-7
bun run dev -- --prep                          # if you haven't already
bun run dev -- --execute
```

What you'll see at the end:

```
=== EditingAgent finished ===
AgentId: aediting-…
Status:  succeeded
Iters:   5
Tokens:  { input_tokens: …, output_tokens: …, cache_read_input_tokens: … }
Tool calls: { VideoAnalyse: 1, SceneDetect: 1, ExitPlanMode: 1, TrimClip: 4, RenderVariant: 2, … }
```

### Chat mode

A REPL backed by the same agent loop. Conversation persists between messages; plan-mode approval becomes a terminal y/N prompt.

```bash
bun run dev -- --chat                           # demo source
bun run dev -- --chat --source ~/path/ad.mp4    # your own video
```

Inside the REPL:

```
❯ analyse @~/Downloads/ad.mp4
… (agent runs VideoAnalyse / SceneDetect / RichAnalysis / OCR / VLM)
❯ now do a 15s tiktok variant — emphasise the climax around 00:18
… (agent calls EnterPlanMode → ExitPlanMode → submits a plan)
Plan submitted
  1 plan:
    1. demo-spec-tiktok  (3 scenes, 2 overlays, 15.0s, audio=original)
Approve and render? [y/N] y
❯ now do an instagram reel version, 12s
```

Slash commands:

| Command | Effect |
|---|---|
| `/help` | Show commands and session stats (tokens, tool calls, variants). |
| `/clear` | Reset conversation, discovery, and plan state. Brand/campaign/asset stay. |
| `/exit` | End the session. Same as `Ctrl-D`. |

`@` references — `@/abs/path`, `@~/foo`, `@./bar` — expand to absolute paths inline before the message reaches the model. Anything else (emails, `@everyone`) passes through.

Interrupting:

- **Ctrl-C during a turn** — cancels the in-flight model call and any pending tool dispatches. Conversation stays valid; you can send the next message.
- **Ctrl-C twice within 2s** — force exit.
- **Ctrl-C at the prompt** — graceful exit.

Per-message persistence: after each user message that produced renders, `EditPlan` sidecars and `batch.json` flush to disk under `storage/<brand>/<campaign>/<asset>/`. The accumulated batch is rewritten each flush, so `batch.json` always reflects every variant rendered in the session.

### Opt in to the real ComplianceAgent

By default `compliance` is the always-pass stub. To run the real ComplianceAgent (forks per render — costs more tokens):

```ts
import { spawnEditingAgent } from "./src/agent/spawnEditingAgent.ts";
import { runComplianceAgent } from "./src/compliance/runComplianceAgent.ts";

await spawnEditingAgent({
  brandId, campaignId, assetId,
  compliance: runComplianceAgent,
});
```

The ComplianceAgent calls `ExtractFrames` (4 inline images of the rendered variant) and reasons against brand guidelines + platform spec.

---

## Layer 3 — real ASR, vision, video generation, ad delivery

Each opt-in is independent.

### 3a. Real transcripts (whisper.cpp)

```bash
brew install whisper-cpp

# Recommended — multilingual base. Auto-detects language. ~140MB.
mkdir -p ~/whisper-models
curl -L -o ~/whisper-models/ggml-base.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
export WHISPER_MODEL=~/whisper-models/ggml-base.bin
```

> The English-only variant (`ggml-base.en.bin`) is slightly more accurate on English audio but hallucinates ("English English English…") on non-English input. Pick the multilingual model unless 100% of your footage is English.

Verify:

```bash
TEST_REAL_WHISPER_MODEL=~/whisper-models/ggml-base.bin \
  bun test src/integration/transcriptExtract.test.ts
```

### 3b. Per-scene visual descriptions (auto-on with `--analyse`)

`DescribeScenes` runs a VLM on a midpoint frame of selected scenes and adds a paragraph + structured tags (subject, setting, mood, composition, on-screen text, people presence) to the analyse output. Runs automatically when a backend is configured; pass `--no-vision` to skip.

Two backends, picked automatically:

**Backend 1 — hosted Claude vision (recommended).** Uses your `ANTHROPIC_API_KEY`. Zero new install, parallel calls (~10–15s for 22 scenes). ~$0.10–0.20 per video on Sonnet 4.6.

```bash
export ANTHROPIC_API_KEY=sk-ant-…
bun run dev -- --analyse ~/Downloads/ad.mp4
```

**Backend 2 — local llama.cpp.** Fully offline, free per call after setup. Sequential, ~30s for 22 scenes. Frames never leave the machine.

```bash
brew install llama.cpp

# Easiest: point at a HuggingFace repo. llama.cpp auto-downloads + caches at
# ~/Library/Caches/llama.cpp/. Includes the mmproj projector. ~5GB total.
export LLAMA_VLM_HF_REPO=ggml-org/Qwen2.5-VL-7B-Instruct-GGUF
# Optional — pin a specific quantisation:
#   export LLAMA_VLM_HF_QUANT=Q4_K_M

# Or, if you've already downloaded the GGUFs by hand:
#   export LLAMA_VLM_MODEL=~/path/Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf
#   export LLAMA_VLM_MMPROJ=~/path/mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf

bun run dev -- --analyse ~/Downloads/ad.mp4
```

Force a specific backend:

```bash
export LLAMA_VLM_BACKEND=claude   # or =local
```

Sample output:

```
Scenes (22):
   0.  00:00.00 → 00:02.84    2.84s   124/255    ▓▓▓ rgb(132,118,98)
        Outdoor lifestyle shot — two people sitting on a wooden bench, golden-hour light.
        subject: lifestyle  ·  setting: outdoor  ·  mood: calm  ·  composition: rule_of_thirds  ·  people
   1.  00:02.84 → 00:05.04    2.20s    88/255    ▓▓▓ rgb(45,52,98)
        Product close-up against deep blue backdrop, label readable.
        subject: product close-up  ·  setting: studio  ·  mood: dramatic  ·  composition: close_up  ·  text: "EVERY DAY"
```

The same tool is registered as a deferred tool for the EditingAgent — it can opt in via `ToolSearch` when planning edits. Without a backend configured, the tool returns a "not configured" error and the agent moves on.

**Performance.** Sequential by design — each invocation reloads the model (~1–3s startup + ~50–150 tok/s). For a 22-scene video on M2/M3 Max expect ~30–60s. For high-volume use, run `llama-server` instead (model stays resident).

### 3c. Real generated video (Vertex AI — Veo + Imagen)

The most expensive layer. Requires a Google Cloud account with Model Garden access.

```bash
bun add @google-cloud/aiplatform @google-cloud/storage

# Auth — pick one
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
# OR
gcloud auth application-default login

export GOOGLE_CLOUD_PROJECT=your-project-id
export VERTEX_REGION=us-central1
export USE_REAL_VIDEO_GEN=1     # hard gate — without this, lavfi stubs run
```

`GenerateShot` then routes per `src/generation/routeShot.ts`:

- Static short shots → Imagen 4 → upscaled to video
- `product_demo` + `photorealistic` → Veo 3 (premium)
- Everything else → Veo 2

> The SDK call sites in `src/generation/models/{imageGen,videoGenV1,videoGenV2}.ts` are graceful-degrade stubs that fall back to lavfi when Vertex isn't configured. To activate real Vertex calls, fill in the marked sites (~200 LOC of straightforward Vertex SDK code per the comments). Without that, real Vertex won't run even with the env flags set; you'll see a "falling back to lavfi stub" warning.

### 3d. Real ad delivery (MCP servers)

Each platform is its own MCP server. The mock server lives at `src/mcp/servers/mockAdPlatform.ts`.

Run the mock as a stdio process:

```ts
// scripts/run-mock-ad-platform.ts
import { mockHandler } from "../src/mcp/servers/mockAdPlatform.ts";
import { runStdioServer } from "../src/mcp/Server.ts";
await runStdioServer(mockHandler);
```

```bash
export VIDEO_AGENT_MCP_TIKTOK="stdio://bun run scripts/run-mock-ad-platform.ts"
export VIDEO_AGENT_MCP_META="stdio://bun run scripts/run-mock-ad-platform.ts"
```

For HTTP (real platforms expose this):

```bash
export VIDEO_AGENT_MCP_TIKTOK="https://your-tiktok-mcp-bridge.example.com/mcp"
```

The agent calls `DeliverToAdPlatform` with `{platform, variant_spec_id, asset_id, output_path, compliance_check_id, estimated_spend?}`. The clearance gate (Tier 2) and budget gate (Tier 3) run before the call. Receipts persist under `storage/brand/{id}/campaigns/{id}/deliveries/`.

Configure a budget for the demo brand:

```bash
mkdir -p storage/brand/demo-brand
cat > storage/brand/demo-brand/budget.json <<EOF
{ "total": 10000, "spent": 0, "currency": "USD" }
EOF
```

---

## Storage layout

```
storage/
├── brand/
│   └── {brand_id}/
│       ├── guidelines.md                # MagicDoc — auto-updates between runs
│       ├── performance_memory.md        # capped 200 lines / 25KB
│       ├── budget.json                  # Tier 3 gate
│       ├── performance_gate.json        # PerformanceAgent state
│       └── campaigns/
│           └── {campaign_id}/
│               ├── brief.md
│               ├── variant_specs.json
│               ├── sessions/
│               │   └── {session_id}/
│               │       └── session_memory.md
│               ├── deliveries/
│               │   └── {receipt_id}.json
│               ├── edit_plans/
│               │   └── {plan_id}.json
│               └── assets/
│                   └── {asset_id}/
│                       ├── source.mp4
│                       ├── metadata.json
│                       └── variants/
│                           ├── {variant_spec_id}.mp4
│                           ├── {variant_spec_id}_metadata.json
│                           ├── {variant_spec_id}_clearance.json
│                           └── batch.json
└── .cron-locks/                         # cron task locks
```

Override the root with `VIDEO_AGENT_STORAGE=/some/path` (the test suite uses this).

---

## Environment variables

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Required for `--execute`, `--chat`, and Claude-backed VLM. |
| `MODEL` | Override the agent model. Defaults to `claude-opus-4-7`. |
| `WHISPER_MODEL` | Path to a `ggml-*.bin` file. Enables `TranscriptExtract`. |
| `LLAMA_VLM_HF_REPO` | HuggingFace repo for local VLM (e.g. `ggml-org/Qwen2.5-VL-7B-Instruct-GGUF`). |
| `LLAMA_VLM_HF_QUANT` | Optional quant pin (e.g. `Q4_K_M`). |
| `LLAMA_VLM_MODEL`, `LLAMA_VLM_MMPROJ` | Manual GGUF + projector paths (alternative to `_HF_REPO`). |
| `LLAMA_VLM_BACKEND` | Force `claude` or `local` when both are configured. |
| `GOOGLE_APPLICATION_CREDENTIALS` / `GOOGLE_CLOUD_PROJECT` / `VERTEX_REGION` | Vertex AI auth + project. |
| `USE_REAL_VIDEO_GEN` | Hard gate for Veo/Imagen calls — without this, lavfi stubs run. |
| `VIDEO_AGENT_MCP_<PLATFORM>` | MCP endpoint (`stdio://…` or `https://…`) for ad delivery. |
| `VIDEO_AGENT_STORAGE` | Override the storage root. |
| `VIDEO_AGENT_LOGO_OVERLAY_ON_TOP` | Use overlay-on-top fallback for `logo_position` fixes. |
| `TEST_REAL_WHISPER_MODEL` | Opt-in test gate for whisper accuracy on real audio. |

---

## Tests

```bash
bun test                  # 171 pass / 4 skip / 0 fail
bun test src/agent/       # subset
bun test --watch          # watch mode
```

The 4 skips are opt-in tests gated on `ANTHROPIC_API_KEY`, `TEST_REAL_WHISPER_MODEL`, or Vertex/GCP env.

---

## Architecture in one paragraph

The system mirrors Claude Code's agentic patterns: a 5-layer system prompt (`src/context/buildEditingAgentContext.ts`) with cache-stable ordering — identity → brand guidelines → campaign rules → performance memory → asset state — so the prefix stays cached across all render jobs. Tools are registered with `alwaysLoad`/`shouldDefer` flags (`src/tools/registry.ts`); the agent surfaces deferred tools via `ToolSearch` only when needed. Plan mode (`EnterPlanMode` → `ExitPlanMode`) gates rendering behind explicit approval. Magic docs (`src/magicDocs/`) self-update between runs with hard 200-line/25KB caps for cache stability. Compaction (`src/compact/`) uses token-count buffers (`AUTOCOMPACT_BUFFER_TOKENS = 13_000`), not percent thresholds. Forked-agent state (`FileStateCache`, `DenialTrackingState`) keeps subagents isolated; the swarm permission bridge (`permissionSync` + `leaderPermissionBridge`) handles leader escalation. See `intial-plan.md` for the full design.

---

## Troubleshooting

**`ANTHROPIC_API_KEY not set`** when running with `--execute` → you forgot `export ANTHROPIC_API_KEY=…`.

**`Source video missing`** → run `bun run dev -- --prep`, or drop your own mp4 at `storage/brand/demo-brand/campaigns/demo-campaign/assets/demo-asset/source.mp4`.

**`WHISPER_MODEL env var not set`** when the agent calls `TranscriptExtract` → either set the env var pointing at a `ggml-*.bin` file, or remove `TranscriptExtract` from the deferred-tool list in `src/tools/registry.ts` if you don't need it.

**ffmpeg/ffprobe not found** → `brew install ffmpeg` and verify `which ffmpeg`. Integration tests skip cleanly if missing, but `--execute` will fail when `RenderVariant` runs.

**`for-tests-ggml-tiny.bin` returns empty transcripts** → that's whisper.cpp's CI fixture, not a real model. Download `ggml-base.bin` per §3a.

**Transcript shows the same word repeated** ("English English English…", "Yeah Yeah Yeah…") → you're using an English-only model on non-English audio. Whisper's `.en` variants chant their nearest English-sounding token. The hallucination filter in `binWordsByScene` drops these per scene; the proper fix is `export WHISPER_MODEL=~/whisper-models/ggml-base.bin` (multilingual).

**Cache miss every run** → check that `buildEditingAgentContext` is byte-deterministic. The `is byte-deterministic across builds for identical inputs` test verifies the invariant; if it fails, a loader is leaking timestamp/mtime/locale-dependent content into a stable layer.

**`leader denied`** in tool error output → an `escalate_to_leader` outcome routed through `permissionSync` and the leader handler returned `allowed: false`. The default Phase-1 handler always approves; check `permissionSync.setHandler(...)` if you've swapped in a custom handler.

**`render rejected by compliance`** in tool error output → `onRenderComplete` surfaced `needs_rerender` (default for `logo_position` fixes). The agent should re-issue `RenderVariant` with adjusted upstream `OverlayAsset` calls. Fall back to overlay-on-top with `export VIDEO_AGENT_LOGO_OVERLAY_ON_TOP=1`.

**Cron tasks not firing** → start the scheduler explicitly: `cronScheduler.start()`. The CLI doesn't auto-start it; hosts that want background tasks register them and call `start()`.

---

## License

Private / unpublished. No license granted.
