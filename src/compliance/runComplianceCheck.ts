import { newJobId } from "../types/ids.ts";
import type { BrandId } from "../types/video.ts";
import type { ComplianceClearance } from "./ComplianceResult.ts";

// Phase 1 stub. The real ComplianceAgent (Phase 3) is a runAgentLoop call
// of its own with logo/colour/typography/legal tools. The stub always
// passes so the rest of the pipeline can be exercised end-to-end without
// blocking on an unimplemented agent.
//
// The CONTRACT here is what's load-bearing — ComplianceClearance shape,
// the {passed, auto_fixable, human_required} triage, the per-check id
// — because that's what onRenderComplete and the future PreDeliver hook
// consume. Swapping the stub for a real agent later is body-swap.
export interface ComplianceCheckOpts {
  readonly assetPath: string;
  readonly brandId: BrandId;
  readonly market?: string;
  readonly platform?: string;
}

export async function runComplianceCheck(
  opts: ComplianceCheckOpts,
): Promise<ComplianceClearance> {
  return {
    check_id: newJobId("compact"),
    asset_path: opts.assetPath,
    checked_at_ms: Date.now(),
    passed: true,
    auto_fixable: [],
    human_required: [],
    escalateTo: "orchestrator",
    status: "cleared",
  };
}
