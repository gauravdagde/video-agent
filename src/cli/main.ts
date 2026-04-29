// Phase 1 entrypoint. Six modes:
//   bun run dev                                  — dry run: assemble context + tool params, print, exit
//   bun run dev -- --prep                        — generate a synthetic source.mp4 at the demo asset path
//   bun run dev -- --analyse <path>              — analyse a video: VideoAnalyse + SceneDetect + RichAnalysis
//                                                  + OCR + per-scene VLM descriptions (auto-on when a backend is configured)
//                                                  Add --no-vision to skip the VLM pass.
//   bun run dev -- --execute                     — call Claude with the editing brief on the demo source
//   bun run dev -- --execute --source <p>        — same, but with YOUR video at <p>
//   bun run dev -- --chat                        — open a chat-mode REPL (like Claude Code). Type to interact;
//                                                  /help for commands, /exit to quit. Combine with --source <p>.
//
// Typical first-time flow:
//   bun run dev -- --prep && export ANTHROPIC_API_KEY=… && bun run dev -- --execute
// Analyse your own footage (vision included automatically):
//   export ANTHROPIC_API_KEY=… && bun run dev -- --analyse ~/Downloads/ad.mp4
// Chat with the agent:
//   export ANTHROPIC_API_KEY=… && bun run dev -- --chat --source ~/Downloads/ad.mp4

import { existsSync } from "node:fs";
import { Conversation } from "../chat/Conversation.ts";
import {
  createApproverBridge,
  createChatPlanApprover,
} from "../chat/approver.ts";
import { runRepl } from "../chat/repl.ts";
import { editingAgentCompactStrategy } from "../compact/CompactStrategy.ts";
import { buildEditingAgentContext } from "../context/buildEditingAgentContext.ts";
import { spawnEditingAgent } from "../agent/spawnEditingAgent.ts";
import { storagePaths } from "../storage/paths.ts";
import {
  DescribeScenesTool,
  pickBackend,
} from "../tools/analysis/DescribeScenes.ts";
import { runScenesOcr, type SceneOcrResult } from "../tools/analysis/ocr.ts";
import { runRichAnalysis } from "../tools/analysis/richAnalyse.ts";
import { SceneDetectTool } from "../tools/analysis/SceneDetect.ts";
import { TranscriptExtractTool } from "../tools/analysis/TranscriptExtract.ts";
import { VideoAnalyseTool } from "../tools/analysis/VideoAnalyse.ts";
import { runFfmpeg } from "../tools/ffmpeg.ts";
import { editingAgentTools } from "../tools/registry.ts";
import {
  deferredTools,
  loadedToolsForTurn1,
} from "../Tool.ts";
import type {
  AssetId,
  BrandId,
  CampaignId,
} from "../types/video.ts";
import { createCliRenderer } from "../ui/cli.ts";

const BRAND = "demo-brand" as BrandId;
const CAMPAIGN = "demo-campaign" as CampaignId;
const ASSET = "demo-asset" as AssetId;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--prep")) {
    await prep();
    return;
  }

  // --analyse <path> — analyse any video. The VLM pass auto-runs when a
  // backend is configured (ANTHROPIC_API_KEY for Claude, or
  // LLAMA_VLM_HF_REPO / LLAMA_VLM_MODEL for local llama). Pass
  // --no-vision to skip even when configured.
  const analyseIdx = args.indexOf("--analyse");
  if (analyseIdx >= 0) {
    const target = args[analyseIdx + 1];
    if (target === undefined) {
      console.error("--analyse requires a path argument");
      process.exit(1);
    }
    const noVision = args.includes("--no-vision");
    await analyse(target, !noVision);
    return;
  }

  if (args.includes("--chat")) {
    await chat(args);
    return;
  }

  const execute = args.includes("--execute");

  if (!execute) {
    await dryRun();
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY not set. Run without --execute for a dry run.",
    );
    process.exit(1);
  }

  // --source <path> swaps in your own footage. Copies into the demo
  // asset path and re-runs VideoAnalyse to update metadata.json so the
  // agent's context reflects the real file.
  const sourceIdx = args.indexOf("--source");
  if (sourceIdx >= 0) {
    const target = args[sourceIdx + 1];
    if (target === undefined) {
      console.error("--source requires a path argument");
      process.exit(1);
    }
    await ingestSource(target);
  }

  const sourcePath = storagePaths.assetSource(BRAND, CAMPAIGN, ASSET);
  if (!existsSync(sourcePath)) {
    console.error(
      `Source video missing: ${sourcePath}\n` +
        "Either:\n" +
        "  • bun run dev -- --prep                       (synthetic source)\n" +
        "  • bun run dev -- --execute --source <path>    (your own video)",
    );
    process.exit(1);
  }

  const ui = createCliRenderer();
  ui.banner(
    "EditingAgent",
    `${BRAND} / ${CAMPAIGN} / ${ASSET}`,
  );

  const startedAt = Date.now();
  let result: Awaited<ReturnType<typeof spawnEditingAgent>>;
  try {
    result = await spawnEditingAgent({
      brandId: BRAND,
      campaignId: CAMPAIGN,
      assetId: ASSET,
      ui,
    });
  } catch (e) {
    ui.fail(e as Error);
    process.exit(1);
  }

  ui.finish({
    agentId: result.task.id,
    status: result.task.status,
    iterations: result.run.iterations,
    elapsedMs: Date.now() - startedAt,
    tokens: {
      input: result.run.totalUsage.input_tokens,
      output: result.run.totalUsage.output_tokens,
      cacheRead: result.run.totalUsage.cache_read_input_tokens,
      cacheCreation: result.run.totalUsage.cache_creation_input_tokens,
    },
    toolCallsByName: result.run.toolCallsByName,
    extras: {
      "Approved plans": result.approvedPlans.length,
      "Rendered variants":
        result.run.toolCallsByName.RenderVariant ?? 0,
      "Batch file": result.persistedTo.batchFile,
    },
  });
}

async function prep(): Promise<void> {
  const sourcePath = storagePaths.assetSource(BRAND, CAMPAIGN, ASSET);
  if (existsSync(sourcePath)) {
    console.log(`Source already exists at ${sourcePath} — nothing to do.`);
    return;
  }

  const { mkdir } = await import("node:fs/promises");
  await mkdir(
    storagePaths.asset(BRAND, CAMPAIGN, ASSET),
    { recursive: true },
  );

  console.log(`Generating multi-scene synthetic source → ${sourcePath}`);
  // Three visually distinct 10s segments (testsrc / smptebars / rgbtestsrc)
  // concatenated, each with a different sine frequency. SceneDetect will
  // find clear boundaries at 10s and 20s, giving the agent something real
  // to reason about instead of one continuous pattern.
  await runFfmpeg(
    [
      "-f", "lavfi", "-i", "testsrc=duration=10:size=1920x1080:rate=30",
      "-f", "lavfi", "-i", "smptebars=duration=10:size=1920x1080:rate=30",
      "-f", "lavfi", "-i", "rgbtestsrc=duration=10:size=1920x1080:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
      "-f", "lavfi", "-i", "sine=frequency=660:duration=10",
      "-f", "lavfi", "-i", "sine=frequency=880:duration=10",
      "-filter_complex",
      "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];" +
        "[3:a][4:a][5:a]concat=n=3:v=0:a=1[a]",
      "-map", "[v]",
      "-map", "[a]",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      sourcePath,
    ],
    new AbortController().signal,
  );

  // Drop a tiny logo PNG at the path the brand guidelines reference, so
  // the agent doesn't have to work around a missing logo.
  const logoPath = storagePaths.brand(BRAND) + "/logo.png";
  if (!existsSync(logoPath)) {
    await runFfmpeg(
      [
        "-f", "lavfi", "-i", "color=c=red:s=128x128:d=1",
        "-frames:v", "1",
        logoPath,
      ],
      new AbortController().signal,
    );
  }

  console.log("Done. Now run: bun run dev -- --execute");
}

// Standalone analyse mode — point at any video file, get VideoAnalyse +
// SceneDetect output. No Anthropic API key required; just exercises the
// local ffmpeg-backed tools.
async function analyse(
  targetPath: string,
  useVision: boolean,
): Promise<void> {
  if (!existsSync(targetPath)) {
    console.error(`File not found: ${targetPath}`);
    process.exit(1);
  }

  const ui = createCliRenderer();
  ui.banner("Analyse", targetPath);

  // Resolve whether the VLM pass should actually run. The caller asked
  // for it (default: yes, unless --no-vision was passed), but it only
  // happens if a backend is configured. When neither is set, surface a
  // gentle tip and continue with the cheap signals only.
  const backend = useVision ? pickBackend() : null;
  if (useVision && backend === null) {
    ui.info(
      "Tip: per-scene VLM descriptions are off — set ANTHROPIC_API_KEY " +
        "(hosted Claude, fastest) or LLAMA_VLM_HF_REPO (local llama.cpp) " +
        "to enable. Use --no-vision to silence this message.",
    );
  }
  useVision = backend !== null;

  const ctx = {
    agentId: "ananalyse-0000000000000000",
    brandId: "n/a",
    campaignId: "n/a",
    abortSignal: new AbortController().signal,
  };

  ui.toolCall("VideoAnalyse", { source_path: targetPath });
  const meta = await VideoAnalyseTool.call(
    VideoAnalyseTool.validateInput({ source_path: targetPath }),
    ctx,
  );
  if (!meta.ok) {
    ui.toolError("VideoAnalyse", meta.error);
    process.exit(1);
  }
  ui.toolSuccess("VideoAnalyse");

  ui.toolCall("SceneDetect", { source_path: targetPath });
  const scenes = await SceneDetectTool.call(
    SceneDetectTool.validateInput({ source_path: targetPath }),
    ctx,
  );
  if (!scenes.ok) {
    ui.toolError("SceneDetect", scenes.error);
    process.exit(1);
  }
  ui.toolSuccess("SceneDetect");

  ui.toolCall("RichAnalysis", {
    source_path: targetPath,
    scenes: scenes.output.scenes.length,
  });
  const rich = await runRichAnalysis(
    targetPath,
    scenes.output.scenes,
    ctx.abortSignal,
  );
  ui.toolSuccess("RichAnalysis");

  // Tier-2 cheap signals — OCR per scene. Local, no API, ~50-100ms per
  // scene after the language data loads.
  ui.toolCall("OCR", { scenes: scenes.output.scenes.length });
  let ocrResults: readonly SceneOcrResult[] = [];
  try {
    ocrResults = await runScenesOcr(
      targetPath,
      scenes.output.scenes,
      ctx.abortSignal,
    );
    ui.toolSuccess("OCR");
  } catch (e) {
    ui.toolError("OCR", (e as Error).message);
  }

  // Auto-transcript via TranscriptExtract — local whisper.cpp. Runs
  // automatically when WHISPER_MODEL is set (same opt-in shape as the
  // VLM pass). When not configured, surfaces a tip.
  let transcriptByScene: ReadonlyMap<number, string> = new Map();
  if (process.env.WHISPER_MODEL !== undefined && process.env.WHISPER_MODEL !== "") {
    ui.toolCall("TranscriptExtract", { source_path: targetPath });
    const r = await TranscriptExtractTool.call(
      TranscriptExtractTool.validateInput({ source_path: targetPath }),
      ctx,
    );
    if (!r.ok) {
      ui.toolError("TranscriptExtract", r.error);
    } else {
      ui.toolSuccess("TranscriptExtract");
      transcriptByScene = binWordsByScene(
        r.output.words,
        scenes.output.scenes,
      );
    }
  } else {
    ui.info(
      "Tip: per-scene transcript is off — set WHISPER_MODEL=~/whisper-models/ggml-base.en.bin (after `brew install whisper-cpp`) to enable.",
    );
  }

  // Optional VLM pass — selective by default. Only describe scenes
  // where the cheap signals didn't already tell us enough:
  //   - first scene (the hook — semantic context always matters)
  //   - scenes with no OCR text AND no obvious visual identity
  //     (low motion, mid brightness — likely a generic shot we'd
  //     benefit from describing)
  //
  // For ~22-scene videos this typically describes 4-7 scenes, not 22 —
  // huge speedup vs the previous "describe everything" path.
  let visionDescriptions: ReadonlyArray<{
    scene_index: number;
    summary: string;
    subject: string;
    setting: string;
    has_people: boolean;
    has_visible_text: boolean;
    visible_text: string;
    mood: string;
    composition: string;
  }> = [];
  if (useVision) {
    ui.info(
      `VLM backend: ${backend === "claude" ? "Claude (hosted)" : "llama-server (local)"}`,
    );
    const sceneIndicesToDescribe = pickScenesToDescribe(
      scenes.output.scenes.length,
      ocrResults,
      rich.scene_stats,
    );
    if (sceneIndicesToDescribe.length === 0) {
      ui.info(
        "DescribeScenes skipped — Tier-1+2 signals already describe every scene",
      );
    } else {
      ui.toolCall("DescribeScenes", {
        selected: sceneIndicesToDescribe.length,
        of: scenes.output.scenes.length,
      });
      const selectedScenes = sceneIndicesToDescribe.map((i) => ({
        start_ms: scenes.output.scenes[i]!.start_ms,
        end_ms: scenes.output.scenes[i]!.end_ms,
      }));
      const r = await DescribeScenesTool.call(
        DescribeScenesTool.validateInput({
          source_path: targetPath,
          scenes: selectedScenes,
        }),
        ctx,
      );
      if (!r.ok) {
        ui.toolError("DescribeScenes", r.error);
      } else {
        ui.toolSuccess("DescribeScenes");
        // Map back to original scene indices.
        visionDescriptions = r.output.descriptions.map((d, k) => ({
          ...d,
          scene_index: sceneIndicesToDescribe[k]!,
        }));
      }
    }
  }

  // ── Top-level metadata ─────────────────────────────────────────────
  console.log("");
  console.log(
    `Duration:    ${(meta.output.duration_ms / 1000).toFixed(2)}s`,
  );
  console.log(
    `Resolution:  ${meta.output.resolution.width}x${meta.output.resolution.height}`,
  );
  console.log(`Frame rate:  ${meta.output.frame_rate} fps`);
  console.log(`Format:      ${meta.output.format}`);
  console.log(`Bitrate:     ${meta.output.bitrate_kbps} kbps`);
  console.log(`Has audio:   ${meta.output.has_audio}`);

  // ── Loudness ───────────────────────────────────────────────────────
  if (
    rich.loudness.integrated_lufs !== null ||
    rich.loudness.true_peak_db !== null
  ) {
    console.log("");
    console.log("Audio loudness (EBU R128):");
    if (rich.loudness.integrated_lufs !== null) {
      const lufs = rich.loudness.integrated_lufs;
      const ref = lufs > -16 ? " (above -16 LUFS — likely too loud for IG/TT)" : lufs < -24 ? " (below -24 LUFS — quiet)" : "";
      console.log(`  Integrated:    ${lufs.toFixed(1)} LUFS${ref}`);
    }
    if (rich.loudness.true_peak_db !== null) {
      console.log(`  True peak:     ${rich.loudness.true_peak_db.toFixed(1)} dBFS`);
    }
    if (rich.loudness.loudness_range !== null) {
      console.log(`  LRA:           ${rich.loudness.loudness_range.toFixed(1)} LU`);
    }
  }

  // ── Black frames + silence ─────────────────────────────────────────
  if (rich.black_segments.length > 0) {
    console.log("");
    console.log(`Black frames (${rich.black_segments.length}) — natural cut points:`);
    for (const b of rich.black_segments) {
      console.log(
        `  ${formatMs(b.start_ms)} → ${formatMs(b.end_ms)}  (${((b.end_ms - b.start_ms) / 1000).toFixed(2)}s)`,
      );
    }
  }
  if (rich.silent_segments.length > 0) {
    console.log("");
    console.log(
      `Silent regions (${rich.silent_segments.length}) — safe spots for overlay text:`,
    );
    for (const s of rich.silent_segments) {
      console.log(
        `  ${formatMs(s.start_ms)} → ${formatMs(s.end_ms)}  (${((s.end_ms - s.start_ms) / 1000).toFixed(2)}s)`,
      );
    }
  }

  // ── Per-scene summary ──────────────────────────────────────────────
  console.log("");
  console.log(`Scenes (${scenes.output.scenes.length}):`);
  const visionByIdx = new Map(
    visionDescriptions.map((d) => [d.scene_index, d]),
  );
  const ocrByIdx = new Map(ocrResults.map((o) => [o.scene_index, o]));

  for (const [i, s] of scenes.output.scenes.entries()) {
    const stats = rich.scene_stats[i];
    const dur = ((s.end_ms - s.start_ms) / 1000).toFixed(2);
    const brightness =
      stats !== undefined ? `${stats.mean_brightness}/255` : "—";
    const meanColourSwatch =
      stats !== undefined
        ? `${swatch(stats.mean_colour)}`
        : "  ";
    const motion = stats !== undefined ? `motion ${stats.motion_intensity.toFixed(1)}` : "";

    // Header line: timestamps + duration + brightness + mean swatch + motion.
    console.log(
      `  ${String(i).padStart(2)}.  ${formatMs(s.start_ms)} → ${formatMs(s.end_ms)}   ${dur.padStart(5)}s    ${brightness.padStart(7)}    ${meanColourSwatch}    \x1B[90m${motion}\x1B[0m`,
    );

    // Dominant palette swatches if available.
    if (stats !== undefined && stats.dominant_palette.length > 0) {
      const palette = stats.dominant_palette
        .map(
          (p) =>
            `${swatch(p)} ${(p.frequency * 100).toFixed(0)}%`,
        )
        .join("  ");
      console.log(`        \x1B[90mpalette:\x1B[0m  ${palette}`);
    }

    // Audio summary — mean LUFS + silence ratio. Skipped when no audio.
    if (stats !== undefined && stats.mean_lufs !== null) {
      const lufs = stats.mean_lufs;
      const silencePct = Math.round(stats.silence_ratio * 100);
      const audioParts: string[] = [`audio: ${lufs.toFixed(1)} LUFS`];
      if (silencePct > 0) audioParts.push(`${silencePct}% silent`);
      // Quick label: relative to global integrated loudness.
      const globalI = rich.loudness.integrated_lufs;
      if (globalI !== null) {
        if (lufs >= globalI + 3) audioParts.push("(climax)");
        else if (lufs <= globalI - 3) audioParts.push("(quiet)");
      }
      console.log(
        `        \x1B[90m${audioParts.join("  ·  ")}\x1B[0m`,
      );
    }

    // OCR text if Tesseract found something.
    const ocr = ocrByIdx.get(i);
    if (ocr !== undefined && ocr.text.length > 0) {
      console.log(
        `        \x1B[90mtext (${ocr.confidence}% conf):\x1B[0m  "${ocr.text}"`,
      );
    }

    // Transcript words for this scene — what's spoken/sung over it.
    const transcript = transcriptByScene.get(i);
    if (transcript !== undefined && transcript.length > 0) {
      const truncated =
        transcript.length > 140
          ? transcript.slice(0, 140) + "…"
          : transcript;
      console.log(`        \x1B[90mtranscript:\x1B[0m  "${truncated}"`);
    }

    // VLM description if we ran it for this scene.
    const v = visionByIdx.get(i);
    if (v !== undefined) {
      console.log(`        ${v.summary}`);
      const tags: string[] = [
        `subject: ${v.subject}`,
        `setting: ${v.setting}`,
        `mood: ${v.mood}`,
        `composition: ${v.composition}`,
      ];
      if (v.has_people) tags.push("people");
      if (v.has_visible_text && v.visible_text.length > 0) {
        tags.push(`vlm-text: "${v.visible_text}"`);
      }
      console.log(`        \x1B[90m${tags.join("  ·  ")}\x1B[0m`);
    }
  }
}

// Selective gating for the VLM pass. Returns scene indices that are
// worth describing semantically. Strategy: always describe the first
// and last scene (hook + closer), plus any scene that has high motion
// or no OCR text (where the cheap signals didn't capture meaning).
// Skips short transitions (<2s) and scenes with strong OCR + low motion
// (already well-characterised).
function pickScenesToDescribe(
  totalScenes: number,
  ocr: readonly SceneOcrResult[],
  stats: readonly { motion_intensity: number; start_ms: number; end_ms: number }[],
  cap: number = 7,
): readonly number[] {
  const picks = new Set<number>();
  if (totalScenes === 0) return [];
  picks.add(0);
  if (totalScenes > 1) picks.add(totalScenes - 1);

  const ocrByIdx = new Map(ocr.map((o) => [o.scene_index, o]));
  const candidates: { idx: number; score: number }[] = [];
  for (let i = 0; i < totalScenes; i++) {
    const s = stats[i];
    if (s === undefined) continue;
    const dur = s.end_ms - s.start_ms;
    if (dur < 2000) continue; // transition cuts: skip
    const o = ocrByIdx.get(i);
    const hasText = o !== undefined && o.text.length > 0;
    let score = 0;
    if (s.motion_intensity > 5) score += 2; // dynamic = worth describing
    if (!hasText) score += 1; // no OCR signal — VLM fills the gap
    if (dur > 5000) score += 1; // long scene = high information content
    candidates.push({ idx: i, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    if (picks.size >= cap) break;
    picks.add(c.idx);
  }
  return [...picks].sort((a, b) => a - b);
}

function formatMs(ms: number): string {
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

// 24-bit truecolour ANSI block — terminal renders the actual scene colour
// next to the rgb() values, so you can see at a glance which scenes are
// dark/light/branded.
function swatch(rgb: { r: number; g: number; b: number }): string {
  return `\x1B[48;2;${rgb.r};${rgb.g};${rgb.b}m   \x1B[0m`;
}

// Bin transcript words by scene timestamp. Each word's midpoint decides
// which scene it belongs to. Output: scene_index → joined text.
//
// Drops scenes whose joined text trips the hallucination heuristic.
// Whisper's classic failure mode on non-target-language audio (English-
// only model on Hindi audio, music-only segments, etc.) is to chant the
// same word repeatedly. We detect that and suppress.
function binWordsByScene(
  words: readonly { text: string; start_ms: number; end_ms: number }[],
  scenes: readonly { start_ms: number; end_ms: number }[],
): ReadonlyMap<number, string> {
  const out = new Map<number, string[]>();
  for (const w of words) {
    const mid = (w.start_ms + w.end_ms) / 2;
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i]!;
      if (mid >= s.start_ms && mid < s.end_ms) {
        if (!out.has(i)) out.set(i, []);
        out.get(i)!.push(w.text);
        break;
      }
    }
  }
  const joined = new Map<number, string>();
  for (const [k, v] of out) {
    const text = v.join(" ").replace(/\s+/g, " ").trim();
    if (text.length === 0) continue;
    if (isLikelyHallucination(text)) continue;
    joined.set(k, text);
  }
  return joined;
}

// Detects Whisper's "stuck on one token" hallucination patterns. Two
// signals:
//   1. A single word accounts for >40% of all words AND repeats ≥4 times.
//   2. Same word appears 4+ times consecutively (verbatim repetition run).
// Either signal → drop the transcript for the scene rather than show
// nonsense like "English English English English…"
function isLikelyHallucination(text: string): boolean {
  const tokens = text
    .toLowerCase()
    .replace(/[.,!?;:'"()]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (tokens.length < 4) return false;

  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  let max = 0;
  for (const c of freq.values()) if (c > max) max = c;
  if (max / tokens.length > 0.4 && max >= 4) return true;

  // Adjacent-repetition run.
  let consec = 1;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === tokens[i - 1]) {
      consec++;
      if (consec >= 4) return true;
    } else {
      consec = 1;
    }
  }
  return false;
}

// --source <path> — copy a user-supplied video to the demo asset path
// and refresh metadata.json from VideoAnalyse so the agent's context
// reflects the real file.
async function ingestSource(targetPath: string): Promise<void> {
  if (!existsSync(targetPath)) {
    console.error(`--source path not found: ${targetPath}`);
    process.exit(1);
  }

  const { copyFile, mkdir, writeFile } = await import("node:fs/promises");
  const dest = storagePaths.assetSource(BRAND, CAMPAIGN, ASSET);
  await mkdir(storagePaths.asset(BRAND, CAMPAIGN, ASSET), {
    recursive: true,
  });
  await copyFile(targetPath, dest);

  // Re-probe and write metadata.json so loadAssetMetadata sees the real
  // duration/resolution. The byte-determinism guarantee on the context
  // builder still holds — same input file → same metadata → same prompt.
  const r = await VideoAnalyseTool.call(
    VideoAnalyseTool.validateInput({ source_path: dest }),
    {
      agentId: "aingest-0000000000000000",
      brandId: BRAND,
      campaignId: CAMPAIGN,
      assetId: ASSET,
      abortSignal: new AbortController().signal,
    },
  );
  if (!r.ok) {
    console.error(`VideoAnalyse failed on ingested source: ${r.error}`);
    process.exit(1);
  }
  await writeFile(
    storagePaths.assetMetadata(BRAND, CAMPAIGN, ASSET),
    JSON.stringify(
      {
        id: ASSET,
        path: dest,
        duration_ms: r.output.duration_ms,
        resolution: r.output.resolution,
        frame_rate: r.output.frame_rate,
        has_audio: r.output.has_audio,
      },
      null,
      2,
    ),
  );
  console.log(
    `Ingested ${targetPath} → ${dest} (${(r.output.duration_ms / 1000).toFixed(1)}s, ${r.output.resolution.width}x${r.output.resolution.height})`,
  );
}

// --chat — open a chat-mode REPL backed by the EditingAgent loop. Reuses
// the same tools, hooks, compaction, and plan-mode gate as --execute,
// but the conversation persists across user messages and renders flush
// to disk per message.
async function chat(args: readonly string[]): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY not set. Chat mode needs the Anthropic SDK.",
    );
    process.exit(1);
  }

  // Optional --source <path> swaps in user footage at the demo asset
  // path before the session starts (same shape as --execute).
  const sourceIdx = args.indexOf("--source");
  if (sourceIdx >= 0) {
    const target = args[sourceIdx + 1];
    if (target === undefined) {
      console.error("--source requires a path argument");
      process.exit(1);
    }
    await ingestSource(target);
  }

  const sourcePath = storagePaths.assetSource(BRAND, CAMPAIGN, ASSET);
  if (!existsSync(sourcePath)) {
    console.error(
      `Source video missing: ${sourcePath}\n` +
        "Either:\n" +
        "  • bun run dev -- --prep                       (synthetic source)\n" +
        "  • bun run dev -- --chat --source <path>       (your own video)",
    );
    process.exit(1);
  }

  const ui = createCliRenderer({ quietPreview: true });
  // Bridge holds the REPL's readline so the approver can reuse it for
  // its y/N question. Without this, two competing readline interfaces
  // race for stdin and the approver's question resolves instantly.
  const approverBridge = createApproverBridge();
  const approver = createChatPlanApprover({ ui, bridge: approverBridge });
  const conversation = await Conversation.create({
    brandId: BRAND,
    campaignId: CAMPAIGN,
    assetId: ASSET,
    approvePlans: approver,
    ui,
  });

  await runRepl({
    conversation,
    ui,
    brandId: BRAND,
    campaignId: CAMPAIGN,
    assetId: ASSET,
    backendLabel: process.env.MODEL ?? "claude-opus-4-7",
    approverBridge,
  });
}

async function dryRun(): Promise<void> {
  console.log("=== Dry run ===\n");

  console.log("Compaction strategy:", editingAgentCompactStrategy);

  const blocks = await buildEditingAgentContext(BRAND, CAMPAIGN, ASSET);
  console.log(`\nContext: ${blocks.length} blocks`);
  for (const b of blocks) {
    const bytes = Buffer.byteLength(b.content, "utf-8");
    console.log(`  [${b.kind}] ${b.source} — ${bytes} bytes`);
  }

  const turn1 = loadedToolsForTurn1(editingAgentTools);
  const deferred = deferredTools(editingAgentTools);
  console.log(
    `\nTools: ${editingAgentTools.length} total — turn-1 loaded: ${turn1.length}, deferred: ${deferred.length}`,
  );
  for (const t of editingAgentTools) {
    const flags = t.shouldDefer
      ? "deferred"
      : t.alwaysLoad
        ? "always-load"
        : "default";
    console.log(`  ${t.name.padEnd(20)} ${flags.padEnd(12)} ${t.description.slice(0, 60)}…`);
  }

  console.log(
    "\nNo API call made. Set ANTHROPIC_API_KEY and pass --execute to run a real EditingAgent loop.",
  );
}

await main();
