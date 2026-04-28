import { z } from "zod";
import type { Tool, ToolUseContext } from "../Tool.ts";
import type { EditPlan } from "../types/video.ts";

// Loop-local control-plane tools — ToolSearch (§E) and ExitPlanMode (§C).
// These are injected per-loop because their behaviour closes over loop
// state (discovered tool set, plan-approval flag). They are NOT in the
// registry — they only make sense inside a runAgentLoop call.

// --- ToolSearch (§E) ----------------------------------------------------

const ToolSearchInput = z.object({
  query: z.string().min(1).max(200),
  max_results: z.number().int().positive().max(20).default(5),
});

interface ToolSearchMatch {
  readonly name: string;
  readonly description: string;
}

interface ToolSearchOutput {
  readonly matches: readonly ToolSearchMatch[];
  readonly note: string;
}

export interface ToolDiscovery {
  // Names of deferred tools that have been surfaced via ToolSearch and
  // should be sent in the next turn's tools array.
  readonly discovered: Set<string>;
}

// Build a ToolSearch instance bound to a specific tool registry and
// discovery set. Calling it adds matched names to `discovered`; the loop
// reads `discovered` when assembling the next turn's tools array.
export function buildToolSearchTool(
  allTools: readonly Tool[],
  discovery: ToolDiscovery,
): Tool<z.infer<typeof ToolSearchInput>, ToolSearchOutput> {
  return {
    name: "ToolSearch",
    description:
      "Search for tools that were deferred from turn 1. Pass a short " +
      "keyword query (e.g. 'analyse video metadata'). Matched tools become " +
      "available to call on your NEXT turn — they will appear in your tools " +
      "list. Always call ToolSearch BEFORE assuming a tool exists.",
    inputSchema: ToolSearchInput,
    shouldDefer: false,
    alwaysLoad: true,
    readonly: true,
    microCompactable: false,

    validateInput(input: unknown) {
      return ToolSearchInput.parse(input);
    },

    async call(input, _ctx: ToolUseContext) {
      const matches = scoreAndPick(allTools, input.query, input.max_results);
      for (const m of matches) discovery.discovered.add(m.name);
      return {
        ok: true as const,
        output: {
          matches: matches.map((t) => ({
            name: t.name,
            description: t.description,
          })),
          note:
            matches.length === 0
              ? "No deferred tools matched. Try a different query."
              : "Matched tools are now in your tools list. Call them by name on the next turn.",
        },
      };
    },
  };
}

// Score by simple keyword overlap against (searchHint || description) and
// name. Only deferred tools are eligible — already-loaded tools should be
// called directly without a ToolSearch round-trip.
function scoreAndPick(
  allTools: readonly Tool[],
  query: string,
  max: number,
): readonly Tool[] {
  const q = tokenise(query);
  if (q.length === 0) return [];
  const eligible = allTools.filter((t) => t.shouldDefer);
  const scored = eligible.map((t) => {
    const haystack = tokenise(
      `${t.name} ${t.searchHint ?? ""} ${t.description}`,
    );
    let score = 0;
    for (const token of q) if (haystack.includes(token)) score++;
    return { tool: t, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((s) => s.tool);
}

function tokenise(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

// --- ExitPlanMode (§C) --------------------------------------------------

const SceneInstructionSchema = z.object({
  source_start_ms: z.number().int().nonnegative(),
  source_end_ms: z.number().int().positive(),
});

const OverlayInstructionSchema = z.object({
  kind: z.enum(["image", "text", "logo"]),
  asset_path: z.string().optional(),
  text: z.string().optional(),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().positive(),
  position: z.object({ x: z.number(), y: z.number() }),
  scale: z.number().positive().optional(),
});

const AudioInstructionSchema = z.object({
  source: z.enum(["original", "voiceover", "music"]),
  voiceover_path: z.string().optional(),
  music_path: z.string().optional(),
  duck_db: z.number().optional(),
  normalise_lufs: z.number().optional(),
});

// The agent submits plans WITHOUT EditPlanIds — we mint them on approval.
// `id` is derivable, the rest is what the agent has to design.
const EditPlanSubmissionSchema = z.object({
  variant_spec_id: z.string(),
  scenes: z.array(SceneInstructionSchema).min(1),
  overlays: z.array(OverlayInstructionSchema),
  audio: AudioInstructionSchema,
  estimated_duration_ms: z.number().int().positive(),
});

const ExitPlanModeInput = z.object({
  plans: z.array(EditPlanSubmissionSchema).min(1),
  rationale: z.string().min(1).max(2000).optional(),
});

export type EditPlanSubmission = z.infer<typeof EditPlanSubmissionSchema>;

interface ExitPlanModeOutput {
  readonly approved: boolean;
  readonly approved_plan_count: number;
  readonly reason?: string;
}

export interface PlanApprovalState {
  approved: boolean;
  approvedPlans: readonly EditPlan[];
}

export type PlanApprover = (
  plans: readonly EditPlanSubmission[],
  rationale: string | undefined,
) => Promise<{ readonly approved: boolean; readonly reason?: string }>;

// Quiet by default — the CLI renderer surfaces plan-approvals via the
// agent's text turns. Set VIDEO_AGENT_VERBOSE=1 to restore the legacy
// "[plan-approval]" log output (useful for headless automation runs).
export const defaultPlanApprover: PlanApprover = async (plans, rationale) => {
  if (process.env.VIDEO_AGENT_VERBOSE === "1") {
    console.log(`[plan-approval] auto-approving ${plans.length} plan(s)`);
    if (rationale !== undefined) {
      console.log(`[plan-approval] rationale: ${rationale.slice(0, 240)}`);
    }
  }
  return { approved: true };
};

export function buildExitPlanModeTool(
  state: PlanApprovalState,
  approver: PlanApprover,
  mintEditPlanId: () => string,
): Tool<z.infer<typeof ExitPlanModeInput>, ExitPlanModeOutput> {
  return {
    name: "ExitPlanMode",
    description:
      "Submit your edit plans for approval. You MUST call this BEFORE any " +
      "RenderVariant call — RenderVariant will be denied until plans are " +
      "approved. Pass exactly one EditPlan per VariantSpec, in order. " +
      "Include a `rationale` summarising your edit decisions if anything " +
      "is non-obvious from the plans themselves.",
    inputSchema: ExitPlanModeInput,
    shouldDefer: false,
    alwaysLoad: true,
    readonly: true,
    microCompactable: false,

    validateInput(input: unknown) {
      return ExitPlanModeInput.parse(input);
    },

    async call(input, _ctx: ToolUseContext) {
      const decision = await approver(input.plans, input.rationale);
      if (!decision.approved) {
        return {
          ok: true as const,
          output: {
            approved: false,
            approved_plan_count: 0,
            ...(decision.reason !== undefined
              ? { reason: decision.reason }
              : {}),
          },
        };
      }
      // Mint ids and freeze the plans. This is what RenderVariant will
      // expect to see surfaced through the loop's planApproval state.
      const stamped: EditPlan[] = input.plans.map(
        (p): EditPlan => ({
          id: mintEditPlanId() as EditPlan["id"],
          variant_spec_id: p.variant_spec_id as EditPlan["variant_spec_id"],
          scenes: p.scenes,
          overlays: p.overlays.map(toOverlay),
          audio: toAudio(p.audio),
          estimated_duration_ms: p.estimated_duration_ms,
        }),
      );
      state.approved = true;
      state.approvedPlans = stamped;
      return {
        ok: true as const,
        output: {
          approved: true,
          approved_plan_count: stamped.length,
          ...(decision.reason !== undefined
            ? { reason: decision.reason }
            : {}),
        },
      };
    },
  };
}

function toOverlay(
  o: z.infer<typeof OverlayInstructionSchema>,
): EditPlan["overlays"][number] {
  return {
    kind: o.kind,
    ...(o.asset_path !== undefined ? { asset_path: o.asset_path } : {}),
    ...(o.text !== undefined ? { text: o.text } : {}),
    start_ms: o.start_ms,
    end_ms: o.end_ms,
    position: o.position,
    ...(o.scale !== undefined ? { scale: o.scale } : {}),
  };
}

function toAudio(
  a: z.infer<typeof AudioInstructionSchema>,
): EditPlan["audio"] {
  return {
    source: a.source,
    ...(a.voiceover_path !== undefined ? { voiceover_path: a.voiceover_path } : {}),
    ...(a.music_path !== undefined ? { music_path: a.music_path } : {}),
    ...(a.duck_db !== undefined ? { duck_db: a.duck_db } : {}),
    ...(a.normalise_lufs !== undefined ? { normalise_lufs: a.normalise_lufs } : {}),
  };
}

// --- EnterPlanMode (T5.2) ----------------------------------------------

const EnterPlanModeInput = z.object({
  rationale: z.string().min(1).max(2000).optional(),
});

interface EnterPlanModeOutput {
  readonly entered: true;
}

// EnterPlanMode signals "I'm now planning, don't approve any RenderVariant
// yet" — symmetric with ExitPlanMode. Phase-1 scope: it's a marker call
// that the agent makes to indicate intent. The plan-mode flag on the
// loop's planApproval state is set by ExitPlanMode (the approval moment);
// EnterPlanMode just records that the agent is reasoning about plans.
//
// Chat-mode behaviour: each EnterPlanMode call resets the loop's
// planApproval state — `approved=false` and `approvedPlans` cleared. This
// makes the gate symmetric across user messages: after rendering variant
// A, when the user says "now do variant B", the agent calls EnterPlanMode
// again and the user gets a fresh y/n prompt at the next ExitPlanMode.
// Without this reset the gate would be one-shot per session.
//
// Useful as a discipline marker — the agent calls EnterPlanMode before
// the analysis tools (SceneDetect / TranscriptExtract / VideoAnalyse)
// and ExitPlanMode after submitting plans. Operators monitoring
// recentActivities see a clear mode boundary.
export function buildEnterPlanModeTool(
  state: PlanApprovalState,
): Tool<z.infer<typeof EnterPlanModeInput>, EnterPlanModeOutput> {
  return {
    name: "EnterPlanMode",
    description:
      "Signal that you're about to start planning. Optional but encouraged " +
      "as a clarity marker before calling analysis tools. The actual " +
      "plan-approval gate is set by ExitPlanMode.",
    inputSchema: EnterPlanModeInput,
    shouldDefer: false,
    alwaysLoad: true,
    readonly: true,
    microCompactable: true,
    validateInput(input: unknown) {
      return EnterPlanModeInput.parse(input);
    },
    async call(_input, _ctx: ToolUseContext) {
      state.approved = false;
      state.approvedPlans = [];
      return { ok: true as const, output: { entered: true as const } };
    },
  };
}
