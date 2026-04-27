import { closeSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

// Plan §H — file-based per-task lock. Cross-process safe: O_EXCL atomic
// create, mtime-based TTL for stale-lock detection, mtime rewind if the
// holder dies before releasing. Mirrors Claude Code's
// `consolidationLock.ts` semantics.
//
// Why file-based: cron tasks may be invoked from multiple processes (a
// long-running daemon plus an ad-hoc `bun run …` test). In-memory locking
// wouldn't catch that case.

export interface AcquiredLock {
  readonly key: string;
  readonly path: string;
  release(): void;
}

const LOCK_DIR = (): string =>
  path.join(
    process.env.VIDEO_AGENT_STORAGE ?? "./storage",
    ".cron-locks",
  );

export async function acquireLock(
  key: string,
  ttlMs: number,
): Promise<AcquiredLock | null> {
  const dir = LOCK_DIR();
  await mkdir(dir, { recursive: true });
  const lockPath = path.join(dir, `${sanitiseKey(key)}.lock`);

  // Stale-lock detection — if a previous holder died, mtime is older
  // than ttlMs and we can claim it.
  try {
    const stat = statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < ttlMs) {
      return null; // valid lock held by someone else
    }
    unlinkSync(lockPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  // Atomic claim. O_EXCL fails if the file exists.
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw e;
  }
  try {
    writeSync(fd, `pid=${process.pid}\nacquired_at=${Date.now()}\n`);
  } finally {
    closeSync(fd);
  }

  return {
    key,
    path: lockPath,
    release() {
      try {
        unlinkSync(lockPath);
      } catch {
        // Already gone — fine.
      }
    },
  };
}

function sanitiseKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
