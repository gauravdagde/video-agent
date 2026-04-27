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
  loadSessionMemory,
  MAX_SESSION_BYTES,
  MAX_SESSION_LINES,
  updateSessionMemory,
} from "./sessionMemory.ts";
import { storagePaths } from "../storage/paths.ts";
import type { BrandId, CampaignId } from "../types/video.ts";

const TMP = path.join(
  process.env.TMPDIR ?? "/tmp",
  `video-agent-session-${Date.now()}`,
);

const BRAND = "demo-brand" as BrandId;
const CAMPAIGN = "demo-campaign" as CampaignId;

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  process.env.VIDEO_AGENT_STORAGE = TMP;
});

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
  delete process.env.VIDEO_AGENT_STORAGE;
});

afterEach(async () => {
  // Clean session subtrees between tests so file state doesn't leak.
  const dir = path.join(TMP, "brand", BRAND, "campaigns", CAMPAIGN, "sessions");
  await rm(dir, { recursive: true, force: true });
});

describe("loadSessionMemory", () => {
  test("returns an empty template when the file is missing", async () => {
    const content = await loadSessionMemory(BRAND, CAMPAIGN, "fresh");
    expect(content).toContain("# Session memory: fresh");
    expect(content).toContain("(no observations yet)");
  });

  test("reads existing content verbatim when within caps", async () => {
    const file = storagePaths.sessionMemory(BRAND, CAMPAIGN, "existing");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "## notes\n- variant A tried\n- variant B failed\n");
    const content = await loadSessionMemory(BRAND, CAMPAIGN, "existing");
    expect(content).toContain("variant A tried");
    expect(content).toContain("variant B failed");
  });

  test("caps content at MAX_SESSION_LINES on read", async () => {
    const file = storagePaths.sessionMemory(BRAND, CAMPAIGN, "long");
    await mkdir(path.dirname(file), { recursive: true });
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    await writeFile(file, lines);
    const content = await loadSessionMemory(BRAND, CAMPAIGN, "long");
    expect(content.split("\n").length).toBe(MAX_SESSION_LINES);
  });

  test("caps content at MAX_SESSION_BYTES on read", async () => {
    const file = storagePaths.sessionMemory(BRAND, CAMPAIGN, "huge");
    await mkdir(path.dirname(file), { recursive: true });
    // One huge line that's over the byte cap by itself.
    await writeFile(file, "x".repeat(MAX_SESSION_BYTES * 2));
    const content = await loadSessionMemory(BRAND, CAMPAIGN, "huge");
    expect(Buffer.byteLength(content, "utf-8")).toBeLessThanOrEqual(
      MAX_SESSION_BYTES,
    );
  });
});

describe("updateSessionMemory", () => {
  test("writes the result of the updater atomically", async () => {
    const result = await updateSessionMemory(
      BRAND,
      CAMPAIGN,
      "atomic",
      ["observed: TikTok variant outperformed"],
      async (current, observations) => {
        return current + "\n\n## new\n" + observations.join("\n");
      },
    );
    expect(result.bytes).toBeGreaterThan(0);
    const onDisk = await readFile(result.path, "utf-8");
    expect(onDisk).toContain("TikTok variant outperformed");
  });

  test("caps written content at the configured limits", async () => {
    const result = await updateSessionMemory(
      BRAND,
      CAMPAIGN,
      "capped",
      [],
      async () =>
        Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"),
    );
    const onDisk = await readFile(result.path, "utf-8");
    expect(onDisk.split("\n").length).toBe(MAX_SESSION_LINES);
  });

  test("subsequent updates see the latest content", async () => {
    await updateSessionMemory(
      BRAND,
      CAMPAIGN,
      "iter",
      [],
      async () => "first version\n",
    );
    await updateSessionMemory(
      BRAND,
      CAMPAIGN,
      "iter",
      [],
      async (current) => `${current}second version\n`,
    );
    const final = await loadSessionMemory(BRAND, CAMPAIGN, "iter");
    expect(final).toContain("first version");
    expect(final).toContain("second version");
  });
});
