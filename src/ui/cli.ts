// Minimal Claude-Code-style CLI renderer. ANSI escape codes only — no
// `ink`, no `ora`, no `chalk`. Goals:
//   - Live spinner while the model is "thinking" (between API call start
//     and response).
//   - Per-tool-call line: "→ ToolName(args summary)" then "✓ in N ms" or "✗ error".
//   - Per-turn header: "Turn 3 — 2 tool calls, 4234 in / 312 out tokens".
//   - Final summary block.
//
// Single-line interactive updates use \r + \x1B[K (clear-to-EOL). Once a
// line is "committed" (succeed/fail/info), it gets a newline and stays.

const ESC = "\x1B[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RED = `${ESC}31m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const BLUE = `${ESC}34m`;
const MAGENTA = `${ESC}35m`;
const CYAN = `${ESC}36m`;
const GREY = `${ESC}90m`;
const CLEAR_LINE = `\r${ESC}K`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK = "✓";
const CROSS = "✗";
const ARROW = "→";

// Tool kinds for colouring. Read = cyan, write = yellow, render = magenta,
// control-plane (ToolSearch / ExitPlanMode / etc.) = grey.
const READ_TOOLS = new Set([
  "VideoAnalyse",
  "SceneDetect",
  "TranscriptExtract",
  "ExtractFrames",
]);
const RENDER_TOOLS = new Set([
  "RenderVariant",
  "GenerateShot",
  "DeliverToAdPlatform",
]);
const CONTROL_TOOLS = new Set([
  "ToolSearch",
  "EnterPlanMode",
  "ExitPlanMode",
]);

function colourForTool(name: string): string {
  if (READ_TOOLS.has(name)) return CYAN;
  if (RENDER_TOOLS.has(name)) return MAGENTA;
  if (CONTROL_TOOLS.has(name)) return GREY;
  return YELLOW; // editing tools (TrimClip, OverlayAsset, AdjustAudio)
}

export interface CliRenderer {
  banner(title: string, subtitle?: string): void;
  turnStart(turn: number): void;
  turnEnd(
    turn: number,
    info: {
      readonly stopReason: string | null;
      readonly textPreview: string;
      readonly toolCallCount: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens: number;
    },
  ): void;
  toolCall(name: string, input: unknown): void;
  toolSuccess(name: string): void;
  toolError(name: string, error: string): void;
  info(line: string): void;
  warn(line: string): void;
  finish(summary: FinalSummary): void;
  fail(error: Error): void;
  // For external code that wants to print without messing with the spinner.
  detachSpinner(): void;
  attachSpinner(): void;
}

export interface FinalSummary {
  readonly agentId: string;
  readonly status: string;
  readonly iterations: number;
  readonly elapsedMs: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheCreation: number;
  };
  readonly toolCallsByName: Readonly<Record<string, number>>;
  readonly extras?: Readonly<Record<string, string | number>>;
}

export function createCliRenderer(opts: { stream?: NodeJS.WriteStream } = {}): CliRenderer {
  const stream = opts.stream ?? process.stdout;
  const isTTY = stream.isTTY === true;
  let spinnerFrame = 0;
  let spinnerTimer: Timer | null = null;
  let spinnerActive = false;
  let spinnerLabel = "";
  let turnStartedAt = 0;
  // Track open tool-call lines so we can update them in place.
  const openToolCalls = new Map<string, { startedAt: number; line: string }>();
  // Currently displayed live line at the bottom of the output.
  let liveLine: string | null = null;

  const write = (s: string): void => {
    stream.write(s);
  };

  const renderLive = (): void => {
    if (!isTTY) return;
    if (liveLine === null) {
      write(CLEAR_LINE);
      return;
    }
    write(`${CLEAR_LINE}${liveLine}`);
  };

  const setLive = (line: string | null): void => {
    liveLine = line;
    renderLive();
  };

  const printAbove = (line: string): void => {
    // Clear the live line, print our message, then redraw the live line.
    if (isTTY) write(CLEAR_LINE);
    write(line + "\n");
    renderLive();
  };

  const startSpinner = (label: string): void => {
    spinnerLabel = label;
    spinnerActive = true;
    if (!isTTY) {
      // Non-TTY: just print the label once, no animation.
      write(`  ${label}\n`);
      return;
    }
    write(HIDE_CURSOR);
    if (spinnerTimer === null) {
      spinnerTimer = setInterval(() => {
        if (!spinnerActive) return;
        spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
        const elapsed = ((Date.now() - turnStartedAt) / 1000).toFixed(1);
        setLive(
          `${CYAN}${SPINNER[spinnerFrame]}${RESET} ${spinnerLabel} ${GREY}(${elapsed}s)${RESET}`,
        );
      }, 80);
    }
  };

  const stopSpinner = (): void => {
    spinnerActive = false;
    if (spinnerTimer !== null) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    setLive(null);
    if (isTTY) write(SHOW_CURSOR);
  };

  return {
    banner(title, subtitle) {
      const top = `${BOLD}${title}${RESET}`;
      printAbove(top);
      if (subtitle !== undefined) {
        printAbove(`${GREY}${subtitle}${RESET}`);
      }
      printAbove("");
    },

    turnStart(turn) {
      turnStartedAt = Date.now();
      startSpinner(`Turn ${turn}: thinking…`);
    },

    turnEnd(turn, info) {
      stopSpinner();
      const elapsed = ((Date.now() - turnStartedAt) / 1000).toFixed(1);
      const cacheNote =
        info.cacheReadTokens > 0
          ? `, ${GREEN}${info.cacheReadTokens}${RESET} cached`
          : "";
      const turnLine =
        `${BOLD}Turn ${turn}${RESET} ` +
        `${GREY}— ${info.toolCallCount} tool call${info.toolCallCount === 1 ? "" : "s"}, ` +
        `${info.inputTokens} in / ${info.outputTokens} out${cacheNote}, ` +
        `${elapsed}s${RESET}`;
      printAbove(turnLine);
      // Print the model's text preview indented under the turn header.
      const preview = info.textPreview.trim();
      if (preview.length > 0) {
        for (const line of preview.split("\n").slice(0, 3)) {
          printAbove(`  ${DIM}${line}${RESET}`);
        }
      }
    },

    toolCall(name, input) {
      const colour = colourForTool(name);
      const summary = summariseInput(input);
      const startedAt = Date.now();
      const line = `  ${colour}${ARROW} ${name}${RESET}${summary}`;
      openToolCalls.set(name + ":" + startedAt, { startedAt, line });
      printAbove(line);
      // Spinner for the tool call itself.
      turnStartedAt = startedAt;
      startSpinner(`${name} running…`);
    },

    toolSuccess(name) {
      stopSpinner();
      // Find the most recent open call with this name.
      let matchedKey: string | null = null;
      let bestTime = -1;
      for (const [k, v] of openToolCalls) {
        if (k.startsWith(name + ":") && v.startedAt > bestTime) {
          matchedKey = k;
          bestTime = v.startedAt;
        }
      }
      if (matchedKey !== null) openToolCalls.delete(matchedKey);
      const ms = bestTime > 0 ? Date.now() - bestTime : 0;
      const colour = colourForTool(name);
      printAbove(
        `  ${GREEN}${TICK}${RESET} ${colour}${name}${RESET} ${GREY}(${ms}ms)${RESET}`,
      );
    },

    toolError(name, error) {
      stopSpinner();
      let matchedKey: string | null = null;
      let bestTime = -1;
      for (const [k, v] of openToolCalls) {
        if (k.startsWith(name + ":") && v.startedAt > bestTime) {
          matchedKey = k;
          bestTime = v.startedAt;
        }
      }
      if (matchedKey !== null) openToolCalls.delete(matchedKey);
      const truncated = error.length > 200 ? error.slice(0, 200) + "…" : error;
      printAbove(`  ${RED}${CROSS} ${name}${RESET} ${RED}${truncated}${RESET}`);
    },

    info(line) {
      printAbove(`  ${BLUE}${ARROW}${RESET} ${line}`);
    },

    warn(line) {
      printAbove(`  ${YELLOW}!${RESET} ${line}`);
    },

    finish(summary) {
      stopSpinner();
      const elapsedSec = (summary.elapsedMs / 1000).toFixed(1);
      const status =
        summary.status === "succeeded" ? `${GREEN}${summary.status}${RESET}` :
        summary.status === "failed"    ? `${RED}${summary.status}${RESET}` :
                                          `${YELLOW}${summary.status}${RESET}`;
      printAbove("");
      printAbove(`${BOLD}${GREEN}${TICK} Done in ${elapsedSec}s${RESET}`);
      printAbove("");
      const rows: [string, string][] = [
        ["AgentId", summary.agentId],
        ["Status", status],
        ["Iterations", String(summary.iterations)],
        [
          "Tokens",
          `input=${summary.tokens.input} output=${summary.tokens.output} ` +
          `cache_read=${summary.tokens.cacheRead} cache_creation=${summary.tokens.cacheCreation}`,
        ],
        [
          "Tool calls",
          Object.entries(summary.toolCallsByName)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ") || "(none)",
        ],
      ];
      for (const [k, v] of Object.entries(summary.extras ?? {})) {
        rows.push([k, String(v)]);
      }
      const labelWidth = Math.max(...rows.map(([k]) => k.length));
      for (const [k, v] of rows) {
        printAbove(`  ${BOLD}${k.padEnd(labelWidth)}${RESET}  ${v}`);
      }
    },

    fail(error) {
      stopSpinner();
      printAbove("");
      printAbove(`${RED}${CROSS} ${BOLD}Failed${RESET}: ${RED}${error.message}${RESET}`);
    },

    detachSpinner() {
      if (spinnerActive) {
        if (isTTY) write(CLEAR_LINE);
      }
    },

    attachSpinner() {
      if (spinnerActive) renderLive();
    },
  };
}

function summariseInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "object") {
    return ` ${GREY}${truncate(String(input), 60)}${RESET}`;
  }
  const o = input as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 0) return "";
  // Pick a few interesting fields to surface in the line.
  const interesting = keys
    .slice(0, 3)
    .map((k) => `${k}=${truncate(formatValue(o[k]), 30)}`)
    .join(", ");
  return ` ${GREY}(${interesting})${RESET}`;
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  if (v === null) return "null";
  if (typeof v === "object") return "{…}";
  return String(v);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
