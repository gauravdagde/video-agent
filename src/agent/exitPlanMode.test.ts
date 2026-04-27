import { describe, expect, test } from "bun:test";
import {
  buildExitPlanModeTool,
  defaultPlanApprover,
  type EditPlanSubmission,
  type PlanApprovalState,
} from "./loopTools.ts";
import type { ToolUseContext } from "../Tool.ts";
import { newJobId } from "../types/ids.ts";

const ctx: ToolUseContext = {
  agentId: "atest-0000000000000000",
  brandId: "demo-brand",
  campaignId: "demo-campaign",
  abortSignal: new AbortController().signal,
};

const samplePlan: EditPlanSubmission = {
  variant_spec_id: "demo-spec-tiktok",
  scenes: [{ source_start_ms: 0, source_end_ms: 5000 }],
  overlays: [],
  audio: { source: "original" },
  estimated_duration_ms: 5000,
};

describe("ExitPlanMode", () => {
  test("approves and stamps EditPlanIds", async () => {
    const state: PlanApprovalState = { approved: false, approvedPlans: [] };
    const tool = buildExitPlanModeTool(state, defaultPlanApprover, () =>
      newJobId("compact"),
    );
    const r = await tool.call(
      tool.validateInput({ plans: [samplePlan] }),
      ctx,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.output.approved).toBe(true);
    expect(r.output.approved_plan_count).toBe(1);
    expect(state.approved).toBe(true);
    expect(state.approvedPlans).toHaveLength(1);
    expect(state.approvedPlans[0]!.id).toBeDefined();
  });

  test("denial leaves state untouched", async () => {
    const state: PlanApprovalState = { approved: false, approvedPlans: [] };
    const denyApprover = async () => ({
      approved: false,
      reason: "novelty",
    });
    const tool = buildExitPlanModeTool(state, denyApprover, () =>
      newJobId("compact"),
    );
    const r = await tool.call(
      tool.validateInput({ plans: [samplePlan] }),
      ctx,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.output.approved).toBe(false);
    expect(r.output.reason).toBe("novelty");
    expect(state.approved).toBe(false);
    expect(state.approvedPlans).toHaveLength(0);
  });

  test("rejects empty plan list at validation", () => {
    const state: PlanApprovalState = { approved: false, approvedPlans: [] };
    const tool = buildExitPlanModeTool(state, defaultPlanApprover, () =>
      newJobId("compact"),
    );
    expect(() => tool.validateInput({ plans: [] })).toThrow();
  });

  test("rejects plan with empty scenes", () => {
    const state: PlanApprovalState = { approved: false, approvedPlans: [] };
    const tool = buildExitPlanModeTool(state, defaultPlanApprover, () =>
      newJobId("compact"),
    );
    expect(() =>
      tool.validateInput({
        plans: [{ ...samplePlan, scenes: [] }],
      }),
    ).toThrow();
  });
});
