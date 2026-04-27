import { describe, expect, test } from "bun:test";
import {
  reactiveCompact,
  reactiveCompactDefault,
} from "./reactiveCompact.ts";

describe("reactiveCompact", () => {
  test("under cap: passes through unchanged", async () => {
    const out = { duration_ms: 30000, scenes: [1, 2, 3] };
    const r = await reactiveCompact(out, {
      perResultByteCap: 1000,
    });
    expect(r.compacted).toBe(false);
    expect(r.content).toBe(JSON.stringify(out));
  });

  test("over cap: replaces with summary blob", async () => {
    const big = { junk: "x".repeat(10_000), duration_ms: 30000 };
    const r = await reactiveCompact(big, {
      perResultByteCap: 1000,
      preserveFields: ["duration_ms"],
    });
    expect(r.compacted).toBe(true);
    expect(r.compactedSize).toBeLessThan(r.originalSize);
    const parsed = JSON.parse(r.content) as Record<string, unknown>;
    expect(parsed._reactive_compacted).toBe(true);
    expect(parsed.preserved).toEqual({ duration_ms: 30000 });
    expect(parsed.original_size_bytes).toBe(r.originalSize);
  });

  test("preserved fields survive the cap with the default schema", async () => {
    const big = {
      duration_ms: 60000,
      resolution: { width: 1920, height: 1080 },
      frame_rate: 30,
      has_audio: true,
      payload: "y".repeat(100_000),
    };
    const r = await reactiveCompact(big, reactiveCompactDefault);
    expect(r.compacted).toBe(true);
    const parsed = JSON.parse(r.content) as Record<string, unknown>;
    expect(parsed.preserved).toEqual({
      duration_ms: 60000,
      resolution: { width: 1920, height: 1080 },
      frame_rate: 30,
      has_audio: true,
    });
  });

  test("no preserve fields configured: empty preserved object", async () => {
    const big = { junk: "x".repeat(10_000) };
    const r = await reactiveCompact(big, { perResultByteCap: 100 });
    const parsed = JSON.parse(r.content) as Record<string, unknown>;
    expect(parsed.preserved).toEqual({});
  });

  test("custom summariser is called when output exceeds cap", async () => {
    let summariserCalled = false;
    const big = { junk: "x".repeat(5_000), duration_ms: 1 };
    const r = await reactiveCompact(big, {
      perResultByteCap: 100,
      preserveFields: ["duration_ms"],
      summarise: async (json) => {
        summariserCalled = true;
        return `forked-summary of ${json.length} bytes`;
      },
    });
    expect(summariserCalled).toBe(true);
    const parsed = JSON.parse(r.content) as Record<string, unknown>;
    expect(parsed.summary).toContain("forked-summary");
  });

  test("non-object output: passes through as-is when under cap", async () => {
    const r = await reactiveCompact("hello", reactiveCompactDefault);
    expect(r.compacted).toBe(false);
    expect(r.content).toBe('"hello"');
  });

  test("array output: preserved field extraction skipped", async () => {
    const arr = Array(2000).fill("x").join("");
    const r = await reactiveCompact(arr, {
      perResultByteCap: 100,
      preserveFields: ["duration_ms"],
    });
    expect(r.compacted).toBe(true);
    const parsed = JSON.parse(r.content) as Record<string, unknown>;
    expect(parsed.preserved).toEqual({});
  });
});
