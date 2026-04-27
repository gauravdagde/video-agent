// whisper.cpp subprocess wrapper. Mirrors `ffmpeg.ts`'s pattern.
//
// Install (one-time): `brew install whisper-cpp` (puts `whisper-cli` on PATH).
// Then download or point WHISPER_MODEL at a `ggml-*.bin` model — `base.en`
// is recommended for English ad creative (~140MB, fast, accurate enough).

// Read env vars at call time — tests configure them in beforeAll, which
// runs after module import. Same pattern as `storagePaths.ROOT()`.
function whisperBin(): string {
  return process.env.WHISPER_BIN ?? "whisper-cli";
}

export interface WhisperResult {
  stdout: string;
  stderr: string;
}

export async function runWhisper(
  args: readonly string[],
  signal: AbortSignal,
): Promise<WhisperResult> {
  return runChild(whisperBin(), args, signal);
}

export function getWhisperModel(): string | null {
  const m = process.env.WHISPER_MODEL ?? "";
  return m.length > 0 ? m : null;
}

async function runChild(
  bin: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<WhisperResult> {
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
