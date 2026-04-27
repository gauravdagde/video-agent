import { z } from "zod";
import type { Tool, ToolUseContext } from "../Tool.ts";

// Plan §C — INTERNAL_WORKER_TOOLS palette. The Orchestrator (coordinator-
// mode session) calls these instead of the standard editing palette.
//
// Phase-1 scope: these are the wiring; the actual worker spawning is
// done in-process by the orchestrator's loop (calls to spawnEditingAgent
// / spawnGenerationAgent). The tools here are the agent-visible API.

// --- TeamCreate ---------------------------------------------------------

const TeamCreateInput = z.object({
  worker_kind: z.enum([
    "editing_agent",
    "generation_agent",
    "compliance_agent",
  ]),
  brief_summary: z.string().min(1).max(2000),
  // Caller-provided id so subsequent SendMessage / TeamDelete can address it.
  worker_id: z.string().min(1).max(40),
});

interface TeamCreateOutput {
  readonly worker_id: string;
  readonly status: "spawned" | "queued";
}

export interface OrchestratorTeamRegistry {
  spawn(args: z.infer<typeof TeamCreateInput>): Promise<TeamCreateOutput>;
  send(workerId: string, message: string): Promise<{ delivered: boolean }>;
  destroy(workerId: string): Promise<{ status: "destroyed" | "unknown" }>;
}

// --- Tool factories — closure over the registry ------------------------

export function buildTeamCreateTool(
  registry: OrchestratorTeamRegistry,
): Tool<z.infer<typeof TeamCreateInput>, TeamCreateOutput> {
  return {
    name: "TeamCreate",
    description:
      "Spawn a worker agent. Use the returned worker_id to address it via " +
      "SendMessage or TeamDelete.",
    inputSchema: TeamCreateInput,
    shouldDefer: false,
    alwaysLoad: true,
    readonly: false,
    microCompactable: false,
    validateInput(input: unknown) {
      return TeamCreateInput.parse(input);
    },
    async call(input, _ctx: ToolUseContext) {
      try {
        return { ok: true as const, output: await registry.spawn(input) };
      } catch (e) {
        return {
          ok: false as const,
          error: (e as Error).message,
          retryable: false,
        };
      }
    },
  };
}

const TeamDeleteInput = z.object({
  worker_id: z.string(),
  reason: z.string().optional(),
});
interface TeamDeleteOutput {
  readonly status: "destroyed" | "unknown";
}

export function buildTeamDeleteTool(
  registry: OrchestratorTeamRegistry,
): Tool<z.infer<typeof TeamDeleteInput>, TeamDeleteOutput> {
  return {
    name: "TeamDelete",
    description: "Destroy a previously spawned worker. Idempotent.",
    inputSchema: TeamDeleteInput,
    shouldDefer: false,
    alwaysLoad: true,
    readonly: false,
    microCompactable: false,
    validateInput(input: unknown) {
      return TeamDeleteInput.parse(input);
    },
    async call(input, _ctx: ToolUseContext) {
      return {
        ok: true as const,
        output: await registry.destroy(input.worker_id),
      };
    },
  };
}

const SendMessageInput = z.object({
  worker_id: z.string(),
  message: z.string().min(1).max(4000),
});
interface SendMessageOutput {
  readonly delivered: boolean;
}

export function buildSendMessageTool(
  registry: OrchestratorTeamRegistry,
): Tool<z.infer<typeof SendMessageInput>, SendMessageOutput> {
  return {
    name: "SendMessage",
    description:
      "Send a coordination message to a spawned worker (e.g. plan approval).",
    inputSchema: SendMessageInput,
    shouldDefer: false,
    alwaysLoad: true,
    readonly: false,
    microCompactable: false,
    validateInput(input: unknown) {
      return SendMessageInput.parse(input);
    },
    async call(input, _ctx: ToolUseContext) {
      return {
        ok: true as const,
        output: await registry.send(input.worker_id, input.message),
      };
    },
  };
}

// --- SyntheticOutput ---------------------------------------------------

const SyntheticOutputInput = z.object({
  kind: z.enum(["status", "decision", "summary"]),
  payload: z.record(z.unknown()),
});

interface SyntheticOutputResult {
  readonly recorded: true;
}

// SyntheticOutput is the orchestrator's way to log a structured
// coordination decision without it being a real message to a worker.
// Used for audit + replay.
export function buildSyntheticOutputTool(
  recorder: (kind: string, payload: unknown) => Promise<void>,
): Tool<z.infer<typeof SyntheticOutputInput>, SyntheticOutputResult> {
  return {
    name: "SyntheticOutput",
    description:
      "Record a coordination decision for audit. Use sparingly — kinds: " +
      "status / decision / summary.",
    inputSchema: SyntheticOutputInput,
    shouldDefer: false,
    alwaysLoad: true,
    readonly: false,
    microCompactable: false,
    validateInput(input: unknown) {
      return SyntheticOutputInput.parse(input);
    },
    async call(input, _ctx: ToolUseContext) {
      await recorder(input.kind, input.payload);
      return { ok: true as const, output: { recorded: true as const } };
    },
  };
}
