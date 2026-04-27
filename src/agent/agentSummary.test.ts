import { describe, expect, test } from "bun:test";
import { startAgentSummary } from "./agentSummary.ts";
import type { TaskRecord } from "../Task.ts";
import type { AgentId } from "../types/ids.ts";

function makeTask(): TaskRecord {
  return {
    id: "atest-0000000000000000" as AgentId,
    type: "editing_agent",
    status: "running",
    startedAtMs: Date.now(),
    summaryLabel: "starting",
    summaryUpdatedAtMs: Date.now(),
    recentActivities: [],
    brandId: "demo-brand",
    campaignId: "demo-campaign",
  };
}

describe("startAgentSummary", () => {
  test("tick updates summaryLabel and summaryUpdatedAtMs", async () => {
    const task = makeTask();
    const before = task.summaryUpdatedAtMs;
    const handle = startAgentSummary({
      task,
      summarise: async () => "trimming hook scene",
      intervalMs: 1_000_000, // never fires automatically in this test
    });
    await Bun.sleep(2); // ensure system clock advances
    await handle._tickForTest();
    expect(task.summaryLabel).toBe("trimming hook scene");
    expect(task.summaryUpdatedAtMs).toBeGreaterThan(before);
    handle.stop();
  });

  test("trims and caps the label to 80 chars", async () => {
    const task = makeTask();
    const longLabel = "  " + "x".repeat(200) + "  ";
    const handle = startAgentSummary({
      task,
      summarise: async () => longLabel,
      intervalMs: 1_000_000,
    });
    await handle._tickForTest();
    expect(task.summaryLabel.length).toBe(80);
    expect(task.summaryLabel.startsWith("x")).toBe(true);
    handle.stop();
  });

  test("stops when task status becomes terminal", async () => {
    const task = makeTask();
    let calls = 0;
    const handle = startAgentSummary({
      task,
      summarise: async () => {
        calls++;
        return "first";
      },
      intervalMs: 1_000_000,
    });
    await handle._tickForTest();
    expect(calls).toBe(1);
    expect(task.summaryLabel).toBe("first");

    task.status = "succeeded";
    await handle._tickForTest();
    // No second call — terminal status stops the loop early.
    expect(calls).toBe(1);
    handle.stop();
  });

  test("stop() prevents post-tick mutations even if a fork was in flight", async () => {
    const task = makeTask();
    let resolveFork: (s: string) => void = () => {};
    const handle = startAgentSummary({
      task,
      summarise: () =>
        new Promise<string>((resolve) => {
          resolveFork = resolve;
        }),
      intervalMs: 1_000_000,
    });
    const tickPromise = handle._tickForTest();
    handle.stop();
    resolveFork("late label");
    await tickPromise;
    // Stop fired before tick completed — label should not have been written.
    expect(task.summaryLabel).toBe("starting");
  });

  test("summarise failure invokes onError without crashing the loop", async () => {
    const task = makeTask();
    const errors: Error[] = [];
    const handle = startAgentSummary({
      task,
      summarise: async () => {
        throw new Error("fork blew up");
      },
      onError: (e) => errors.push(e),
      intervalMs: 1_000_000,
    });
    await handle._tickForTest();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("fork blew up");
    expect(task.summaryLabel).toBe("starting"); // unchanged on error
    handle.stop();
  });

  test("interval scheduling: fires at least once when interval is short", async () => {
    const task = makeTask();
    let calls = 0;
    const handle = startAgentSummary({
      task,
      summarise: async () => {
        calls++;
        return `tick ${calls}`;
      },
      intervalMs: 30,
    });
    await Bun.sleep(80); // enough for ≥1 firing
    handle.stop();
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(task.summaryLabel.startsWith("tick")).toBe(true);
  });
});
