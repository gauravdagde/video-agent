import { describe, expect, test } from "bun:test";
import { onRenderComplete } from "./onRenderComplete.ts";
import type { ToolUseContext } from "../Tool.ts";

const ctx: ToolUseContext = {
  agentId: "atest-0000000000000000",
  brandId: "demo-brand",
  campaignId: "demo-campaign",
  abortSignal: new AbortController().signal,
};

const sampleRenderOutput = {
  variant_spec_id: "demo-spec-tiktok",
  output_path: "/tmp/whatever.mp4",
  duration_ms: 6000,
  size_bytes: 1234,
};

describe("onRenderComplete", () => {
  test("passes through with continue for non-RenderVariant tools", async () => {
    const d = await onRenderComplete("TrimClip", {}, sampleRenderOutput, ctx);
    expect(d.action).toBe("continue");
  });

  test("returns modify with check_id stamped on the result for RenderVariant", async () => {
    const d = await onRenderComplete(
      "RenderVariant",
      {},
      sampleRenderOutput,
      ctx,
    );
    expect(d.action).toBe("modify");
    if (d.action !== "modify") throw new Error("type narrow");
    const r = d.replacementResult as { compliance_check_id: string };
    expect(typeof r.compliance_check_id).toBe("string");
    expect(r.compliance_check_id.length).toBeGreaterThan(0);
  });
});
