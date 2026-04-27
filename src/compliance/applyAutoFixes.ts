import { rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ensureDir, runFfmpeg } from "../tools/ffmpeg.ts";
import type { ComplianceFix } from "./ComplianceResult.ts";

// Auto-fix routine for compliance failures the system can resolve without
// human review. Applied sequentially; each fix produces an intermediate
// file, the next reads from it. On success the original file is replaced
// atomically (rename over).
//
// What's supported, and the caveat for each:
//   colour        — ffmpeg `eq` filter. Fully transparent fix.
//   audio_level   — ffmpeg `loudnorm`. Fully transparent fix.
//   logo_position — overlay-on-top patch. CAVEAT: the wrong logo from the
//                   original render is still baked in; the correction is a
//                   new logo composited over it. Works only when the patch
//                   covers the wrong logo entirely. Real production should
//                   re-render with corrected EditPlan instead — that path
//                   needs access to source clips and lives in the agent
//                   layer, not here.
//   typography    — NOT supported. Returned as skipped; caller escalates.

const ColourDelta = z.object({
  brightness: z.number().min(-1).max(1).optional(),
  contrast: z.number().min(0).max(2).optional(),
  saturation: z.number().min(0).max(3).optional(),
  gamma: z.number().min(0.1).max(10).optional(),
});

const AudioLevelDelta = z.object({
  target_lufs: z.number().min(-30).max(-5),
  // Loudness range and true-peak limit — sane defaults if absent.
  lra: z.number().min(1).max(20).default(7),
  true_peak: z.number().min(-9).max(0).default(-2),
});

const LogoPositionDelta = z.object({
  logo_path: z.string(),
  // Pixel position from top-left.
  position: z.object({ x: z.number(), y: z.number() }),
  start_ms: z.number().int().nonnegative().default(0),
  end_ms: z.number().int().positive().optional(),
  scale: z.number().positive().optional(),
});

export interface NeedsRerender {
  readonly fix: ComplianceFix;
  readonly reason: string;
  readonly suggestedDelta: Record<string, unknown>;
}

export interface ApplyResult {
  readonly output_path: string;
  readonly applied: readonly ComplianceFix[];
  readonly skipped: readonly { fix: ComplianceFix; reason: string }[];
  // T3.5 — fixes that cannot be applied transparently; need RenderVariant
  // to be re-issued with the suggestedDelta merged into the EditPlan.
  readonly needsRerender: readonly NeedsRerender[];
}

export async function applyAutoFixes(
  assetPath: string,
  fixes: readonly ComplianceFix[],
  signal: AbortSignal,
): Promise<ApplyResult> {
  if (fixes.length === 0) {
    return { output_path: assetPath, applied: [], skipped: [], needsRerender: [] };
  }

  const dir = path.dirname(assetPath);
  const basename = path.basename(assetPath, path.extname(assetPath));
  const ext = path.extname(assetPath);
  await ensureDir(dir);

  let currentPath = assetPath;
  const intermediates: string[] = [];
  const applied: ComplianceFix[] = [];
  const skipped: { fix: ComplianceFix; reason: string }[] = [];
  const needsRerender: NeedsRerender[] = [];

  try {
    for (let i = 0; i < fixes.length; i++) {
      const fix = fixes[i]!;
      const tmpOut = path.join(dir, `${basename}.fix${i}${ext}`);
      const outcome = await applyOne(currentPath, tmpOut, fix, signal);
      switch (outcome.kind) {
        case "applied":
          intermediates.push(tmpOut);
          currentPath = tmpOut;
          applied.push(fix);
          break;
        case "skipped":
          skipped.push({ fix, reason: outcome.reason });
          break;
        case "needs_rerender":
          needsRerender.push({
            fix,
            reason: outcome.reason,
            suggestedDelta: outcome.suggestedDelta,
          });
          break;
      }
    }

    // If we produced any intermediates, atomically replace the original.
    if (currentPath !== assetPath) {
      await rename(currentPath, assetPath);
      // Drop the just-renamed file from the cleanup list — it's now the
      // production artefact.
      intermediates.pop();
      currentPath = assetPath;
    }
  } finally {
    // Clean up earlier intermediates (everything between original and final).
    for (const p of intermediates) {
      await unlink(p).catch(() => {});
    }
  }

  return { output_path: currentPath, applied, skipped, needsRerender };
}

type OneResult =
  | { readonly kind: "applied" }
  | { readonly kind: "skipped"; readonly reason: string }
  | {
      readonly kind: "needs_rerender";
      readonly reason: string;
      readonly suggestedDelta: Record<string, unknown>;
    };

// T3.5 — feature flag to fall back to overlay-on-top for logo_position
// when the host is OK with the caveat (wrong logo bleeding through).
// Default off — re-render is the right answer.
//
// Read lazily so tests can flip it inside `beforeAll` rather than at
// module-load time.
function allowLogoOverlayOnTop(): boolean {
  return process.env.VIDEO_AGENT_LOGO_OVERLAY_ON_TOP === "1";
}

async function applyOne(
  input: string,
  output: string,
  fix: ComplianceFix,
  signal: AbortSignal,
): Promise<OneResult> {
  switch (fix.kind) {
    case "colour":
      return applyColour(input, output, fix.delta, signal);
    case "audio_level":
      return applyAudioLevel(input, output, fix.delta, signal);
    case "logo_position":
      // T3.5 — default surface needs_rerender (the right fix is a fresh
      // render with corrected EditPlan). Overlay-on-top fallback only
      // when explicitly opted in.
      if (!allowLogoOverlayOnTop()) {
        return {
          kind: "needs_rerender",
          reason:
            "logo_position requires re-render with corrected EditPlan; overlay-on-top would leave the original wrong logo visible",
          suggestedDelta: { logo_position: fix.delta },
        };
      }
      return applyLogoPosition(input, output, fix.delta, signal);
    case "typography":
      return {
        kind: "skipped",
        reason:
          "typography auto-fix is not supported — escalate for design review",
      };
  }
}

async function applyColour(
  input: string,
  output: string,
  rawDelta: Record<string, unknown>,
  signal: AbortSignal,
): Promise<OneResult> {
  const parsed = ColourDelta.safeParse(rawDelta);
  if (!parsed.success) {
    return { kind: "skipped", reason: `colour delta invalid: ${parsed.error.message}` };
  }
  const parts: string[] = [];
  if (parsed.data.brightness !== undefined) parts.push(`brightness=${parsed.data.brightness}`);
  if (parsed.data.contrast !== undefined) parts.push(`contrast=${parsed.data.contrast}`);
  if (parsed.data.saturation !== undefined) parts.push(`saturation=${parsed.data.saturation}`);
  if (parsed.data.gamma !== undefined) parts.push(`gamma=${parsed.data.gamma}`);
  if (parts.length === 0) {
    return { kind: "skipped", reason: "colour delta empty — nothing to apply" };
  }
  try {
    await runFfmpeg(
      [
        "-i",
        input,
        "-vf",
        `eq=${parts.join(":")}`,
        "-c:a",
        "copy",
        output,
      ],
      signal,
    );
    return { kind: "applied" };
  } catch (e) {
    return { kind: "skipped", reason: (e as Error).message };
  }
}

async function applyAudioLevel(
  input: string,
  output: string,
  rawDelta: Record<string, unknown>,
  signal: AbortSignal,
): Promise<OneResult> {
  const parsed = AudioLevelDelta.safeParse(rawDelta);
  if (!parsed.success) {
    return { kind: "skipped", reason: `audio_level delta invalid: ${parsed.error.message}` };
  }
  try {
    await runFfmpeg(
      [
        "-i",
        input,
        "-af",
        `loudnorm=I=${parsed.data.target_lufs}:LRA=${parsed.data.lra}:TP=${parsed.data.true_peak}`,
        "-c:v",
        "copy",
        output,
      ],
      signal,
    );
    return { kind: "applied" };
  } catch (e) {
    return { kind: "skipped", reason: (e as Error).message };
  }
}

async function applyLogoPosition(
  input: string,
  output: string,
  rawDelta: Record<string, unknown>,
  signal: AbortSignal,
): Promise<OneResult> {
  const parsed = LogoPositionDelta.safeParse(rawDelta);
  if (!parsed.success) {
    return { kind: "skipped", reason: `logo_position delta invalid: ${parsed.error.message}` };
  }
  // Verify the logo asset exists before kicking off ffmpeg — clearer error.
  try {
    await stat(parsed.data.logo_path);
  } catch {
    return {
      kind: "skipped",
      reason: `logo asset not found at ${parsed.data.logo_path}`,
    };
  }

  const startSec = (parsed.data.start_ms / 1000).toFixed(3);
  const enable =
    parsed.data.end_ms !== undefined
      ? `enable='between(t,${startSec},${(parsed.data.end_ms / 1000).toFixed(3)})'`
      : `enable='gte(t,${startSec})'`;

  const overlay =
    parsed.data.scale !== undefined && parsed.data.scale !== 1
      ? `[1:v]scale=iw*${parsed.data.scale}:ih*${parsed.data.scale}[ovr];[0:v][ovr]overlay=${parsed.data.position.x}:${parsed.data.position.y}:${enable}`
      : `[0:v][1:v]overlay=${parsed.data.position.x}:${parsed.data.position.y}:${enable}`;

  try {
    await runFfmpeg(
      [
        "-i",
        input,
        "-i",
        parsed.data.logo_path,
        "-filter_complex",
        overlay,
        "-c:a",
        "copy",
        output,
      ],
      signal,
    );
    return { kind: "applied" };
  } catch (e) {
    return { kind: "skipped", reason: (e as Error).message };
  }
}
