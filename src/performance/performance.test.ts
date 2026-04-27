import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  checkPerformanceGate,
  countDeliveryReceipts,
  loadGateState,
  saveGateState,
} from "./gate.ts";
import {
  parseConsolidatorOutput,
  runPerformanceAgent,
} from "./runPerformanceAgent.ts";
import { storagePaths } from "../storage/paths.ts";
import type { BrandId } from "../types/video.ts";

const TMP = path.join(
  process.env.TMPDIR ?? "/tmp",
  `video-agent-perf-${Date.now()}`,
);

const BRAND = "demo-brand" as BrandId;

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  process.env.VIDEO_AGENT_STORAGE = TMP;
});
afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
  delete process.env.VIDEO_AGENT_STORAGE;
});
afterEach(async () => {
  await rm(path.join(TMP, "brand"), { recursive: true, force: true });
});

async function writeReceipts(campaign: string, n: number): Promise<void> {
  const dir = path.join(
    TMP,
    "brand",
    BRAND,
    "campaigns",
    campaign,
    "deliveries",
  );
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    await writeFile(
      path.join(dir, `mock_${campaign}_${i}.json`),
      JSON.stringify({ receipt_id: `mock_${campaign}_${i}` }),
    );
  }
}

describe("countDeliveryReceipts", () => {
  test("returns 0 when no campaigns", async () => {
    expect(await countDeliveryReceipts(BRAND)).toBe(0);
  });

  test("counts receipts across campaigns", async () => {
    await writeReceipts("c1", 3);
    await writeReceipts("c2", 5);
    expect(await countDeliveryReceipts(BRAND)).toBe(8);
  });
});

describe("gate state", () => {
  test("returns default when no file", async () => {
    const s = await loadGateState(BRAND);
    expect(s.lastRunAtMs).toBe(0);
    expect(s.lastReceiptCount).toBe(0);
  });

  test("save/load round-trip", async () => {
    await saveGateState(BRAND, {
      lastRunAtMs: 1700_000_000_000,
      lastReceiptCount: 42,
    });
    const s = await loadGateState(BRAND);
    expect(s.lastRunAtMs).toBe(1700_000_000_000);
    expect(s.lastReceiptCount).toBe(42);
  });
});

describe("checkPerformanceGate", () => {
  test("first run with enough datapoints: shouldRun=true", async () => {
    await writeReceipts("c1", 25);
    const d = await checkPerformanceGate(BRAND, {
      minIntervalMs: 1000,
      minNewDatapoints: 20,
    });
    expect(d.shouldRun).toBe(true);
    expect(d.currentReceiptCount).toBe(25);
  });

  test("interval not met: shouldRun=false", async () => {
    await writeReceipts("c1", 25);
    await saveGateState(BRAND, {
      lastRunAtMs: Date.now(), // just now
      lastReceiptCount: 0,
    });
    const d = await checkPerformanceGate(BRAND, {
      minIntervalMs: 60_000,
      minNewDatapoints: 1,
    });
    expect(d.shouldRun).toBe(false);
    expect(d.reason).toContain("interval not met");
  });

  test("not enough new datapoints: shouldRun=false", async () => {
    await writeReceipts("c1", 5);
    await saveGateState(BRAND, {
      lastRunAtMs: 0,
      lastReceiptCount: 0,
    });
    const d = await checkPerformanceGate(BRAND, {
      minIntervalMs: 1,
      minNewDatapoints: 20,
    });
    expect(d.shouldRun).toBe(false);
    expect(d.reason).toContain("new datapoints");
  });

  test("both gates passed: shouldRun=true", async () => {
    await writeReceipts("c1", 30);
    await saveGateState(BRAND, {
      lastRunAtMs: 0,
      lastReceiptCount: 5,
    });
    const d = await checkPerformanceGate(BRAND, {
      minIntervalMs: 1,
      minNewDatapoints: 20,
    });
    expect(d.shouldRun).toBe(true);
  });
});

describe("runPerformanceAgent", () => {
  test("skips when gate denies", async () => {
    const r = await runPerformanceAgent({
      brandId: BRAND,
      gate: { minIntervalMs: 1, minNewDatapoints: 1000 },
      consolidate: async () => ["should not be called"],
    });
    expect(r.ran).toBe(false);
    expect(r.linesWritten).toBe(0);
  });

  test("runs and writes lines when gate passes", async () => {
    await writeReceipts("c1", 25);
    let calledFor = "";
    const r = await runPerformanceAgent({
      brandId: BRAND,
      gate: { minIntervalMs: 1, minNewDatapoints: 20 },
      consolidate: async (b) => {
        calledFor = b;
        return ["- learned thing 1", "- learned thing 2"];
      },
    });
    expect(r.ran).toBe(true);
    expect(r.linesWritten).toBe(2);
    expect(calledFor).toBe(BRAND);
    const content = await readFile(
      storagePaths.performanceMemory(BRAND),
      "utf-8",
    );
    expect(content).toContain("learned thing 1");
    expect(content).toContain("learned thing 2");
  });

  test("updates gate state after a successful run", async () => {
    await writeReceipts("c1", 25);
    await runPerformanceAgent({
      brandId: BRAND,
      gate: { minIntervalMs: 1, minNewDatapoints: 20 },
      consolidate: async () => ["- one line"],
    });
    const s = await loadGateState(BRAND);
    expect(s.lastReceiptCount).toBe(25);
    expect(s.lastRunAtMs).toBeGreaterThan(0);
  });

  test("consolidator throwing returns ran=false but doesn't crash", async () => {
    await writeReceipts("c1", 25);
    const r = await runPerformanceAgent({
      brandId: BRAND,
      gate: { minIntervalMs: 1, minNewDatapoints: 20 },
      consolidate: async () => {
        throw new Error("LLM unavailable");
      },
    });
    expect(r.ran).toBe(false);
    expect(r.reason).toContain("consolidator threw");
  });
});

describe("parseConsolidatorOutput", () => {
  test("parses fenced JSON with lines array", () => {
    const out = parseConsolidatorOutput(
      'Verdict.\n```json\n{"lines": ["- a", "- b"]}\n```',
    );
    expect(out).toEqual(["- a", "- b"]);
  });

  test("returns empty array on unparseable input", () => {
    expect(parseConsolidatorOutput("nothing here")).toEqual([]);
  });

  test("returns empty array when JSON is missing the lines field", () => {
    expect(parseConsolidatorOutput("```json\n{\"foo\":1}\n```")).toEqual([]);
  });

  test("filters out non-string and empty entries", () => {
    const out = parseConsolidatorOutput(
      '```json\n{"lines": ["- ok", "", "  ", null, 42]}\n```',
    );
    expect(out).toEqual(["- ok"]);
  });
});
