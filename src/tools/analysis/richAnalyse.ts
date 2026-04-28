// Rich-analysis helpers — additional signal beyond what the model-facing
// tools (VideoAnalyse, SceneDetect) return. Used by the standalone
// `--analyse` CLI mode to surface human-readable insight before paying
// for an agent run.
//
// Everything here uses native ffmpeg filters — no ML models, no extra
// deps. Single passes where possible.

// We use Bun.spawn directly here (rather than `runFfmpeg`) because the
// signals we want — ebur128 summary, blackdetect events, silencedetect
// events, signalstats metadata — are all emitted at ffmpeg's `info`
// loglevel. `runFfmpeg` hardcodes `-loglevel error` and would suppress
// every line we need to parse.
const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";

async function runFfmpegInfo(
  args: readonly string[],
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn([FFMPEG, "-y", "-loglevel", "info", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

export interface LoudnessStats {
  readonly integrated_lufs: number | null;
  readonly true_peak_db: number | null;
  readonly loudness_range: number | null;
}

export interface TimeRange {
  readonly start_ms: number;
  readonly end_ms: number;
}

export interface PaletteEntry {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly frequency: number; // 0-1 share of pixels in this bucket
}

export interface SceneStats {
  readonly start_ms: number;
  readonly end_ms: number;
  // 0-255; brightness average of the Y (luma) channel across all frames
  // in this scene.
  readonly mean_brightness: number;
  // RGB means averaged across the scene.
  readonly mean_colour: { readonly r: number; readonly g: number; readonly b: number };
  // Dominant 3-5 colours in the midpoint frame, sorted by frequency.
  // Cheap brand-match signal — distance from these to the brand palette
  // tells you whether the scene is on-brand without an LLM.
  readonly dominant_palette: readonly PaletteEntry[];
  // Frame-to-frame Y (luma) deviation. Higher = more motion or rapid
  // scene change; near zero = static shot.
  readonly motion_intensity: number;
  // Mean momentary LUFS across this scene's time range. null when the
  // source has no audio. Compare against the global integrated_lufs to
  // identify the climax (loudest scene) or the breath (quietest).
  readonly mean_lufs: number | null;
  // 0-1; share of this scene that overlaps with detected silent_segments.
  // High = music-led or ambient (no voice); low = continuous voice/music.
  readonly silence_ratio: number;
}

export interface RichAnalysis {
  readonly loudness: LoudnessStats;
  readonly black_segments: readonly TimeRange[];
  readonly silent_segments: readonly TimeRange[];
  readonly scene_stats: readonly SceneStats[];
}

export async function runRichAnalysis(
  sourcePath: string,
  scenes: readonly TimeRange[],
  signal: AbortSignal,
): Promise<RichAnalysis> {
  const [audioVideoPass, framewiseStats, scenePalettes] = await Promise.all([
    runAudioVideoDetectors(sourcePath, signal),
    runFramewiseSignalStats(sourcePath, signal),
    runScenePalettes(sourcePath, scenes, signal),
  ]);
  const sceneStats = aggregateSceneStats(
    framewiseStats,
    scenes,
    scenePalettes,
    audioVideoPass.momentary,
    audioVideoPass.silent,
  );
  return {
    loudness: audioVideoPass.loudness,
    black_segments: audioVideoPass.black,
    silent_segments: audioVideoPass.silent,
    scene_stats: sceneStats,
  };
}

interface MomentaryLoudness {
  readonly time_ms: number;
  readonly lufs: number;
}

interface AudioVideoPassResult {
  readonly loudness: LoudnessStats;
  readonly black: readonly TimeRange[];
  readonly silent: readonly TimeRange[];
  // Per-second `M:` values from ebur128 — used to compute per-scene
  // mean LUFS. Already in the stderr we're parsing, just need to capture.
  readonly momentary: readonly MomentaryLoudness[];
}

// One ffmpeg invocation: blackdetect on video, ebur128 + silencedetect
// on audio. All emit to stderr at info-level; we parse the lines.
async function runAudioVideoDetectors(
  sourcePath: string,
  signal: AbortSignal,
): Promise<AudioVideoPassResult> {
  const r = await runFfmpegInfo(
    [
      "-i",
      sourcePath,
      "-vf",
      "blackdetect=d=0.4:pix_th=0.10",
      "-af",
      "ebur128=peak=true,silencedetect=n=-30dB:d=0.5",
      "-f",
      "null",
      "-",
    ],
    signal,
  );
  const stderr = r.stderr;

  const black: TimeRange[] = [];
  const silent: TimeRange[] = [];
  const momentary: MomentaryLoudness[] = [];
  let integrated: number | null = null;
  let truePeak: number | null = null;
  let lra: number | null = null;
  let pendingSilenceStart: number | null = null;

  for (const line of stderr.split("\n")) {
    // ebur128 running values: "[Parsed_ebur128_0 @ 0x…] t: 28.6  TARGET:-23 LUFS    M: -21.3 …"
    // M = momentary loudness (400ms window). We parse t + M and keep
    // them for per-scene aggregation later.
    const runningMatch = line.match(/t:\s*([\d.]+).+?M:\s*(-?[\d.]+)/);
    if (runningMatch) {
      momentary.push({
        time_ms: Math.round(parseFloat(runningMatch[1]!) * 1000),
        lufs: parseFloat(runningMatch[2]!),
      });
    }
    // blackdetect: "[blackdetect @ 0x...] black_start:0 black_end:1.5 black_duration:1.5"
    const blackMatch = line.match(
      /black_start:([\d.]+)\s+black_end:([\d.]+)/,
    );
    if (blackMatch) {
      black.push({
        start_ms: Math.round(parseFloat(blackMatch[1]!) * 1000),
        end_ms: Math.round(parseFloat(blackMatch[2]!) * 1000),
      });
    }

    // silencedetect emits two lines: "silence_start: T" then "silence_end: T | silence_duration: D"
    const silStart = line.match(/silence_start:\s*([\d.]+)/);
    if (silStart) pendingSilenceStart = Math.round(parseFloat(silStart[1]!) * 1000);
    const silEnd = line.match(/silence_end:\s*([\d.]+)/);
    if (silEnd && pendingSilenceStart !== null) {
      silent.push({
        start_ms: pendingSilenceStart,
        end_ms: Math.round(parseFloat(silEnd[1]!) * 1000),
      });
      pendingSilenceStart = null;
    }

    // ebur128 summary at end-of-stream:
    //   "    I:         -23.0 LUFS"
    //   "    LRA:         5.0 LU"
    //   "    Peak:       -1.5 dBFS"
    const integMatch = line.match(/I:\s+(-?[\d.]+)\s+LUFS/);
    if (integMatch) integrated = parseFloat(integMatch[1]!);
    const peakMatch = line.match(/Peak:\s+(-?[\d.]+)\s+dBFS/);
    if (peakMatch) truePeak = parseFloat(peakMatch[1]!);
    const lraMatch = line.match(/LRA:\s+(-?[\d.]+)\s+LU/);
    if (lraMatch) lra = parseFloat(lraMatch[1]!);
  }

  return {
    loudness: {
      integrated_lufs: integrated,
      true_peak_db: truePeak,
      loudness_range: lra,
    },
    black,
    silent,
    momentary,
  };
}

interface FrameStat {
  readonly time_ms: number;
  readonly y_avg: number;
  readonly u_avg: number;
  readonly v_avg: number;
}

// Per-frame signalstats. ffmpeg's `metadata=print` writes one block per
// frame; we parse the YAVG / RGBAVG lines and the frame timestamp.
async function runFramewiseSignalStats(
  sourcePath: string,
  signal: AbortSignal,
): Promise<readonly FrameStat[]> {
  const r = await runFfmpegInfo(
    [
      "-i",
      sourcePath,
      "-vf",
      "signalstats,metadata=print",
      "-an",
      "-f",
      "null",
      "-",
    ],
    signal,
  );
  const stderr = r.stderr;

  const frames: FrameStat[] = [];
  let curTimeMs = 0;
  let curY: number | null = null;
  let curU: number | null = null;
  let curV: number | null = null;

  const flush = (): void => {
    if (curY !== null) {
      frames.push({
        time_ms: curTimeMs,
        y_avg: curY,
        u_avg: curU ?? 128,
        v_avg: curV ?? 128,
      });
    }
    curY = curU = curV = null;
  };

  for (const line of stderr.split("\n")) {
    const headerMatch = line.match(/pts_time:\s*([\d.]+)/);
    if (headerMatch) {
      flush();
      curTimeMs = Math.round(parseFloat(headerMatch[1]!) * 1000);
      continue;
    }
    const yMatch = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
    if (yMatch) curY = parseFloat(yMatch[1]!);
    const uMatch = line.match(/lavfi\.signalstats\.UAVG=([\d.]+)/);
    if (uMatch) curU = parseFloat(uMatch[1]!);
    const vMatch = line.match(/lavfi\.signalstats\.VAVG=([\d.]+)/);
    if (vMatch) curV = parseFloat(vMatch[1]!);
  }
  flush();
  return frames;
}

// BT.709 YUV → RGB. YUV is the native colour space for nearly every mp4
// you'll ever see; signalstats reports Y/U/V means, and we convert at
// aggregation time so the final report uses RGB the human can read.
function yuvToRgb(
  y: number,
  u: number,
  v: number,
): { r: number; g: number; b: number } {
  const cb = u - 128;
  const cr = v - 128;
  const r = clamp8(y + 1.5748 * cr);
  const g = clamp8(y - 0.1873 * cb - 0.4681 * cr);
  const b = clamp8(y + 1.8556 * cb);
  return { r, g, b };
}

function clamp8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function aggregateSceneStats(
  frames: readonly FrameStat[],
  scenes: readonly TimeRange[],
  scenePalettes: readonly (readonly PaletteEntry[])[],
  momentary: readonly MomentaryLoudness[],
  silentSegments: readonly TimeRange[],
): readonly SceneStats[] {
  return scenes.map((scene, idx) => {
    // Collect per-frame stats inside the scene's time range.
    const ys: number[] = [];
    let u = 0,
      v = 0;
    for (const f of frames) {
      if (f.time_ms >= scene.start_ms && f.time_ms < scene.end_ms) {
        ys.push(f.y_avg);
        u += f.u_avg;
        v += f.v_avg;
      }
    }
    const n = ys.length;
    const palette = scenePalettes[idx] ?? [];

    // Audio aggregation — runs regardless of video frame count.
    const meanLufs = computeMeanLufs(momentary, scene);
    const silenceRatio = computeSilenceRatio(scene, silentSegments);

    if (n === 0) {
      return {
        start_ms: scene.start_ms,
        end_ms: scene.end_ms,
        mean_brightness: 0,
        mean_colour: { r: 0, g: 0, b: 0 },
        dominant_palette: palette,
        motion_intensity: 0,
        mean_lufs: meanLufs,
        silence_ratio: silenceRatio,
      };
    }
    const yAvg = ys.reduce((a, b) => a + b, 0) / n;
    const colour = yuvToRgb(yAvg, u / n, v / n);

    // Motion intensity = average absolute frame-to-frame Y delta across
    // the scene. Static shots → near zero. Action / camera motion → 5+.
    // Hard cuts inside the scene → 30+. Cheap proxy that needs no extra
    // ffmpeg pass (we already have YAVG per frame from signalstats).
    let motion = 0;
    if (n > 1) {
      let total = 0;
      for (let i = 1; i < n; i++) {
        total += Math.abs(ys[i]! - ys[i - 1]!);
      }
      motion = total / (n - 1);
    }

    return {
      start_ms: scene.start_ms,
      end_ms: scene.end_ms,
      mean_brightness: Math.round(yAvg),
      mean_colour: colour,
      dominant_palette: palette,
      motion_intensity: Math.round(motion * 10) / 10,
      mean_lufs: meanLufs,
      silence_ratio: silenceRatio,
    };
  });
}

// Mean momentary LUFS across the scene's time range. ebur128 emits M
// every ~100ms; we average all samples that fall within [start, end).
// Skips the well-known "-inf"-ish very-low values that ebur128 emits at
// the start of the stream before the M window has filled.
function computeMeanLufs(
  momentary: readonly MomentaryLoudness[],
  scene: TimeRange,
): number | null {
  if (momentary.length === 0) return null;
  let total = 0;
  let count = 0;
  for (const m of momentary) {
    if (m.time_ms < scene.start_ms || m.time_ms >= scene.end_ms) continue;
    if (m.lufs < -70) continue; // ebur128 floor / silence sentinel
    total += m.lufs;
    count++;
  }
  if (count === 0) return null;
  return Math.round((total / count) * 10) / 10;
}

// Share of the scene's duration that overlaps with detected silent_segments.
// 0 = no silence in the scene. 1 = entirely silent.
function computeSilenceRatio(
  scene: TimeRange,
  silentSegments: readonly TimeRange[],
): number {
  const sceneDur = scene.end_ms - scene.start_ms;
  if (sceneDur <= 0) return 0;
  let overlap = 0;
  for (const s of silentSegments) {
    const lo = Math.max(scene.start_ms, s.start_ms);
    const hi = Math.min(scene.end_ms, s.end_ms);
    if (hi > lo) overlap += hi - lo;
  }
  return Math.round((overlap / sceneDur) * 100) / 100;
}

// Per-scene dominant palette via a single midpoint-frame extract +
// histogram bucketing in JS. ~50ms per scene; sequential keeps memory
// bounded but is parallelisable later if needed.
async function runScenePalettes(
  sourcePath: string,
  scenes: readonly TimeRange[],
  signal: AbortSignal,
): Promise<readonly (readonly PaletteEntry[])[]> {
  const out: PaletteEntry[][] = [];
  for (const scene of scenes) {
    const ts = (scene.start_ms + scene.end_ms) / 2 / 1000;
    try {
      out.push(await extractPaletteAtTime(sourcePath, ts, signal));
    } catch {
      out.push([]);
    }
  }
  return out;
}

async function extractPaletteAtTime(
  sourcePath: string,
  timeSec: number,
  signal: AbortSignal,
): Promise<PaletteEntry[]> {
  // Pull a single 50x50 raw RGB frame at `timeSec`. 7500 bytes; fast.
  const proc = Bun.spawn(
    [
      FFMPEG,
      "-y",
      "-loglevel",
      "error",
      "-ss",
      timeSec.toFixed(3),
      "-i",
      sourcePath,
      "-frames:v",
      "1",
      "-vf",
      "scale=50:50,format=rgb24",
      "-f",
      "rawvideo",
      "-",
    ],
    { stdout: "pipe", stderr: "ignore", signal },
  );
  const buf = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  if (buf.length < 3) return [];

  // 6×6×6 = 216 buckets. Fine enough resolution to distinguish e.g.
  // "deep navy" from "royal blue", coarse enough that minor noise
  // doesn't fragment.
  const buckets = new Map<number, { r: number; g: number; b: number; count: number }>();
  const bucketsPerChannel = 6;
  for (let i = 0; i + 2 < buf.length; i += 3) {
    const r = buf[i]!;
    const g = buf[i + 1]!;
    const b = buf[i + 2]!;
    const br = Math.min(bucketsPerChannel - 1, Math.floor((r / 256) * bucketsPerChannel));
    const bg = Math.min(bucketsPerChannel - 1, Math.floor((g / 256) * bucketsPerChannel));
    const bb = Math.min(bucketsPerChannel - 1, Math.floor((b / 256) * bucketsPerChannel));
    const key = (br * bucketsPerChannel + bg) * bucketsPerChannel + bb;
    const existing = buckets.get(key);
    if (existing === undefined) {
      buckets.set(key, { r, g, b, count: 1 });
    } else {
      existing.r += r;
      existing.g += g;
      existing.b += b;
      existing.count += 1;
    }
  }
  const totalPixels = buf.length / 3;
  const entries = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((e) => ({
      r: Math.round(e.r / e.count),
      g: Math.round(e.g / e.count),
      b: Math.round(e.b / e.count),
      frequency: Math.round((e.count / totalPixels) * 1000) / 1000,
    }));
  return entries;
}
