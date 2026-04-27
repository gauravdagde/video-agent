import { describe, expect, test } from "bun:test";
import { buildToolSearchTool } from "./loopTools.ts";
import { editingAgentTools } from "../tools/registry.ts";
import type { ToolUseContext } from "../Tool.ts";

const ctx: ToolUseContext = {
  agentId: "atest-0000000000000000",
  brandId: "demo-brand",
  campaignId: "demo-campaign",
  abortSignal: new AbortController().signal,
};

describe("ToolSearch", () => {
  test("matches a deferred tool by query and adds it to discovered", async () => {
    const discovery = { discovered: new Set<string>() };
    const tool = buildToolSearchTool(editingAgentTools, discovery);
    const r = await tool.call(
      tool.validateInput({ query: "analyse video metadata" }),
      ctx,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.output.matches.length).toBeGreaterThan(0);
    expect(r.output.matches[0]!.name).toBe("VideoAnalyse");
    expect(discovery.discovered.has("VideoAnalyse")).toBe(true);
  });

  test("does NOT surface always-load tools", async () => {
    const discovery = { discovered: new Set<string>() };
    const tool = buildToolSearchTool(editingAgentTools, discovery);
    // TrimClip is alwaysLoad — it should never appear in ToolSearch results.
    const r = await tool.call(
      tool.validateInput({ query: "trim clip cut between timestamps" }),
      ctx,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.output.matches.find((m) => m.name === "TrimClip")).toBeUndefined();
  });

  test("multiple distinct queries accumulate the discovered set", async () => {
    const discovery = { discovered: new Set<string>() };
    const tool = buildToolSearchTool(editingAgentTools, discovery);
    await tool.call(tool.validateInput({ query: "analyse video metadata" }), ctx);
    await tool.call(tool.validateInput({ query: "transcript extract speech" }), ctx);
    expect(discovery.discovered.has("VideoAnalyse")).toBe(true);
    expect(discovery.discovered.has("TranscriptExtract")).toBe(true);
  });

  test("returns helpful note when nothing matches", async () => {
    const discovery = { discovered: new Set<string>() };
    const tool = buildToolSearchTool(editingAgentTools, discovery);
    const r = await tool.call(
      tool.validateInput({ query: "completely unrelated nonsense xyzzy" }),
      ctx,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.output.matches).toEqual([]);
    expect(r.output.note).toContain("No deferred tools matched");
  });
});
