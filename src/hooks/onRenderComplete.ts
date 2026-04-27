import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyAutoFixes } from "../compliance/applyAutoFixes.ts";
import type { ComplianceClearance } from "../compliance/ComplianceResult.ts";
import { runComplianceCheck } from "../compliance/runComplianceCheck.ts";
import { storagePaths } from "../storage/paths.ts";
import type {
  AssetId,
  BrandId,
  CampaignId,
} from "../types/video.ts";
import type { HookDecision, PostToolUseHook } from "./types.ts";

interface RenderInput {
  readonly variant_spec_id?: string;
}

async function persistClearance(
  clearance: ComplianceClearance,
  toolInput: unknown,
  brandId: BrandId,
  campaignId: CampaignId,
  assetId: AssetId,
): Promise<void> {
  const i = toolInput as RenderInput;
  if (i.variant_spec_id === undefined) return;
  const file = storagePaths.variantClearance(
    brandId,
    campaignId,
    assetId,
    i.variant_spec_id,
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(clearance, null, 2), "utf-8");
}

export type ComplianceCheckFn = (opts: {
  readonly assetPath: string;
  readonly brandId: BrandId;
  readonly market?: string;
  readonly platform?: string;
}) => Promise<ComplianceClearance>;

// Pattern 3 §D — PostToolUse hook on RenderVariant.
// Fires after every render, runs ComplianceAgent on the rendered pixels,
// and routes to one of three outcomes:
//   - pass         → continue (model sees original result)
//   - auto-fix     → modify (model sees the fixed result; asset has been
//                    rewritten on disk, no re-render needed)
//   - escalate     → escalate_to_leader (Phase 2 routes via swarm bridge §N;
//                    Phase 1 falls back to block at the loop level)
//
// The hook records the compliance clearance id on its return so the
// PreDeliver hook (Phase 3) can re-validate freshness before money is
// spent.

interface RenderVariantOutput {
  readonly variant_spec_id: string;
  readonly output_path: string;
  readonly duration_ms: number;
  readonly size_bytes: number;
}

export interface BuildOnRenderCompleteOpts {
  // T3.4 — cap on how many times we'll re-check after auto-fixing the
  // same output. 1 means: fix once, re-check once, then accept the verdict.
  // Higher values let auto-fixes chain (rare but possible). Recursion is
  // tracked per output_path inside the closure.
  readonly maxRecheckDepth?: number;
}

const DEFAULT_MAX_RECHECK_DEPTH = 1;

// Build the hook with a specific compliance check function. The
// EditingAgent picks which one — stub for Phase 1 default, real
// ComplianceAgent for opt-in. Caller controls API cost this way.
export function buildOnRenderComplete(
  check: ComplianceCheckFn,
  opts: BuildOnRenderCompleteOpts = {},
): PostToolUseHook {
  const maxRecheckDepth = opts.maxRecheckDepth ?? DEFAULT_MAX_RECHECK_DEPTH;
  // T3.4 — depth tracking lives in the closure. One hook instance per
  // EditingAgent run (constructed in spawnEditingAgent) → no cross-run leak.
  const recheckDepth = new Map<string, number>();

  return async (toolName, input, output, ctx): Promise<HookDecision> => {
    if (toolName !== "RenderVariant") return { action: "continue" };

    const r = output as RenderVariantOutput;
    const clearance = await check({
      assetPath: r.output_path,
      brandId: ctx.brandId as BrandId,
    });

    // T2.2 — persist clearance so canUseTool Tier 2 + preDeliver hook can
    // find it when the agent moves on to deliver this variant.
    if (ctx.assetId !== undefined) {
      await persistClearance(
        clearance,
        input,
        ctx.brandId as BrandId,
        ctx.campaignId as CampaignId,
        ctx.assetId as AssetId,
      );
    }

    if (clearance.passed) {
      return {
        action: "modify",
        replacementResult: { ...r, compliance_check_id: clearance.check_id },
      };
    }

    if (clearance.auto_fixable.length > 0) {
      const result = await applyAutoFixes(
        r.output_path,
        clearance.auto_fixable,
        ctx.abortSignal,
      );

      // T3.5 — needs_rerender takes priority over skipped/escalate. If any
      // fix requires re-rendering (logo_position is the canonical case),
      // surface that to the agent loop with the suggested EditPlan delta.
      if (result.needsRerender.length > 0) {
        return {
          action: "needs_rerender",
          reason: result.needsRerender.map((n) => n.reason).join("; "),
          suggestedEditPlanDelta: mergeDeltas(result.needsRerender),
        };
      }

      // T3.6 — typography is a deliberate non-fix. If it appears in
      // skipped, the escalation reason calls it out explicitly so the
      // human reviewer understands "design review needed", not "the
      // system tried and failed."
      if (result.skipped.length > 0) {
        return {
          action: "escalate_to_leader",
          reason: buildEscalationReason(result, clearance.auto_fixable.length),
          data: {
            check_id: clearance.check_id,
            applied: result.applied,
            skipped: result.skipped,
            agentId: ctx.agentId,
            brandId: ctx.brandId,
            campaignId: ctx.campaignId,
          },
        };
      }

      // T3.4 — all fixes applied. Re-check the modified asset before
      // accepting. Auto-fixes can introduce new violations (e.g. saturation
      // boost pushes a brand colour out of range). Capped recursion via the
      // closure-level depth Map.
      const depth = recheckDepth.get(r.output_path) ?? 0;
      if (depth < maxRecheckDepth && result.applied.length > 0) {
        recheckDepth.set(r.output_path, depth + 1);
        const reCheck = await check({
          assetPath: r.output_path,
          brandId: ctx.brandId as BrandId,
        });
        if (!reCheck.passed) {
          // Auto-fix introduced or didn't resolve violations — escalate.
          // Don't recurse into another auto-fix attempt; the leader gets
          // both clearances so they can see what changed.
          return {
            action: "escalate_to_leader",
            reason: `auto-fix re-check failed at depth ${depth + 1}`,
            data: {
              check_id: reCheck.check_id,
              previous_check_id: clearance.check_id,
              auto_fixes_applied: result.applied,
              new_issues: reCheck.human_required,
              new_auto_fixable: reCheck.auto_fixable,
              agentId: ctx.agentId,
              brandId: ctx.brandId,
              campaignId: ctx.campaignId,
            },
          };
        }
      }

      // All fixes applied AND re-check passed (or was skipped per depth cap).
      // The asset on disk has been rewritten in place; the model sees the
      // same output_path but with the corrected pixels.
      return {
        action: "modify",
        replacementResult: {
          ...r,
          compliance_check_id: clearance.check_id,
          auto_fixes_applied: result.applied.length,
        },
      };
    }

    return {
      action: "escalate_to_leader",
      reason: `compliance failed for ${r.output_path}`,
      data: {
        check_id: clearance.check_id,
        issues: clearance.human_required,
        agentId: ctx.agentId,
        brandId: ctx.brandId,
        campaignId: ctx.campaignId,
      },
    };
  };
}

function buildEscalationReason(
  result: Awaited<ReturnType<typeof applyAutoFixes>>,
  totalCount: number,
): string {
  const skippedKinds = new Set(result.skipped.map((s) => s.fix.kind));
  const base = `auto-fix incomplete: ${result.skipped.length} of ${totalCount} fix(es) could not be applied`;
  // T3.6 — typography needs design review, not engineering follow-up.
  if (skippedKinds.has("typography")) {
    return `${base} (typography requires design review — no auto-fix path exists)`;
  }
  return base;
}

function mergeDeltas(
  needs: readonly { suggestedDelta: Record<string, unknown> }[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const n of needs) Object.assign(merged, n.suggestedDelta);
  return merged;
}

// Default — uses the stub. Stays compatible with existing test suites
// that don't have an API key.
export const onRenderComplete: PostToolUseHook =
  buildOnRenderComplete(runComplianceCheck);
