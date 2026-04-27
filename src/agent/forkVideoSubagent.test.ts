import { describe, expect, test } from "bun:test";
import {
  ContentReplacementState,
  DenialTrackingState,
  FileStateCache,
  denyNonReadonly,
  snapshotForFork,
} from "./forkVideoSubagent.ts";
import type { Tool, ToolUseContext } from "../Tool.ts";

const ctx: ToolUseContext = {
  agentId: "atest-0000000000000000",
  brandId: "demo-brand",
  campaignId: "demo-campaign",
  abortSignal: new AbortController().signal,
};

// Minimal Tool stand-ins for permission tests.
function fakeTool(name: string, readonly: boolean): Tool {
  return {
    name,
    description: "",
    inputSchema: { parse: (x: unknown) => x } as Tool["inputSchema"],
    shouldDefer: false,
    alwaysLoad: true,
    readonly,
    microCompactable: false,
    validateInput: (x: unknown) => x,
    call: async () => ({ ok: true as const, output: undefined }),
  };
}

describe("FileStateCache", () => {
  test("clone produces independent state", () => {
    const parent = new FileStateCache();
    parent.recordRead("/a", 100);
    parent.recordRead("/b", 200);

    const fork = parent.clone();
    expect(fork.size).toBe(2);
    expect(fork.getRead("/a")).toBe(100);

    // Mutate the fork — parent must NOT see it.
    fork.recordRead("/c", 300);
    expect(fork.size).toBe(3);
    expect(parent.size).toBe(2);
    expect(parent.getRead("/c")).toBeUndefined();

    // Mutate the parent — fork must NOT see it.
    parent.recordRead("/d", 400);
    expect(parent.size).toBe(3);
    expect(fork.size).toBe(3);
    expect(fork.getRead("/d")).toBeUndefined();
  });

  test("two parallel forks are independent of each other", () => {
    const parent = new FileStateCache();
    parent.recordRead("/shared", 1);

    const a = parent.clone();
    const b = parent.clone();

    a.recordRead("/from-a", 10);
    b.recordRead("/from-b", 20);

    expect(a.getRead("/from-a")).toBe(10);
    expect(a.getRead("/from-b")).toBeUndefined();

    expect(b.getRead("/from-a")).toBeUndefined();
    expect(b.getRead("/from-b")).toBe(20);

    expect(parent.getRead("/from-a")).toBeUndefined();
    expect(parent.getRead("/from-b")).toBeUndefined();
  });
});

describe("DenialTrackingState", () => {
  test("snapshot captures denials at snapshot time, not later additions", () => {
    const parent = new DenialTrackingState();
    parent.record("Bash", "h1");
    parent.record("Bash", "h2");

    const snap = parent.snapshot();
    expect(snap.size).toBe(2);
    expect(snap.has("Bash", "h1")).toBe(true);
    expect(snap.has("Bash", "h2")).toBe(true);

    // Append to parent AFTER snapshot — fork must NOT see it.
    parent.record("Bash", "h3");
    expect(parent.has("Bash", "h3")).toBe(true);
    expect(snap.has("Bash", "h3")).toBe(false);
    expect(snap.size).toBe(2);
  });
});

describe("ContentReplacementState", () => {
  test("snapshot returns frozen list, immune to subsequent enqueues", () => {
    const parent = new ContentReplacementState();
    parent.enqueue("foo", "bar");

    const snap = parent.snapshot();
    expect(snap.pending()).toHaveLength(1);

    parent.enqueue("baz", "qux");
    expect(snap.pending()).toHaveLength(1);
  });
});

describe("snapshotForFork", () => {
  test("works with all parent state present", () => {
    const fileState = new FileStateCache();
    fileState.recordRead("/a", 1);
    const denial = new DenialTrackingState();
    denial.record("Bash", "x");
    const replace = new ContentReplacementState();
    replace.enqueue("a", "b");

    const safe = snapshotForFork({
      fileStateCache: fileState,
      denialTracking: denial,
      contentReplacement: replace,
    });

    expect(safe.fileStateCache.size).toBe(1);
    expect(safe.denialTracking.size).toBe(1);
    expect(safe.contentReplacement.pending()).toHaveLength(1);
  });

  test("works with empty parent (fresh state for fork)", () => {
    const safe = snapshotForFork({});
    expect(safe.fileStateCache.size).toBe(0);
    expect(safe.denialTracking.size).toBe(0);
    expect(safe.contentReplacement.pending()).toEqual([]);
  });

  test("fork mutating its FileStateCache doesn't propagate to parent", () => {
    const fileState = new FileStateCache();
    fileState.recordRead("/a", 1);

    const safe = snapshotForFork({ fileStateCache: fileState });
    safe.fileStateCache.recordRead("/inside-fork", 99);

    expect(fileState.getRead("/inside-fork")).toBeUndefined();
    expect(fileState.size).toBe(1);
  });
});

describe("denyNonReadonly", () => {
  test("allows readonly tools", async () => {
    const d = await denyNonReadonly(fakeTool("VideoAnalyse", true), {}, ctx);
    expect(d.action).toBe("allow");
  });

  test("denies non-readonly tools", async () => {
    const d = await denyNonReadonly(fakeTool("RenderVariant", false), {}, ctx);
    expect(d.action).toBe("deny");
    if (d.action !== "deny") throw new Error("type narrow");
    expect(d.reason).toContain("non-readonly");
  });
});
