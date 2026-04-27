// Unit tests for the coordinator-mode primitives. The full orchestrator
// loop needs an API key (it's a runAgentLoop call); we cover that under
// the opt-in agent integration suite. These tests verify the structural
// pieces — context builder is byte-deterministic, contextCollapse rewrites
// correctly, processBrief routes correctly.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { collapseContext } from "../compact/contextCollapse.ts";
import { buildOrchestratorContext } from "./buildOrchestratorContext.ts";
import { processBrief } from "./processBrief.ts";
import type { BrandId, CampaignId } from "../types/video.ts";

type MessageParam = Anthropic.Messages.MessageParam;

const TMP = path.join(
  process.env.TMPDIR ?? "/tmp",
  `video-agent-orchestrator-${Date.now()}`,
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

describe("buildOrchestratorContext", () => {
  test("six layers in stable→dynamic order", async () => {
    const blocks = await buildOrchestratorContext(BRAND, CAMPAIGN, "s1", []);
    expect(blocks.length).toBe(6);
    const lastStable = [...blocks]
      .map((b) => b.kind)
      .lastIndexOf("stable");
    const firstDynamic = blocks.findIndex((b) => b.kind === "dynamic");
    expect(lastStable).toBeLessThan(firstDynamic);
  });

  test("byte-deterministic for the same inputs (cache-key invariant)", async () => {
    const a = await buildOrchestratorContext(BRAND, CAMPAIGN, "s1", [
      "atest-z",
      "atest-a",
    ]);
    const b = await buildOrchestratorContext(BRAND, CAMPAIGN, "s1", [
      "atest-a", // different input ORDER
      "atest-z",
    ]);
    // Order-independent — task ids are sorted canonically.
    expect(a).toEqual(b);
  });
});

describe("collapseContext", () => {
  test("disabled: noop", async () => {
    const messages: MessageParam[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    const r = await collapseContext(messages, {
      enabled: false,
      identifySubtrees: () => [],
    });
    expect(r.collapsed).toBe(0);
    expect(r.messages).toEqual(messages);
  });

  test("collapses identified subtrees, replacing with placeholders", async () => {
    const messages: MessageParam[] = [
      { role: "user", content: "init" },
      { role: "assistant", content: "child 1 turn 1" },
      { role: "user", content: "child 1 result" },
      { role: "assistant", content: "child 1 turn 2" },
      { role: "user", content: "wrap up" },
    ];
    const r = await collapseContext(messages, {
      enabled: true,
      identifySubtrees: () => [
        { start: 1, end: 4, summary: "ran child 1, all good" },
      ],
    });
    expect(r.collapsed).toBe(1);
    expect(r.droppedCount).toBe(3);
    expect(r.messages.length).toBe(messages.length - 3 + 1);
    expect(
      (r.messages[1] as { content: string }).content,
    ).toContain("ran child 1, all good");
  });

  test("multiple subtrees collapse correctly (right-to-left)", async () => {
    const messages: MessageParam[] = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg ${i}`,
    }));
    const r = await collapseContext(messages, {
      enabled: true,
      identifySubtrees: () => [
        { start: 2, end: 5, summary: "A" },
        { start: 6, end: 9, summary: "B" },
      ],
    });
    expect(r.collapsed).toBe(2);
    expect(r.droppedCount).toBe(6);
  });
});

describe("processBrief", () => {
  test("compliance_check_only returns a clearance", async () => {
    const r = await processBrief({
      type: "compliance_check_only",
      brand_id: BRAND,
      asset_path: "/tmp/x.mp4",
    });
    expect(r.type).toBe("compliance");
    if (r.type !== "compliance") throw new Error("type narrow");
    const c = r.clearance as { passed: boolean };
    expect(c.passed).toBe(true);
  });

  // edit_existing / generate_new are exercised under the integration
  // suite — they spawn full agent loops.
});
