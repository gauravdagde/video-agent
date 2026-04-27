// Subprocess wrappers for ffmpeg / ffprobe.
// Override the binary location with FFMPEG_BIN / FFPROBE_BIN for tests.
const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_BIN ?? "ffprobe";

export interface FfmpegResult {
  stdout: string;
  stderr: string;
}

export async function runFfmpeg(
  args: readonly string[],
  signal: AbortSignal,
): Promise<FfmpegResult> {
  return runChild(FFMPEG, ["-y", "-loglevel", "error", ...args], signal);
}

export async function runFfprobe(
  args: readonly string[],
  signal: AbortSignal,
): Promise<FfmpegResult> {
  return runChild(FFPROBE, args, signal);
}

async function runChild(
  bin: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<FfmpegResult> {
  const proc = Bun.spawn([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `${bin} exited ${code}: ${truncate(stderr, 1000)}`,
    );
  }
  return { stdout, stderr };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

export async function ensureDir(p: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(p, { recursive: true });
}
