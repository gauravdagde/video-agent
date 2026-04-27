import { editingAgentCompactStrategy } from "../compact/CompactStrategy.ts";
import { runAgentLoop, type RunResult } from "../agent/runAgentLoop.ts";
import { spawnEditingAgent, type SpawnResult } from "../agent/spawnEditingAgent.ts";
import { spawnGenerationAgent } from "../agents/generation/spawnGenerationAgent.ts";
import type { PermissionDecision } from "../permissions/canUseTool.ts";
import type { Tool } from "../Tool.ts";
import { newAgentId } from "../types/ids.ts";
import type {
  AssetId,
  BrandId,
  CampaignId,
} from "../types/video.ts";
import { buildOrchestratorContext } from "./buildOrchestratorContext.ts";
import {
  buildSendMessageTool,
  buildSyntheticOutputTool,
  buildTeamCreateTool,
  buildTeamDeleteTool,
  type OrchestratorTeamRegistry,
} from "./internalWorkerTools.ts";

// Plan §C / T5.1 — coordinator-mode session running on top of runAgentLoop
// with the INTERNAL_WORKER_TOOLS palette. Phase-1 in-process scope:
// "spawning a worker" calls spawnEditingAgent / spawnGenerationAgent
// directly. The team registry is the bridge.

export interface OrchestratorOpts {
  readonly brandId: BrandId;
  readonly campaignId: CampaignId;
  readonly sessionId: string;
  readonly initialMessage: string;
  // Optional: if the orchestrator already knows about an asset to edit,
  // pre-pass it. Otherwise the agent picks via TeamCreate.
  readonly defaultAssetId?: AssetId;
}

export interface OrchestratorResult {
  readonly run: RunResult;
  readonly spawnedWorkers: readonly {
    readonly worker_id: string;
    readonly kind: string;
    readonly result?: SpawnResult | { run: RunResult };
  }[];
}

const DEFAULT_MODEL = process.env.MODEL ?? "claude-opus-4-7";

class InProcessRegistry implements OrchestratorTeamRegistry {
  private spawned = new Map<
    string,
    { kind: string; result?: SpawnResult | { run: RunResult } }
  >();

  constructor(private opts: OrchestratorOpts) {}

  list(): readonly { worker_id: string; kind: string; result?: SpawnResult | { run: RunResult } }[] {
    return [...this.spawned.entries()].map(([k, v]) => ({
      worker_id: k,
      kind: v.kind,
      ...(v.result !== undefined ? { result: v.result } : {}),
    }));
  }

  async spawn(args: {
    worker_kind: "editing_agent" | "generation_agent" | "compliance_agent";
    brief_summary: string;
    worker_id: string;
  }): Promise<{ worker_id: string; status: "spawned" | "queued" }> {
    if (this.spawned.has(args.worker_id)) {
      return { worker_id: args.worker_id, status: "queued" };
    }
    this.spawned.set(args.worker_id, { kind: args.worker_kind });

    // Run the worker synchronously for Phase-1 simplicity. Real
    // coordinator-mode would spawn detached and use the swarm bus.
    if (args.worker_kind === "editing_agent") {
      if (this.opts.defaultAssetId === undefined) {
        // Without an asset id we can't edit. Record as queued; the leader
        // can SendMessage with more context (Phase 2).
        return { worker_id: args.worker_id, status: "queued" };
      }
      const result = await spawnEditingAgent({
        brandId: this.opts.brandId,
        campaignId: this.opts.campaignId,
        assetId: this.opts.defaultAssetId,
        extraInstructions: args.brief_summary,
      });
      this.spawned.set(args.worker_id, {
        kind: args.worker_kind,
        result,
      });
      return { worker_id: args.worker_id, status: "spawned" };
    }
    if (args.worker_kind === "generation_agent") {
      const result = await spawnGenerationAgent({
        brandId: this.opts.brandId,
        campaignId: this.opts.campaignId,
        creativeBrief: args.brief_summary,
      });
      this.spawned.set(args.worker_id, {
        kind: args.worker_kind,
        result,
      });
      return { worker_id: args.worker_id, status: "spawned" };
    }
    // compliance_agent — direct call already exists, no spawn semantic.
    return { worker_id: args.worker_id, status: "queued" };
  }

  async send(
    workerId: string,
    _message: string,
  ): Promise<{ delivered: boolean }> {
    return { delivered: this.spawned.has(workerId) };
  }

  async destroy(
    workerId: string,
  ): Promise<{ status: "destroyed" | "unknown" }> {
    if (!this.spawned.has(workerId)) return { status: "unknown" };
    this.spawned.delete(workerId);
    return { status: "destroyed" };
  }
}

export async function runOrchestratorLoop(
  opts: OrchestratorOpts,
): Promise<OrchestratorResult> {
  const orchestratorId = newAgentId("orchestrator");
  const abort = new AbortController();
  const registry = new InProcessRegistry(opts);

  // Phase-1: synthetic-output recorder is a no-op + console log. Production
  // would persist these for audit.
  const recordSynthetic = async (kind: string, payload: unknown): Promise<void> => {
    console.log(
      `[orchestrator/${orchestratorId}] ${kind}: ${JSON.stringify(payload).slice(0, 200)}`,
    );
  };

  const tools: readonly Tool[] = [
    buildTeamCreateTool(registry),
    buildTeamDeleteTool(registry),
    buildSendMessageTool(registry),
    buildSyntheticOutputTool(recordSynthetic),
  ];

  const systemBlocks = await buildOrchestratorContext(
    opts.brandId,
    opts.campaignId,
    opts.sessionId,
    [], // active task list — empty at start; filled by future spawns
  );

  // Coordinator mode auto-allows everything in its palette.
  const coordinatorAllowAll: typeof permissionAllowAll = async () =>
    ({ action: "allow", reason: "coordinator-mode: all worker tools allowed" }) satisfies PermissionDecision;
  async function permissionAllowAll(): Promise<PermissionDecision> {
    return { action: "allow", reason: "" };
  }

  const run = await runAgentLoop({
    model: DEFAULT_MODEL,
    systemBlocks,
    tools,
    initialMessage: opts.initialMessage,
    ctx: {
      agentId: orchestratorId,
      brandId: opts.brandId,
      campaignId: opts.campaignId,
      ...(opts.defaultAssetId !== undefined
        ? { assetId: opts.defaultAssetId }
        : {}),
      abortSignal: abort.signal,
    },
    canUseTool: coordinatorAllowAll,
    compactStrategy: editingAgentCompactStrategy,
    maxIterations: 30,
  });

  return {
    run,
    spawnedWorkers: registry.list(),
  };
}
