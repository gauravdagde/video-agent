import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { applyAutoFixes } from "../compliance/applyAutoFixes.ts";
import { runFfmpeg, runFfprobe } from "../tools/ffmpeg.ts";
import type { ComplianceFix } from "../compliance/ComplianceResult.ts";

const TMP = path.join(
  process.env.TMPDIR ?? "/tmp",
  `video-agent-autofix-${Date.now()}`,
);
const SOURCE_TEMPLATE = path.join(TMP, "source-template.mp4");
const LOGO_PATH = path.join(TMP, "logo.png");

const ffmpegAvailable =
  Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

const signal = new AbortController().signal;

// Each test gets its own working file copied from the template so fixes
// don't leak across tests (applyAutoFixes mutates in place via rename).
async function freshAsset(name: string): Promise<string> {
  const p = path.join(TMP, `${name}.mp4`);
  await copyFile(SOURCE_TEMPLATE, p);
  return p;
}

async function probeStream(p: string, kind: "video" | "audio"): Promise<string> {
  const { stdout } = await runFfprobe(
    [
      "-v",
      "error",
      "-select_streams",
      kind === "video" ? "v:0" : "a:0",
      "-show_entries",
      "stream=codec_name",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      p,
    ],
    signal,
  );
  return stdout.trim();
}

describe.skipIf(!ffmpegAvailable)("integration: applyAutoFixes", () => {
  beforeAll(async () => {
    await mkdir(TMP, { recursive: true });
    // 6-second testsrc + sine — small but real.
    await runFfmpeg(
      [
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=6:size=640x360:rate=30",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=6",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        SOURCE_TEMPLATE,
      ],
      signal,
    );
    // Tiny solid-colour PNG as a stand-in for a brand logo.
    await runFfmpeg(
      [
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=80x80:d=1",
        "-frames:v",
        "1",
        LOGO_PATH,
      ],
      signal,
    );
  });

  afterAll(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("noop when fixes is empty", async () => {
    const asset = await freshAsset("noop");
    const r = await applyAutoFixes(asset, [], signal);
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.needsRerender).toEqual([]);
    expect(r.output_path).toBe(asset);
  });

  test("applies a colour fix and replaces in place", async () => {
    const asset = await freshAsset("colour");
    const before = (await stat(asset)).size;
    const fix: ComplianceFix = {
      kind: "colour",
      description: "boost saturation",
      delta: { saturation: 1.4 },
    };
    const r = await applyAutoFixes(asset, [fix], signal);
    expect(r.applied).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
    expect(r.output_path).toBe(asset);
    const after = (await stat(asset)).size;
    // The file changed — different size after re-encoding.
    expect(after).not.toBe(before);
  });

  test("applies an audio_level fix and preserves video stream", async () => {
    const asset = await freshAsset("audio");
    const fix: ComplianceFix = {
      kind: "audio_level",
      description: "normalise to -23 LUFS",
      delta: { target_lufs: -23 },
    };
    const r = await applyAutoFixes(asset, [fix], signal);
    expect(r.applied).toHaveLength(1);
    // Video codec passed through (-c:v copy).
    const codec = await probeStream(asset, "video");
    expect(codec).toBe("h264");
  });

  test("logo_position default surfaces needs_rerender (T3.5)", async () => {
    const asset = await freshAsset("logo-default");
    const fix: ComplianceFix = {
      kind: "logo_position",
      description: "logo should move to 24,24",
      delta: {
        logo_path: LOGO_PATH,
        position: { x: 24, y: 24 },
        start_ms: 0,
        end_ms: 6_000,
      },
    };
    const r = await applyAutoFixes(asset, [fix], signal);
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.needsRerender).toHaveLength(1);
    expect(r.needsRerender[0]!.suggestedDelta).toMatchObject({
      logo_position: { logo_path: LOGO_PATH, position: { x: 24, y: 24 } },
    });
  });

  test("logo_position with VIDEO_AGENT_LOGO_OVERLAY_ON_TOP=1 falls back to overlay (T3.5)", async () => {
    process.env.VIDEO_AGENT_LOGO_OVERLAY_ON_TOP = "1";
    try {
      const asset = await freshAsset("logo-fallback");
      const fix: ComplianceFix = {
        kind: "logo_position",
        description: "place corrective logo at 24,24",
        delta: {
          logo_path: LOGO_PATH,
          position: { x: 24, y: 24 },
          start_ms: 0,
          end_ms: 6_000,
        },
      };
      const r = await applyAutoFixes(asset, [fix], signal);
      expect(r.applied).toHaveLength(1);
      expect(r.skipped).toHaveLength(0);
      expect(r.needsRerender).toHaveLength(0);
    } finally {
      delete process.env.VIDEO_AGENT_LOGO_OVERLAY_ON_TOP;
    }
  });

  test("typography is reported as skipped, not applied", async () => {
    const asset = await freshAsset("typo");
    const fix: ComplianceFix = {
      kind: "typography",
      description: "swap font",
      delta: { font: "Inter" },
    };
    const r = await applyAutoFixes(asset, [fix], signal);
    expect(r.applied).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.reason).toContain("typography");
  });

  test("invalid delta is skipped with parse error reason", async () => {
    const asset = await freshAsset("bad-delta");
    const fix: ComplianceFix = {
      kind: "colour",
      description: "bad",
      delta: { brightness: 99 }, // out of -1..1 range
    };
    const r = await applyAutoFixes(asset, [fix], signal);
    expect(r.applied).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.reason).toContain("colour delta invalid");
  });

  test("overlay-on-top mode: missing logo asset is skipped with a clear reason", async () => {
    process.env.VIDEO_AGENT_LOGO_OVERLAY_ON_TOP = "1";
    try {
      const asset = await freshAsset("missing-logo");
      const fix: ComplianceFix = {
        kind: "logo_position",
        description: "logo at /nope",
        delta: {
          logo_path: "/nonexistent/logo.png",
          position: { x: 10, y: 10 },
        },
      };
      const r = await applyAutoFixes(asset, [fix], signal);
      expect(r.applied).toEqual([]);
      expect(r.skipped).toHaveLength(1);
      expect(r.skipped[0]!.reason).toContain("logo asset not found");
    } finally {
      delete process.env.VIDEO_AGENT_LOGO_OVERLAY_ON_TOP;
    }
  });

  test("multi-fix run applies in sequence and replaces in place", async () => {
    const asset = await freshAsset("multi");
    const fixes: ComplianceFix[] = [
      {
        kind: "colour",
        description: "saturation up",
        delta: { saturation: 1.2 },
      },
      {
        kind: "audio_level",
        description: "normalise",
        delta: { target_lufs: -16 },
      },
    ];
    const r = await applyAutoFixes(asset, fixes, signal);
    expect(r.applied).toHaveLength(2);
    expect(r.skipped).toHaveLength(0);
    // Final file is at the original path.
    expect(r.output_path).toBe(asset);
    // Sidecar intermediates have been cleaned up.
    const dir = path.dirname(asset);
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);
    const intermediates = files.filter((f) => f.includes(".fix"));
    expect(intermediates).toEqual([]);
  });

  test("partial: when one fix fails, skipped contains it and applied contains the rest", async () => {
    const asset = await freshAsset("partial");
    const fixes: ComplianceFix[] = [
      {
        kind: "colour",
        description: "ok",
        delta: { saturation: 1.1 },
      },
      {
        kind: "typography",
        description: "swap",
        delta: { font: "Inter" },
      },
    ];
    const r = await applyAutoFixes(asset, fixes, signal);
    expect(r.applied).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
    // The colour fix did still get applied to the file in place.
    expect(r.output_path).toBe(asset);
  });
});
