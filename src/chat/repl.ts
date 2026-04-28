import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import type { Conversation, TurnResult } from "./Conversation.ts";
import type { CliRenderer } from "../ui/cli.ts";

// Chat-mode REPL. Reads one line at a time, dispatches slash commands or
// forwards to Conversation.sendUserMessage. Coexists with CliRenderer's
// spinner via a strict rule: spinner is never active while readline owns
// the prompt (rl.pause() before sendUserMessage, rl.resume() after).

const ANSI = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  reset: "\x1b[0m",
} as const;

const PROMPT = `${ANSI.cyan}❯${ANSI.reset} `;
const RESPONSE_BULLET = `${ANSI.magenta}⏺${ANSI.reset}`;
const DOUBLE_INTERRUPT_MS = 2000;
const SEPARATOR_WIDTH = 60;

export interface ReplOpts {
  readonly conversation: Conversation;
  readonly ui?: CliRenderer;
  readonly stream?: NodeJS.WriteStream;
  readonly stdin?: NodeJS.ReadableStream;
  readonly backendLabel?: string;
  readonly brandId: string;
  readonly campaignId: string;
  readonly assetId?: string;
}

export async function runRepl(opts: ReplOpts): Promise<void> {
  const out = opts.stream ?? process.stdout;
  const stdin = opts.stdin ?? process.stdin;

  printBanner(out, opts);

  const rl = readline.createInterface({ input: stdin, output: out });

  // Track whether a turn is currently in flight + the time of the last
  // SIGINT so a double-press can hard-exit out of a hanging turn.
  let turnInFlight = false;
  let lastSigintAt = 0;

  const sigintHandler = () => {
    const now = Date.now();
    if (turnInFlight) {
      if (now - lastSigintAt < DOUBLE_INTERRUPT_MS) {
        out.write(`\n${ANSI.red}Forcing exit.${ANSI.reset}\n`);
        process.exit(130);
      }
      lastSigintAt = now;
      opts.conversation.cancel();
      out.write(
        `\n${ANSI.yellow}Interrupting turn… (Ctrl-C again to force-exit)${ANSI.reset}\n`,
      );
      return;
    }
    // At the prompt — graceful exit.
    out.write(`\n${ANSI.dim}bye.${ANSI.reset}\n`);
    rl.close();
    process.exit(0);
  };
  process.on("SIGINT", sigintHandler);

  try {
    while (true) {
      let line: string;
      try {
        line = await rl.question(PROMPT);
      } catch {
        // readline rejected (rl.close called externally) — exit cleanly.
        break;
      }

      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      if (trimmed.startsWith("/")) {
        const action = handleSlashCommand(trimmed, out, opts);
        if (action === "exit") break;
        continue;
      }

      const expanded = expandAtPaths(trimmed, out);

      turnInFlight = true;
      rl.pause();
      let result: TurnResult;
      try {
        result = await opts.conversation.sendUserMessage(expanded);
      } catch (e) {
        out.write(
          `\n${ANSI.red}Error:${ANSI.reset} ${(e as Error).message}\n`,
        );
        turnInFlight = false;
        rl.resume();
        continue;
      }
      turnInFlight = false;

      if (result.aborted) {
        out.write(`\n${ANSI.yellow}Interrupted.${ANSI.reset}\n`);
      } else if (result.finalText.length > 0) {
        out.write("\n");
        out.write(`${RESPONSE_BULLET} ${formatAssistantText(result.finalText)}\n`);
      }
      if (result.persisted !== undefined) {
        out.write(
          `  ${ANSI.dim}saved → ${result.persisted.batchFile}${ANSI.reset}\n`,
        );
      }

      out.write("\n");
      rl.resume();
    }
  } finally {
    process.off("SIGINT", sigintHandler);
    rl.close();
  }
}

type SlashAction = "continue" | "exit";

function handleSlashCommand(
  line: string,
  out: NodeJS.WriteStream,
  opts: ReplOpts,
): SlashAction {
  const cmd = line.split(/\s+/, 1)[0]!.slice(1).toLowerCase();
  switch (cmd) {
    case "exit":
    case "quit":
      out.write(`${ANSI.dim}bye.${ANSI.reset}\n`);
      return "exit";
    case "clear": {
      opts.conversation.reset();
      out.write(`${ANSI.dim}session cleared.${ANSI.reset}\n`);
      return "continue";
    }
    case "help":
      printHelp(out, opts);
      return "continue";
    default:
      out.write(
        `${ANSI.yellow}unknown command:${ANSI.reset} /${cmd}  ` +
          `${ANSI.dim}(try /help)${ANSI.reset}\n`,
      );
      return "continue";
  }
}

// Replace `@/abs`, `@~/foo`, `@./bar` with absolute paths. Anything else
// containing @ (emails, @everyone, etc.) passes through untouched.
export function expandAtPaths(
  text: string,
  out?: NodeJS.WriteStream,
): string {
  // Match @ followed by /, ~/, ./ — boundary is whitespace or end.
  const re = /(^|\s)@(\/[^\s]*|~\/[^\s]*|\.\/[^\s]*)/g;
  return text.replace(re, (_match, lead: string, raw: string) => {
    let abs: string;
    if (raw.startsWith("~/")) {
      abs = path.join(os.homedir(), raw.slice(2));
    } else if (raw.startsWith("./")) {
      abs = path.resolve(process.cwd(), raw);
    } else {
      abs = raw;
    }
    if (out !== undefined && !existsSync(abs)) {
      out.write(
        `${ANSI.dim}note: ${abs} does not exist (passing to model anyway)${ANSI.reset}\n`,
      );
    }
    return `${lead}${abs}`;
  });
}

function printBanner(out: NodeJS.WriteStream, opts: ReplOpts): void {
  const sep = "─".repeat(SEPARATOR_WIDTH);
  const ctxLine =
    `${ANSI.dim}backend${ANSI.reset} ${opts.backendLabel ?? "claude"}  ` +
    `${ANSI.dim}·${ANSI.reset}  ${ANSI.dim}brand${ANSI.reset} ${opts.brandId}  ` +
    `${ANSI.dim}·${ANSI.reset}  ${ANSI.dim}campaign${ANSI.reset} ${opts.campaignId}` +
    (opts.assetId !== undefined
      ? `  ${ANSI.dim}·${ANSI.reset}  ${ANSI.dim}asset${ANSI.reset} ${opts.assetId}`
      : "");
  out.write("\n");
  out.write(`${ANSI.dim}${sep}${ANSI.reset}\n`);
  out.write(`${ANSI.bold}${ANSI.cyan}✻ video-agent${ANSI.reset}  ${ANSI.dim}chat mode${ANSI.reset}\n`);
  out.write(`${ctxLine}\n`);
  out.write(`${ANSI.dim}${sep}${ANSI.reset}\n`);
  out.write(
    `${ANSI.dim}/help for commands  ·  @path to reference files  ·  ctrl-c to interrupt  ·  /exit to quit${ANSI.reset}\n`,
  );
  out.write("\n");
}

// Indent continuation lines two spaces so multi-line assistant text
// aligns with the leading `⏺` bullet on line one.
function formatAssistantText(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= 1) return text;
  return lines
    .map((l, i) => (i === 0 ? l : `  ${l}`))
    .join("\n");
}

function printHelp(out: NodeJS.WriteStream, opts: ReplOpts): void {
  const snap = opts.conversation.snapshot();
  const lines = [
    "",
    `${ANSI.bold}commands${ANSI.reset}`,
    `  ${ANSI.cyan}/exit${ANSI.reset}    end the session`,
    `  ${ANSI.cyan}/clear${ANSI.reset}   reset conversation (keeps brand/campaign/asset)`,
    `  ${ANSI.cyan}/help${ANSI.reset}    this`,
    "",
    `${ANSI.bold}references${ANSI.reset}`,
    `  ${ANSI.cyan}@/abs/path${ANSI.reset} or ${ANSI.cyan}@~/foo${ANSI.reset} or ${ANSI.cyan}@./bar${ANSI.reset} — expanded inline`,
    "",
    `${ANSI.bold}session${ANSI.reset}`,
    `  ${ANSI.dim}backend:${ANSI.reset} ${opts.backendLabel ?? "claude"}`,
    `  ${ANSI.dim}brand/campaign:${ANSI.reset} ${opts.brandId} / ${opts.campaignId}` +
      (opts.assetId !== undefined ? ` / asset ${opts.assetId}` : ""),
    `  ${ANSI.dim}messages:${ANSI.reset} ${snap.messages}  ` +
      `${ANSI.dim}tool calls:${ANSI.reset} ${snap.toolCalls}  ` +
      `${ANSI.dim}plans:${ANSI.reset} ${snap.approvedPlans}  ` +
      `${ANSI.dim}variants:${ANSI.reset} ${snap.renderedVariants}`,
    `  ${ANSI.dim}tokens:${ANSI.reset} in=${snap.tokens.input} out=${snap.tokens.output} ` +
      `cache_r=${snap.tokens.cacheRead} cache_w=${snap.tokens.cacheCreation}`,
    "",
  ];
  for (const l of lines) out.write(l + "\n");
}
