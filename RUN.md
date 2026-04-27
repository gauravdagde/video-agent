# Running video-agent

A focused runbook. Three layers of setup — pick your stopping point.

- **Layer 1 (no API keys, no GPU):** clone, install deps, generate placeholder mp4s. Verifies the pipeline.
- **Layer 2 (Anthropic API key):** real EditingAgent runs against synthetic source. Real reasoning, lavfi-stub video.
- **Layer 3 (Vertex AI + whisper):** real transcripts and real generated video. Costs money.

---

## Layer 1 — pipeline-only run (zero API keys)

### 1. Prerequisites

```bash
# Required
brew install bun ffmpeg

# Verify
bun --version    # ≥ 1.0
ffmpeg -version  # any recent build
ffprobe -version
```

### 2. Install + sanity check

```bash
cd /Users/gauravdagde/Projects/personal/video-agent
bun install
bun run typecheck     # → exits clean
bun test              # → 171 pass / 4 skip / 0 fail
```

### 3. Dry-run (no API call)

```bash
bun run dev
```

Prints the assembled context, tool list, and compaction strategy. Burns no tokens. Use this to verify the loader/registry wiring after any change.

### 4. Generate a synthetic source video

```bash
bun run dev -- --prep
```

Writes a 30-second `testsrc + sine` clip to `storage/brand/demo-brand/campaigns/demo-campaign/assets/demo-asset/source.mp4`.

That's the limit of Layer 1 — there's no agent activity without an API key.

---

## Layer 2 — real EditingAgent against synthetic source

### Add the API key

Get one at <https://console.anthropic.com/>, then:

```bash
export ANTHROPIC_API_KEY=sk-ant-…
```

Optional model override (defaults to `claude-opus-4-7`):

```bash
export MODEL=claude-sonnet-4-6   # or any model on your account
```

### Run the EditingAgent end-to-end

```bash
bun run dev -- --prep    # if not already done
bun run dev -- --execute
```

What happens:
1. The EditingAgent loads its 5-layer system prompt (identity / brand / campaign / performance memory / dynamic asset+specs).
2. ToolSearch surfaces the deferred analysis tools.
3. The agent calls `VideoAnalyse` / `SceneDetect` / (optionally `TranscriptExtract` if WHISPER_MODEL is set).
4. ExitPlanMode submits an EditPlan; the auto-approver accepts it.
5. The agent calls `TrimClip` / `OverlayAsset` / `AdjustAudio` to produce intermediate clips.
6. `RenderVariant` assembles each variant; `onRenderComplete` runs the (default-stub) compliance check and stamps a clearance.
7. EditPlans + a VariantBatch JSON are persisted under `storage/.../variants/`.

You'll see the run summary at the end:

```
=== EditingAgent finished ===
AgentId: aediting-…
Status:  succeeded
Iters:   5
Tokens:  { input_tokens: …, output_tokens: …, cache_read_input_tokens: … }
Tool calls: { VideoAnalyse: 1, SceneDetect: 1, ExitPlanMode: 1, TrimClip: 4, RenderVariant: 2, … }
```

### Opt in to the real ComplianceAgent

By default `compliance` is the always-pass stub. To run the actual ComplianceAgent (forks per render — costs more tokens):

In a host script:

```ts
import { spawnEditingAgent } from "./src/agent/spawnEditingAgent.ts";
import { runComplianceAgent } from "./src/compliance/runComplianceAgent.ts";

await spawnEditingAgent({
  brandId, campaignId, assetId,
  compliance: runComplianceAgent,   // ← opt-in
});
```

The ComplianceAgent will call `ExtractFrames` (4 inline images of the rendered variant) and reason against brand guidelines + platform spec.

---

## Layer 3 — real ASR, real video generation, real ad delivery

Each of these is independent — turn on only what you need.

### 3a. Real transcripts (whisper.cpp)

```bash
brew install whisper-cpp

# Download a real model (the one bundled with brew is a 562KB CI stub).
mkdir -p ~/whisper-models
curl -L -o ~/whisper-models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin

# Tell the system where it is
export WHISPER_MODEL=~/whisper-models/ggml-base.en.bin
```

Now `TranscriptExtract` does real ASR. To verify:

```bash
TEST_REAL_WHISPER_MODEL=~/whisper-models/ggml-base.en.bin \
  bun test src/integration/transcriptExtract.test.ts
```

### 3b. Real generated video (Vertex AI: Veo + Imagen)

This requires a Google Cloud account with Model Garden access and is the most expensive layer.

```bash
# Install the SDKs (not pre-installed because they're optional)
bun add @google-cloud/aiplatform @google-cloud/storage

# Auth — pick one
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
# OR
gcloud auth application-default login

# Required env
export GOOGLE_CLOUD_PROJECT=your-project-id
export VERTEX_REGION=us-central1     # default
export USE_REAL_VIDEO_GEN=1           # hard gate — without this, lavfi stubs run
```

Now `GenerateShot` calls real Vertex models per the dispatcher in `src/generation/routeShot.ts`:
- Static short shots → Imagen 4 → upscaled to video
- `product_demo` + `photorealistic` → Veo 3 (premium)
- Everything else → Veo 2

**Note:** the SDK call sites in `src/generation/models/{imageGen,videoGenV1,videoGenV2}.ts` are currently graceful-degrade stubs that fall back to lavfi when Vertex isn't configured. To activate real Vertex calls, fill in the marked sites — about 200 LOC of straightforward Vertex SDK code per the comments in those files. Without that, real Vertex won't run even with the env flags set; you'll see a "falling back to lavfi stub" warning.

### 3c. Real ad delivery (MCP servers)

Each platform is its own MCP server. The mock server is in `src/mcp/servers/mockAdPlatform.ts`.

To run the mock as a stdio process:

```ts
// scripts/run-mock-ad-platform.ts
import { mockHandler } from "../src/mcp/servers/mockAdPlatform.ts";
import { runStdioServer } from "../src/mcp/Server.ts";
await runStdioServer(mockHandler);
```

```bash
# Then point the env at it
export VIDEO_AGENT_MCP_TIKTOK="stdio://bun run scripts/run-mock-ad-platform.ts"
export VIDEO_AGENT_MCP_META="stdio://bun run scripts/run-mock-ad-platform.ts"
```

For HTTP (real platforms expose this):

```bash
export VIDEO_AGENT_MCP_TIKTOK="https://your-tiktok-mcp-bridge.example.com/mcp"
```

The agent will call `DeliverToAdPlatform` with `{platform, variant_spec_id, asset_id, output_path, compliance_check_id, estimated_spend?}`. The clearance gate (Tier 2) and budget gate (Tier 3) run before the call. Receipts persist under `storage/brand/{id}/campaigns/{id}/deliveries/`.

To configure a budget for the demo brand:

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
│       ├── performance_gate.json        # PerformanceAgent state (last run / receipt count)
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
│                           ├── {variant_spec_id}_clearance.json    # gate input
│                           └── batch.json
└── .cron-locks/                         # cron task locks
```

Override the root with `VIDEO_AGENT_STORAGE=/some/path` (the test suite uses this).

---

## Tests

```bash
bun test                              # 171 pass / 4 skip / 0 fail
bun test src/agent/                   # subset
bun test --watch                      # watch mode
```

The 4 skips are opt-in tests gated on:
- `ANTHROPIC_API_KEY` (the agent integration test)
- `TEST_REAL_WHISPER_MODEL` (whisper accuracy on real audio)
- Vertex / GCP env (real Veo + Imagen — currently no test, future slot)

---

## Common commands cheat sheet

| Command                                          | What it does                                                |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `bun install`                                    | Install deps                                                |
| `bun run typecheck`                              | TypeScript strict mode check                                |
| `bun test`                                       | Full test suite                                             |
| `bun run dev`                                    | Dry-run — no API call, just print context + tool registry   |
| `bun run dev -- --prep`                          | Generate the synthetic demo source.mp4                      |
| `bun run dev -- --execute`                       | Run the EditingAgent end-to-end (needs ANTHROPIC_API_KEY)   |

---

## Troubleshooting

**"ANTHROPIC_API_KEY not set"** when running with `--execute` → you forgot `export ANTHROPIC_API_KEY=…`.

**"Source video missing"** → run `bun run dev -- --prep` first, OR drop your own mp4 at `storage/brand/demo-brand/campaigns/demo-campaign/assets/demo-asset/source.mp4`.

**"WHISPER_MODEL env var not set"** when the agent calls `TranscriptExtract` → either set the env var pointing at a `ggml-*.bin` file, OR remove `TranscriptExtract` from the deferred-tool list in `src/tools/registry.ts` if you're sure you don't need it.

**ffmpeg/ffprobe not found** → `brew install ffmpeg` and verify `which ffmpeg`. The integration tests skip cleanly if missing, but `--execute` will fail when `RenderVariant` runs.

**`for-tests-ggml-tiny.bin` returns empty transcripts** → that model is whisper.cpp's CI fixture, not a real model. Download `ggml-base.en.bin` per the §3a instructions.

**Cache miss every run** → check that `buildEditingAgentContext` is byte-deterministic. The `is byte-deterministic across builds for identical inputs` test verifies the invariant; if it fails, a loader is leaking timestamp/mtime/locale-dependent content into a stable layer.

**"leader denied"** in tool error output → an `escalate_to_leader` outcome routed through `permissionSync` and the leader handler returned `allowed: false`. Default Phase-1 handler always approves; check `permissionSync.setHandler(...)` if you've swapped in a custom handler.

**"render rejected by compliance"** in tool error output → the `onRenderComplete` hook surfaced `needs_rerender` (default behaviour for `logo_position` fixes — see T3.5 in the plan). The agent should re-issue `RenderVariant` with adjusted upstream `OverlayAsset` calls. To fall back to overlay-on-top: `export VIDEO_AGENT_LOGO_OVERLAY_ON_TOP=1`.

**Cron tasks not firing** → start the scheduler explicitly: `cronScheduler.start()`. The CLI doesn't auto-start it; hosts that want background tasks register them and call `start()`.
