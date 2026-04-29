import readline from "node:readline/promises";
import type { EditPlanSubmission, PlanApprover } from "../agent/loopTools.ts";
import type { CliRenderer } from "../ui/cli.ts";

// User-facing PlanApprover for chat mode. Renders a plan summary, asks
// y/N at the prompt, returns approval.
//
// Single-readline rule: there can only be ONE readline.Interface bound
// to stdin at a time, otherwise rl.question races with the REPL's main
// readline and resolves immediately with empty input. The fix is the
// `bridge` pattern — the REPL passes its own rl into this approver via
// a shared mutable holder, and we call rl.question on it directly.
// When no bridge rl is available (tests, or unusual host environments),
// fall back to creating a fresh readline interface for the prompt.

const ANSI = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  reset: "\x1b[0m",
} as const;

// A mutable holder that lets repl.ts share its readline with the
// approver. The approver is created in main.ts BEFORE repl.ts owns
// stdin, so we can't pass the rl directly into the approver's
// constructor. Instead we hand both sides the same bridge object and
// repl.ts populates `rl` once it has it.
export interface ApproverBridge {
  rl: readline.Interface | null;
}

export function createApproverBridge(): ApproverBridge {
  return { rl: null };
}

export interface ChatApproverOpts {
  readonly ui?: CliRenderer;
  readonly stream?: NodeJS.WriteStream;
  readonly stdin?: NodeJS.ReadableStream;
  readonly bridge?: ApproverBridge;
}

export function createChatPlanApprover(
  opts: ChatApproverOpts = {},
): PlanApprover {
  const out = opts.stream ?? process.stdout;
  const stdin = opts.stdin ?? process.stdin;

  return async (
    plans: readonly EditPlanSubmission[],
    rationale: string | undefined,
  ) => {
    opts.ui?.detachSpinner();
    try {
      out.write("\n");
      out.write(`${ANSI.bold}${ANSI.cyan}Plan submitted${ANSI.reset}\n`);
      out.write(renderSummary(plans, rationale));
      out.write("\n");

      const sharedRl = opts.bridge?.rl ?? null;
      let answer: string;
      if (sharedRl !== null) {
        // Reuse the REPL's readline. No close — the REPL owns its
        // lifecycle, we're just borrowing it for one question.
        answer = await sharedRl.question(
          `${ANSI.bold}Approve and render?${ANSI.reset} [y/N] `,
        );
      } else {
        const rl = readline.createInterface({ input: stdin, output: out });
        try {
          answer = await rl.question(
            `${ANSI.bold}Approve and render?${ANSI.reset} [y/N] `,
          );
        } finally {
          rl.close();
        }
      }

      const a = answer.trim().toLowerCase();
      if (a === "y" || a === "yes") {
        return { approved: true };
      }
      return {
        approved: false,
        reason:
          a.length > 0 && a !== "n" && a !== "no"
            ? `user rejected: ${answer.trim()}`
            : "user declined",
      };
    } finally {
      opts.ui?.attachSpinner();
    }
  };
}

function renderSummary(
  plans: readonly EditPlanSubmission[],
  rationale: string | undefined,
): string {
  const lines: string[] = [];
  lines.push(`  ${plans.length} plan${plans.length === 1 ? "" : "s"}:`);
  for (const [i, p] of plans.entries()) {
    const dur = (p.estimated_duration_ms / 1000).toFixed(1);
    lines.push(
      `    ${i + 1}. ${p.variant_spec_id}  ${ANSI.dim}` +
        `(${p.scenes.length} scenes, ${p.overlays.length} overlays, ` +
        `${dur}s, audio=${p.audio.source})${ANSI.reset}`,
    );
  }
  if (rationale !== undefined && rationale.length > 0) {
    lines.push(`  ${ANSI.dim}rationale:${ANSI.reset} ${truncate(rationale, 240)}`);
  }
  return lines.join("\n") + "\n";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
