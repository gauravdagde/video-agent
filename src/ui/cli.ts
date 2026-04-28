import { agentActivity } from "./agentActivity.ts";

// Claude-Code-style CLI renderer. ANSI escape codes only — no `ink`,
// no `ora`, no `chalk`. Visual conventions:
//
//   ● VideoAnalyse(source_path: …)             ← bullet + tool + args
//     └ duration 30000ms · 1920×1080 · 30 fps  ← tree-prefix continuation
//
// While a tool is running:
//
//   ● VideoAnalyse(source_path: …)
//     └ running… (3.4s)                         ← live, replaced on success
//
// Between tool calls (model is generating its next turn):
//
//   ✻ Pondering… (12s · ↑ 1.2k / ↓ 0.4k tokens · turn 3)
//
// The "live line" sits at the bottom of the output buffer; \r + clear-EOL
// updates it in place each spinner tick. Completed events are written
// ABOVE the live line via printAbove() (clear, write+newline, redraw).

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

const SPINNER = ["✻", "✽", "✶", "✷", "✸", "✹"];
const BULLET = "●";
const CONT = "└";
const TICK = "✓";
const CROSS = "✗";

// Tool kinds for colouring. Read = cyan, write = yellow, render = magenta,
// control-plane (ToolSearch / ExitPlanMode / etc.) = grey.
const READ_TOOLS = new Set([
  "VideoAnalyse",
  "SceneDetect",
  "TranscriptExtract",
  "ExtractFrames",
  "DescribeScenes",
  "RichAnalysis",
  "OCR",
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

// Per-tool present-participle verbs shown in the live "└ <verb>… (Ns)"
// line while a tool is executing. Falls back to "running" for unknown
// names. Keep these short (≤ 4 words) so the line doesn't wrap.
const TOOL_VERBS: Record<string, string> = {
  VideoAnalyse: "probing source video",
  SceneDetect: "detecting scene boundaries",
  TranscriptExtract: "transcribing audio",
  DescribeScenes: "describing scenes",
  RichAnalysis: "analysing colour and motion",
  OCR: "reading on-screen text",
  ExtractFrames: "extracting frames",
  ToolSearch: "searching for tools",
  EnterPlanMode: "entering plan mode",
  ExitPlanMode: "submitting plans for approval",
  TrimClip: "trimming clip",
  OverlayAsset: "applying overlay",
  AdjustAudio: "adjusting audio",
  RenderVariant: "rendering variant",
  DeliverToAdPlatform: "delivering to ad platform",
  GenerateShot: "generating new shot",
};

function verbForTool(name: string): string {
  return TOOL_VERBS[name] ?? "running";
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
  toolSuccess(name: string, output?: unknown): void;
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

export function createCliRenderer(opts: {
  readonly stream?: NodeJS.WriteStream;
  // Chat-mode flag: skip the truncated text preview under each turn
  // header. The REPL prints the full assistant text after the turn ends,
  // and the preview would just duplicate the first ~200 chars.
  readonly quietPreview?: boolean;
} = {}): CliRenderer {
  const stream = opts.stream ?? process.stdout;
  const isTTY = stream.isTTY === true;
  const quietPreview = opts.quietPreview === true;

  // Spinner state. The "live line" is whatever is currently rendered at
  // the bottom of the terminal — either the per-tool "running…" line or
  // the between-turn "Pondering…" indicator.
  let spinnerFrame = 0;
  let spinnerTimer: Timer | null = null;
  let spinnerActive = false;
  let liveLine: string | null = null;
  // Set true while an external prompt (chat plan approver, slash command
  // dialog, …) owns stdin. While paused, the timer still fires but
  // renderLive is a no-op — readline's prompt stays intact instead of
  // getting overwritten by `└ running… (Ns)` every 120ms.
  let renderPaused = false;

  // Snapshot of agents we've already seen, keyed by id → label. Used so
  // we only announce NEW sub-agent forks (not the chat session's own
  // EditingAgent which was registered before the renderer started), and
  // so we can show the friendly label on unregister even after the
  // entry has been removed from the registry.
  const knownAgents = new Map<string, string>();
  for (const e of agentActivity.list()) knownAgents.set(e.id, e.label);

  // The currently-running tool call. We render its `└ running… (Ns)`
  // line in place each frame, then replace it with the result summary
  // when toolSuccess/toolError fires.
  let runningTool: { name: string; startedAt: number } | null = null;

  // Between-turn pondering state. Tracks elapsed + cumulative tokens for
  // the live status line.
  let ponderingStartedAt: number | null = null;
  let ponderingTurn = 0;
  let cumulativeIn = 0;
  let cumulativeOut = 0;

  const write = (s: string): void => {
    stream.write(s);
  };

  const renderLive = (): void => {
    if (!isTTY) return;
    // Don't draw anything while an external prompt owns stdin — we'd
    // overwrite their prompt every 120ms and they'd be stuck typing
    // into a moving target.
    if (renderPaused) return;
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
    if (isTTY) write(CLEAR_LINE);
    write(line + "\n");
    renderLive();
  };

  const formatAgentSummary = (): string => {
    const agents = agentActivity.list();
    if (agents.length === 0) return "";
    const count = agents.length;
    const primary = agents[0]!;
    // For 1 agent show "EditingAgent: drafting plans".
    // For 2+ agents show "2 agents · EditingAgent: drafting plans · +1".
    const head = `${BOLD}${primary.label}${RESET}${GREY}:${RESET} ${primary.activity}`;
    if (count === 1) return head;
    return `${count} agents ${GREY}·${RESET} ${head} ${GREY}· +${count - 1}${RESET}`;
  };

  const formatPondering = (): string => {
    const startedAt = ponderingStartedAt ?? Date.now();
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const inK = (cumulativeIn / 1000).toFixed(1);
    const outK = (cumulativeOut / 1000).toFixed(1);
    const tokens =
      cumulativeIn === 0 && cumulativeOut === 0
        ? ""
        : ` ${GREY}·${RESET} ${GREY}↑${RESET} ${inK}k ${GREY}/${RESET} ${GREY}↓${RESET} ${outK}k tokens`;
    const sym = SPINNER[spinnerFrame % SPINNER.length];
    const agentLine = formatAgentSummary();
    const stage = agentLine.length > 0 ? agentLine : `${BOLD}Pondering…${RESET}`;
    return `${MAGENTA}${sym}${RESET} ${stage} ${GREY}(${elapsed}s${RESET}${tokens}${GREY} · turn ${ponderingTurn})${RESET}`;
  };

  const formatToolRunning = (): string => {
    if (runningTool === null) return "";
    const elapsed = ((Date.now() - runningTool.startedAt) / 1000).toFixed(1);
    const verb = verbForTool(runningTool.name);
    return `  ${GREY}${CONT} ${verb}… (${elapsed}s)${RESET}`;
  };

  // Single timer; it picks which live line to render based on which
  // state is active (running tool > pondering > nothing).
  const tickLive = (): void => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
    if (runningTool !== null) {
      setLive(formatToolRunning());
    } else if (ponderingStartedAt !== null) {
      setLive(formatPondering());
    }
  };

  const ensureTimer = (): void => {
    if (!isTTY) return;
    if (spinnerTimer !== null) return;
    write(HIDE_CURSOR);
    spinnerActive = true;
    spinnerTimer = setInterval(tickLive, 120);
  };

  const stopTimer = (): void => {
    spinnerActive = false;
    if (spinnerTimer !== null) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    setLive(null);
    if (isTTY) write(SHOW_CURSOR);
  };

  // Subscribe to the agent registry — print a line above the live area
  // when a sub-agent forks or finishes. The chat session's main
  // EditingAgent is filtered out via knownAgentIds (it was registered
  // before this subscription).
  agentActivity.onChange(() => {
    const current = agentActivity.list();
    const currentIds = new Set(current.map((e) => e.id));
    for (const e of current) {
      if (!knownAgents.has(e.id)) {
        knownAgents.set(e.id, e.label);
        // Don't announce the chat session's own EditingAgent — it's the
        // "main" agent and the banner already implies its presence.
        // Only sub-agents (compliance, generation, generic subagent) get
        // the inline ↳ fork line.
        if (e.kind !== "editing") {
          printAbove(
            `${BLUE}↳${RESET} ${BOLD}${e.label}${RESET} ${GREY}forked (${e.id.slice(0, 12)}…)${RESET}`,
          );
        }
      }
    }
    for (const [id, label] of [...knownAgents]) {
      if (!currentIds.has(id)) {
        knownAgents.delete(id);
        if (!id.startsWith("aediting-")) {
          printAbove(
            `${BLUE}↳${RESET} ${BOLD}${label}${RESET} ${GREY}finished${RESET}`,
          );
        }
      }
    }
  });

  return {
    banner(title, subtitle) {
      printAbove(`${BOLD}${title}${RESET}`);
      if (subtitle !== undefined) {
        printAbove(`${GREY}${subtitle}${RESET}`);
      }
      printAbove("");
    },

    turnStart(turn) {
      ponderingStartedAt = Date.now();
      ponderingTurn = turn;
      runningTool = null;
      ensureTimer();
    },

    turnEnd(turn, info) {
      cumulativeIn += info.inputTokens;
      cumulativeOut += info.outputTokens;
      ponderingStartedAt = null;
      // If a tool is running, keep the timer alive — it'll be stopped
      // when toolSuccess/toolError fires.
      if (runningTool === null) stopTimer();

      // In chat mode (quietPreview) we omit the per-turn header — the
      // REPL prints a single message-level footer after the assistant's
      // reply instead. One-shot mode still shows it.
      if (!quietPreview) {
        const cacheNote =
          info.cacheReadTokens > 0
            ? ` ${GREY}·${RESET} ${GREEN}${info.cacheReadTokens} cached${RESET}`
            : "";
        const counts = `${info.toolCallCount} tool call${info.toolCallCount === 1 ? "" : "s"}`;
        const turnLine =
          `${GREY}turn ${turn} · ${counts} · ` +
          `${info.inputTokens} in / ${info.outputTokens} out${RESET}` +
          cacheNote;
        printAbove(turnLine);

        const preview = info.textPreview.trim();
        if (preview.length > 0) {
          for (const line of preview.split("\n").slice(0, 3)) {
            printAbove(`  ${DIM}${line}${RESET}`);
          }
        }
      }
    },

    toolCall(name, input) {
      // Stop the pondering timer (we'll restart it when the tool ends).
      ponderingStartedAt = null;
      const colour = colourForTool(name);
      const argsBlurb = summariseInput(input);
      const header = `${colour}${BULLET}${RESET} ${BOLD}${name}${RESET}${argsBlurb}`;
      printAbove(header);
      runningTool = { name, startedAt: Date.now() };
      ensureTimer();
    },

    toolSuccess(name, output) {
      if (runningTool !== null && runningTool.name === name) {
        const ms = Date.now() - runningTool.startedAt;
        runningTool = null;
        const summary = summariseOutput(name, output);
        const detail =
          summary.length > 0 ? `${summary} ${GREY}(${ms}ms)${RESET}` : `${GREEN}${TICK}${RESET} ${GREY}(${ms}ms)${RESET}`;
        printAbove(`  ${GREY}${CONT}${RESET} ${detail}`);
      } else {
        // Fallback path: toolSuccess fired without a matching toolCall
        // (the analyse-mode CLI calls these directly).
        const summary = summariseOutput(name, output);
        const line =
          summary.length > 0
            ? `  ${GREY}${CONT}${RESET} ${summary}`
            : `  ${GREEN}${TICK}${RESET} ${GREY}${name}${RESET}`;
        printAbove(line);
      }
      // If we just finished a tool but the model hasn't returned yet,
      // resume the pondering indicator so the bottom line stays alive.
      if (runningTool === null && ponderingStartedAt === null) {
        // Don't auto-resume here — turnEnd is already past, and the
        // next turnStart will start a fresh pondering line. Simply stop.
        if (spinnerActive) stopTimer();
      }
    },

    toolError(name, error) {
      const ms =
        runningTool !== null && runningTool.name === name
          ? Date.now() - runningTool.startedAt
          : 0;
      runningTool = null;
      const truncated = error.length > 200 ? error.slice(0, 200) + "…" : error;
      const detail = `${RED}${CROSS} ${truncated}${RESET}` +
        (ms > 0 ? ` ${GREY}(${ms}ms)${RESET}` : "");
      printAbove(`  ${GREY}${CONT}${RESET} ${detail}`);
      if (spinnerActive && ponderingStartedAt === null) stopTimer();
    },

    info(line) {
      printAbove(`${BLUE}${BULLET}${RESET} ${line}`);
    },

    warn(line) {
      printAbove(`${YELLOW}${BULLET}${RESET} ${line}`);
    },

    finish(summary) {
      stopTimer();
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
      stopTimer();
      printAbove("");
      printAbove(`${RED}${CROSS} ${BOLD}Failed${RESET}: ${RED}${error.message}${RESET}`);
    },

    detachSpinner() {
      // Pause renderLive so the spinner timer stops overwriting whatever
      // takes ownership of the cursor next (e.g. a chat-mode approval
      // prompt). The timer keeps ticking; we just stop drawing.
      renderPaused = true;
      if (isTTY) write(CLEAR_LINE);
    },

    attachSpinner() {
      renderPaused = false;
      if (spinnerActive) renderLive();
    },
  };
}

// Compact one-line summary of a tool's input. Shows the 1-3 most useful
// fields rather than the full JSON, which would line-wrap and obscure
// the bullet structure.
function summariseInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "object") {
    return ` ${GREY}(${truncate(String(input), 60)})${RESET}`;
  }
  const o = input as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 0) return "";
  const interesting = keys
    .slice(0, 3)
    .map((k) => `${k}: ${truncate(formatValue(o[k]), 30)}`)
    .join(", ");
  return ` ${GREY}(${interesting})${RESET}`;
}

// Per-tool one-line result summary. Pulls the load-bearing fields out
// of each tool's output so the user doesn't have to mentally parse JSON
// to know what happened. Falls back to "ok" when the tool isn't known.
function summariseOutput(name: string, output: unknown): string {
  if (output === null || output === undefined) return "";
  const o =
    typeof output === "object" ? (output as Record<string, unknown>) : null;
  switch (name) {
    case "VideoAnalyse": {
      if (o === null) break;
      const dur = o.duration_ms;
      const res = o.resolution as { width?: number; height?: number } | undefined;
      const fps = o.frame_rate;
      const audio = o.has_audio === true ? "audio" : "no audio";
      return [
        dur !== undefined ? `${ms(dur as number)}` : null,
        res !== undefined && res.width !== undefined
          ? `${res.width}×${res.height}`
          : null,
        fps !== undefined ? `${fps} fps` : null,
        audio,
      ]
        .filter((x): x is string => x !== null)
        .join(GREY + " · " + RESET);
    }
    case "SceneDetect": {
      if (o === null) break;
      const scenes = o.scenes as unknown[] | undefined;
      if (Array.isArray(scenes)) return `${scenes.length} scenes`;
      break;
    }
    case "TranscriptExtract": {
      if (o === null) break;
      const words = o.words as unknown[] | undefined;
      if (Array.isArray(words)) return `${words.length} words`;
      break;
    }
    case "DescribeScenes": {
      if (o === null) break;
      const d = o.descriptions as unknown[] | undefined;
      if (Array.isArray(d)) return `${d.length} scenes described`;
      break;
    }
    case "ExtractFrames": {
      if (o === null) break;
      const f = o.frames as unknown[] | undefined;
      if (Array.isArray(f)) return `${f.length} frames`;
      break;
    }
    case "TrimClip": {
      if (o === null) break;
      const out = o.output_path as string | undefined;
      if (typeof out === "string") return `→ ${shortPath(out)}`;
      break;
    }
    case "OverlayAsset": {
      if (o === null) break;
      const out = o.output_path as string | undefined;
      if (typeof out === "string") return `→ ${shortPath(out)}`;
      break;
    }
    case "AdjustAudio": {
      if (o === null) break;
      const out = o.output_path as string | undefined;
      if (typeof out === "string") return `→ ${shortPath(out)}`;
      break;
    }
    case "RenderVariant": {
      if (o === null) break;
      const id = o.variant_spec_id as string | undefined;
      const dur = o.duration_ms as number | undefined;
      const size = o.size_bytes as number | undefined;
      const out = o.output_path as string | undefined;
      const parts: string[] = [];
      if (id !== undefined) parts.push(id);
      if (dur !== undefined) parts.push(ms(dur));
      if (size !== undefined) parts.push(bytes(size));
      if (out !== undefined) parts.push(`→ ${shortPath(out)}`);
      return parts.join(GREY + " · " + RESET);
    }
    case "ToolSearch": {
      if (o === null) break;
      const m = o.matches as unknown[] | undefined;
      if (Array.isArray(m)) {
        const names = m
          .map((x) => (x as { name?: string }).name)
          .filter((n): n is string => typeof n === "string")
          .slice(0, 5)
          .join(", ");
        return `${m.length} match${m.length === 1 ? "" : "es"}` +
          (names.length > 0 ? `${GREY} · ${names}${RESET}` : "");
      }
      break;
    }
    case "EnterPlanMode":
      return `${BOLD}plan mode${RESET}`;
    case "ExitPlanMode": {
      if (o === null) break;
      const ok = o.approved === true;
      const n = o.approved_plan_count as number | undefined;
      if (ok) return `${GREEN}approved${RESET} ${n ?? ""} plan${n === 1 ? "" : "s"}`.trim();
      return `${YELLOW}declined${RESET}`;
    }
    case "DeliverToAdPlatform": {
      if (o === null) break;
      const platform = o.platform as string | undefined;
      const ok = o.delivered === true;
      return ok
        ? `${GREEN}delivered${RESET}${platform !== undefined ? ` to ${platform}` : ""}`
        : `${YELLOW}not delivered${RESET}`;
    }
  }
  return ""; // Unknown — caller falls back to a tick.
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

function ms(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds}ms`;
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function bytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

// Replace ~/ for home and shorten very-long paths from the middle.
function shortPath(p: string): string {
  let out = p;
  const home = process.env.HOME;
  if (home !== undefined && p.startsWith(home)) {
    out = "~" + p.slice(home.length);
  }
  if (out.length > 64) {
    const head = out.slice(0, 30);
    const tail = out.slice(-30);
    return `${head}…${tail}`;
  }
  return out;
}
