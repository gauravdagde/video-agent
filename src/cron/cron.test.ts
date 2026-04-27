import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { applyJitter } from "./jitter.ts";
import { acquireLock } from "./lock.ts";
import { cronScheduler } from "./scheduler.ts";

const TMP = path.join(
  process.env.TMPDIR ?? "/tmp",
  `video-agent-cron-${Date.now()}`,
);

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  process.env.VIDEO_AGENT_STORAGE = TMP;
});

afterAll(async () => {
  cronScheduler.stop();
  await rm(TMP, { recursive: true, force: true });
  delete process.env.VIDEO_AGENT_STORAGE;
});

afterEach(() => {
  for (const id of cronScheduler.registeredIds()) {
    cronScheduler.unregister(id);
  }
});

describe("applyJitter", () => {
  test("returns 0 when jitterMs is 0 or negative", () => {
    expect(applyJitter(0)).toBe(0);
    expect(applyJitter(-100)).toBe(0);
  });

  test("stays within ±jitterMs", () => {
    for (let i = 0; i < 1000; i++) {
      const j = applyJitter(500);
      expect(j).toBeGreaterThanOrEqual(-500);
      expect(j).toBeLessThanOrEqual(500);
    }
  });

  test("distribution covers both signs over many draws", () => {
    let neg = 0;
    let pos = 0;
    for (let i = 0; i < 1000; i++) {
      const j = applyJitter(100);
      if (j < 0) neg++;
      if (j > 0) pos++;
    }
    expect(neg).toBeGreaterThan(100);
    expect(pos).toBeGreaterThan(100);
  });
});

describe("acquireLock", () => {
  test("first acquirer gets the lock; second is blocked", async () => {
    const a = await acquireLock("test-key-1", 60_000);
    expect(a).not.toBeNull();
    const b = await acquireLock("test-key-1", 60_000);
    expect(b).toBeNull();
    a!.release();
    const c = await acquireLock("test-key-1", 60_000);
    expect(c).not.toBeNull();
    c!.release();
  });

  test("stale lock (older than ttl) is reclaimed", async () => {
    const a = await acquireLock("test-key-stale", 1);
    expect(a).not.toBeNull();
    // Don't release. Wait past ttl.
    await Bun.sleep(20);
    const b = await acquireLock("test-key-stale", 1);
    expect(b).not.toBeNull();
    b!.release();
  });

  test("release is idempotent — double release doesn't crash", async () => {
    const a = await acquireLock("test-key-idem", 60_000);
    expect(a).not.toBeNull();
    a!.release();
    a!.release(); // second release: file already gone
  });

  test("different keys get independent locks", async () => {
    const a = await acquireLock("key-a", 60_000);
    const b = await acquireLock("key-b", 60_000);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    a!.release();
    b!.release();
  });
});

describe("cronScheduler", () => {
  test("register + unregister round-trip", () => {
    cronScheduler.register(
      {
        id: "task-1",
        schedule: "* * * * *",
        lockKey: () => "any",
        run: async () => {},
      },
      undefined,
    );
    expect(cronScheduler.registeredIds()).toContain("task-1");
    cronScheduler.unregister("task-1");
    expect(cronScheduler.registeredIds()).not.toContain("task-1");
  });

  test("re-registering same id throws", () => {
    cronScheduler.register(
      {
        id: "dup",
        schedule: "* * * * *",
        lockKey: () => "any",
        run: async () => {},
      },
      undefined,
    );
    expect(() =>
      cronScheduler.register(
        {
          id: "dup",
          schedule: "* * * * *",
          lockKey: () => "any",
          run: async () => {},
        },
        undefined,
      ),
    ).toThrow(/already registered/);
  });

  test("_runNowForTest fires the task with lock semantics", async () => {
    let runs = 0;
    cronScheduler.register(
      {
        id: "fire-test",
        schedule: "0 0 * * *",
        lockKey: () => "fire-test-lock",
        lockTtlMs: 60_000,
        run: async () => {
          runs++;
        },
      },
      undefined,
    );
    await cronScheduler._runNowForTest("fire-test");
    expect(runs).toBe(1);
  });

  test("a held lock causes the task to be skipped, not blocked", async () => {
    let runs = 0;
    cronScheduler.register(
      {
        id: "skip-test",
        schedule: "0 0 * * *",
        lockKey: () => "skip-test-lock",
        lockTtlMs: 60_000,
        run: async () => {
          runs++;
        },
      },
      undefined,
    );
    // Hold the lock externally.
    const holder = await acquireLock(
      "skip-test:skip-test-lock",
      60_000,
    );
    expect(holder).not.toBeNull();
    try {
      await cronScheduler._runNowForTest("skip-test");
      expect(runs).toBe(0); // skipped, lock held
    } finally {
      holder!.release();
    }
  });
});
