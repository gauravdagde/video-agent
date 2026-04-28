import readline from "node:readline/promises";
import type { EditPlanSubmission, PlanApprover } from "../agent/loopTools.ts";
import type { CliRenderer } from "../ui/cli.ts";

// User-facing PlanApprover for chat mode. Renders a plan summary, asks
// y/n at the prompt, returns approval. Pauses the CliRenderer spinner
// around the prompt so the live "thinking" line doesn't trample the
// question.
//
// We open a transient readline interface for the question rather than
// reusing the REPL's main one — readline.question consumes one line then
// relinquishes stdin cleanly, and isolating the I/O here means the
// approver doesn't need to know anything about the REPL's lifecycle.

const ANSI = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  reset: "\x1b[0m",
} as const;

export interface ChatApproverOpts {
  readonly ui?: CliRenderer;
  readonly stream?: NodeJS.WriteStream;
  readonly stdin?: NodeJS.ReadableStream;
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

      const rl = readline.createInterface({ input: stdin, output: out });
      let answer: string;
      try {
        answer = await rl.question(
          `${ANSI.bold}Approve and render?${ANSI.reset} [y/N] `,
        );
      } finally {
        rl.close();
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
