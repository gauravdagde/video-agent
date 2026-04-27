import { editingAgentCompactStrategy } from "../compact/CompactStrategy.ts";
import { runAgentLoop } from "../agent/runAgentLoop.ts";
import type { PermissionDecision } from "../permissions/canUseTool.ts";
import type { Tool } from "../Tool.ts";
import { newAgentId, newJobId } from "../types/ids.ts";
import type { BrandId } from "../types/video.ts";
import { buildComplianceAgentContext } from "./buildComplianceAgentContext.ts";
import type {
  ComplianceClearance,
  ComplianceFix,
  ComplianceIssue,
} from "./ComplianceResult.ts";
import { ExtractFramesTool } from "./tools/ExtractFrames.ts";

const DEFAULT_MODEL = process.env.MODEL ?? "claude-opus-4-7";

const complianceTools: readonly Tool[] = [ExtractFramesTool];

// ComplianceAgent is read-only — every tool it uses is auto-allowed.
const complianceCanUseTool: typeof allowAll = async () =>
  ({ action: "allow", reason: "compliance: read-only" }) satisfies PermissionDecision;
async function allowAll(): Promise<PermissionDecision> {
  return { action: "allow", reason: "" };
}

export interface RunComplianceAgentOpts {
  readonly assetPath: string;
  readonly brandId: BrandId;
  readonly market?: string;
  readonly platform?: string;
}

// Real ComplianceAgent. Spawns a subagent that calls ExtractFrames to see
// the rendered pixels, then returns a structured ComplianceClearance.
//
// Drop-in replacement for the always-pass stub in runComplianceCheck.ts:
// onRenderComplete (or any other caller) can be configured to use this
// instead. Default in spawnEditingAgent stays on the stub so the test
// suite doesn't require an API key — pass `compliance: runComplianceAgent`
// to opt in.
export async function runComplianceAgent(
  opts: RunComplianceAgentOpts,
): Promise<ComplianceClearance> {
  const agentId = newAgentId("compliance");
  const systemBlocks = await buildComplianceAgentContext(
    opts.brandId,
    opts.market,
    opts.platform,
  );

  const abort = new AbortController();
  const run = await runAgentLoop({
    model: DEFAULT_MODEL,
    systemBlocks,
    tools: complianceTools,
    initialMessage:
      `Inspect the asset at \`${opts.assetPath}\` for brand and platform compliance.\n` +
      `Begin by extracting frames so you can see the actual pixels.`,
    ctx: {
      agentId,
      brandId: opts.brandId,
      campaignId: "",
      abortSignal: abort.signal,
    },
    canUseTool: complianceCanUseTool,
    compactStrategy: editingAgentCompactStrategy,
  });

  const parsed = parseClearance(run.finalText);

  return {
    check_id: newJobId("compact"),
    asset_path: opts.assetPath,
    checked_at_ms: Date.now(),
    passed: parsed.passed,
    auto_fixable: parsed.auto_fixable,
    human_required: parsed.human_required,
    escalateTo: "orchestrator",
    status: parsed.passed ? "cleared" : "failed",
  };
}

interface ParsedClearance {
  readonly passed: boolean;
  readonly auto_fixable: readonly ComplianceFix[];
  readonly human_required: readonly ComplianceIssue[];
}

// The agent's final response is a fenced JSON block. We extract it
// permissively — looking for the first balanced top-level object.
function parseClearance(finalText: string): ParsedClearance {
  const match =
    finalText.match(/```json\s*\n([\s\S]*?)\n```/) ??
    finalText.match(/```\s*\n([\s\S]*?)\n```/);
  const candidate = match?.[1] ?? findFirstObject(finalText);
  if (candidate === null) {
    throw new Error(
      `compliance agent did not return parseable JSON; final text was: ${truncate(finalText, 500)}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch (e) {
    throw new Error(
      `compliance JSON parse failed: ${(e as Error).message}; candidate was: ${truncate(candidate, 500)}`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("compliance JSON was not an object");
  }
  const r = raw as Record<string, unknown>;
  return {
    passed: r.passed === true,
    auto_fixable: Array.isArray(r.auto_fixable)
      ? (r.auto_fixable as ComplianceFix[])
      : [],
    human_required: Array.isArray(r.human_required)
      ? (r.human_required as ComplianceIssue[])
      : [],
  };
}

function findFirstObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

// Test-only re-export of the parser. Underscore prefix marks "not stable
// API." If a non-test importer ever uses this we can grep for it.
export const _parseClearanceForTest = parseClearance;
