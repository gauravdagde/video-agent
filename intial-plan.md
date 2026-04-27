Technical Architecture v3
A phased build plan grounded in Claude Code's agentic patterns. Greenfield. Four phases. One closed loop.
Changelog from v2. v2 was cross-checked, claim by claim, against the actual Claude Code source. Out of 23 named patterns, 23 exist and are correctly attributed; constants verify exactly (MAX_RECENT_ACTIVITIES = 5 in tasks/LocalAgentTask/LocalAgentTask.tsx, SUMMARY_INTERVAL_MS = 30_000 in services/AgentSummary/agentSummary.ts:26, MAX_ENTRYPOINT_LINES = 200 / MAX_ENTRYPOINT_BYTES = 25_000 in memdir/memdir.ts:35,38). Three concrete claims were wrong and are fixed in v3: (J-fix) the entire task ID scheme — Claude Code uses 16-hex AgentIds matching `a(?:.+-)?[0-9a-f]{16}` (types/ids.ts:35), not 8-char base-36 with one-char type prefixes; we now use AgentIds for agents and a separate JobId namespace for media tasks. (A-fix) compaction does not use percent thresholds; it uses token-count buffers — `AUTOCOMPACT_BUFFER_TOKENS = 13_000` (services/compact/autoCompact.ts) — so our config now mirrors that. (D-fix) hooks live at top-level `hooks/`, not `utils/hooks/`. v3 also adds three patterns v2 didn't name: §M forked-agent state isolation (the full FileStateCache / DenialTrackingState / ContentReplacementState story behind CacheSafeParams, in utils/forkedAgent.ts), §N the swarm permission bridge (utils/swarm/permissionSync.ts + leaderPermissionBridge.ts) which is how leader escalation actually works, and §O contextCollapse (services/contextCollapse/) as a feature-gated alternative to compact for the Orchestrator's growing transcript. v1 was structurally sound; v2 was the right shape; v3 is what survives production with no broken citations.
The Problem, Stated Precisely
Brands spending $50M+/year on video ads are not bottlenecked by creative ideas. They are bottlenecked by production throughput and feedback latency. A winning ad exists. The team knows what works. But turning that into 40 platform-specific variants, checking each for brand compliance, launching them, gathering performance data, and feeding those learnings back into the next round of creatives — that cycle takes weeks and costs millions in agency fees.
The system we are building collapses that cycle from weeks to hours, and eventually to minutes. It does this by treating the entire creative pipeline as an agentic loop — not a collection of AI tools a human orchestrates, but a system that orchestrates itself.
What We Learned from Claude Code (and Actually Use)
These are not analogies. They are the same patterns, copied structurally into a new domain. Each section below names the exact Claude Code file, explains what it does there, and shows the equivalent implementation here.

Pattern 1 — context.ts: Layered System Prompt Assembly
What it does in Claude Code: context.ts assembles the system prompt every turn from ordered layers — stable things first (cached), dynamic things last (not cached). The ordering is deliberate: stable layers at the front maximise prompt cache hits; dynamic layers at the back change without busting the stable prefix.
Claude Code layer order (context.ts):
1. Hardcoded identity           ← never changes, always cached
2. CLAUDE.md files              ← changes rarely, usually cached
3. MEMORY.md                    ← capped 200 lines/25KB, usually cached
4. Git status                   ← changes per turn, cache busts here
5. Tool schemas                 ← stable unless tools change

What we copy: Every agent in the video system assembles its system prompt the same way. The ordering is identical in logic.
// context.ts equivalent for the EditingAgent
// Same rule: stable layers first, dynamic layers last
async function buildEditingAgentContext(
  brandId: string,
  campaignId: string,
  assetId: string
): Promise<string[]> {
  return [

    // Layer 1 — hardcoded agent identity
    // Never changes. Always first. Always cached.
    // Equivalent: utils/systemPrompt.ts
    EDITING_AGENT_BASE_PROMPT,

    // Layer 2 — brand guidelines
    // Marked as a MAGIC DOC (see §F) — self-updates from delivered campaigns,
    // but only at end-of-turn-with-no-pending-tool-calls, so it stays stable
    // mid-run.
    // Equivalent: ~/.claude/CLAUDE.md (global, stable rules)
    await loadBrandGuidelines(brandId),

    // Layer 3 — campaign-specific rules
    // Changes per campaign, not per run.
    // Equivalent: project-level .claude/CLAUDE.md
    await loadCampaignRules(campaignId),

    // Layer 4 — performance memory
    // Updated by PerformanceAgent after each campaign cycle.
    // Equivalent: MEMORY.md — hard cap 200 lines / 25KB.
    // Cap is intentional: keeps THIS BLOCK'S BYTE FOOTPRINT STABLE so layers
    // 1-3 stay cached across runs (see §I for the full rationale — this is
    // about cache-key stability, not just disk size).
    await loadPerformanceMemory(brandId, {
      maxLines: 200,
      maxBytes: 25_000,
    }),

    // Layer 5 — current asset state
    // Changes every run. Goes LAST — same reason git status goes last in
    // Claude Code. Putting dynamic content here means layers 1-4 stay cached
    // across all render jobs.
    //
    // CRITICAL: this object must be DETERMINISTIC for a given (assetId, specs)
    // pair. No timestamps. No "lastAccessed". No non-canonical ordering of
    // spec lists. See §I.
    await getAssetMetadata(assetId, { canonical: true }),
    await getVariantSpecs(campaignId, assetId, { sorted: true }),
  ]
}

Why the ordering matters at scale: If you put getAssetMetadata first, the prompt cache busts on every single render job. Keep it last, and layers 1-4 are identical across all runs for the same brand+campaign — the API charges a fraction of the token cost. At thousands of render jobs per day, this is the difference between caching saving 80% of token costs and saving nothing.

Pattern 2 — processUserInput.ts: The Brief Dispatcher
What it does in Claude Code: processUserInput.ts is a traffic cop. It reads input, checks the first character (/ = slash command, ! = bash mode, plain text = AI prompt), and routes to a completely different pipeline. Slash commands never touch query.ts. Bash mode never calls the AI. The dispatcher keeps fast paths fast.
What we copy: Incoming creative briefs get the same treatment.
// processUserInput.ts equivalent
// Not everything goes through the AI loop — fast paths stay fast
async function processBrief(brief: CreativeBrief): Promise<TaskHandle> {

  // Equivalent: slash command → processSlashCommand.tsx
  // Local, instant, no AI call needed
  if (brief.type === 'compliance_check_only') {
    return runComplianceAgent(brief.asset_id)
  }

  // Equivalent: bash mode → processBashCommand.tsx
  // Direct tool execution, no reasoning loop
  if (brief.type === 'transcode_only') {
    return runTranscodePipeline(brief.asset_id, brief.specs)
  }

  // Equivalent: plain text → processTextPrompt.ts → QueryEngine
  // Full agent loop with reasoning. Spawned via the Orchestrator
  // (which is a coordinator-mode session — see §C).
  if (brief.type === 'edit_existing') {
    return spawnEditingAgent({
      sourceAsset: brief.asset_id,
      variantSpecs: brief.specs,
      context: await buildEditingAgentContext(
        brief.brand_id,
        brief.campaign_id,
        brief.asset_id
      ),
    })
  }

  if (brief.type === 'generate_new') {
    return spawnGenerationAgent({
      creativeBrief: brief,
      context: await buildGenerationAgentContext(
        brief.brand_id,
        brief.campaign_id
      ),
    })
  }

  throw new Error(`Unknown brief type: ${brief.type}`)
}


Pattern 3 — PreToolUse + PostToolUse Hooks: The Compliance Gate
What it does in Claude Code: hooks/ (top-level, NOT utils/hooks/ — fixed in v3) runs user-configured shell commands at lifecycle events: PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, Stop, etc. PreToolUse can synchronously block before a tool runs. PostToolUse fires after every tool call, inspects the result, and can block, modify, or pass through. They are not interchangeable — AsyncHookRegistry.ts aggregates their responses with different semantics. Schemas for hook payloads live in types/hooks.ts (HookProgress, PromptRequest, PromptResponse) — define our HookDecision shape there.
What we copy: Brand compliance is two hooks, not one. The split matters operationally.
§D — Why both hooks. v1 collapsed everything into PostToolUse. Wrong: PreToolUse exists to block work before it happens. For RenderVariant, PostToolUse is correct — you inspect rendered pixels, which only exist after rendering. For DeliverToAdPlatform, PreToolUse is correct — once impressions are served, undelivering is expensive (real money, real eyeballs). A pre-delivery re-validation of the compliance clearance ID is the difference between a $2,000 incident and a $200,000 one.
// PostToolUse hook — fires after EVERY RenderVariant call
// Equivalent role: Claude Code's PostToolUse hook on file-edit tools
async function onRenderComplete(
  result: RenderResult,
  context: AgentContext
): Promise<HookDecision> {

  const compliance = await ComplianceAgent.check({
    assetPath: result.output_path,
    brandContext: context.brandContext,
    platformSpec: result.variant_spec.platform,
  })

  // Outcome 1: pass — allow
  if (compliance.passed) {
    return {
      action: 'continue',
      asset: result.asset,
      complianceId: compliance.check_id,
    }
  }

  // Outcome 2: auto-fix — modify+retry
  // PostToolUse hooks can rewrite tool results before they reach the
  // message history (Claude Code's modify-and-pass-through outcome).
  if (compliance.auto_fixable.length > 0) {
    const fixed = await applyAutoFixes(result.asset, compliance.auto_fixable)
    return {
      action: 'fix_and_retry',
      asset: fixed,
      appliedFixes: compliance.auto_fixable,
    }
  }

  // Outcome 3: escalate — deny + route to leader
  // The escalation goes UP TO THE ORCHESTRATOR (the leader/coordinator),
  // not directly to a human queue. The leader decides: auto-approve from
  // a learned policy, escalate to human, or kill the worker.
  // Equivalent: permissionSync.ts forwarding worker permission requests
  // through the leader's mailbox.
  return {
    action: 'escalate_to_leader',
    asset: result.asset,
    issues: compliance.human_required,
    workerId: context.taskId,  // surfaces a WorkerBadge in the leader UI
  }
}

// PreToolUse hook — fires BEFORE DeliverToAdPlatform
// This is the money-protection gate. Re-validates that the clearance
// recorded on the asset is still current and was not invalidated by a
// later edit (which can happen if a campaign re-runs after a brand
// guideline update).
async function preDeliverToAdPlatform(
  toolInput: DeliverInput,
  context: AgentContext
): Promise<HookDecision> {
  const clearance = await getComplianceClearance(toolInput.asset_id)

  if (!clearance || clearance.status !== 'cleared') {
    return { action: 'block', reason: 'no valid compliance clearance' }
  }
  if (clearance.invalidatedAt) {
    return { action: 'block', reason: 'clearance invalidated since render',
             invalidatedBy: clearance.invalidatedBy }
  }
  if (await brandGuidelinesChangedSince(toolInput.brand_id, clearance.checkedAt)) {
    return { action: 'block', reason: 're-check required: guidelines updated' }
  }

  // Budget gate (this part stays in canUseTool, see Pattern 4 — but the
  // PreToolUse hook is the right place for the freshness check).
  return { action: 'continue' }
}


Pattern 4 — canUseTool(): The Three-Tier Permission Classifier
What it does in Claude Code: utils/permissions/permissions.ts runs a three-tier decision: (1) auto-approve safe operations without asking, (2) run a model-based classifier (bashClassifier.ts, yoloClassifier.ts) for ambiguous operations, (3) escalate to a human permission dialog for dangerous ones. Most operations never reach a human.
What we copy: Same three tiers, applied to every video pipeline tool.
async function canUseTool(
  tool: VideoTool,
  input: ToolInput,
  context: PermissionContext
): Promise<PermissionDecision> {

  // Tier 1: Auto-approve — safe read operations
  const safeReads = ['VideoAnalyse', 'SceneDetect', 'TranscriptExtract', 'FetchMetrics']
  if (safeReads.includes(tool.name)) {
    return { decision: 'allow', reason: 'read-only operation' }
  }

  // Tier 2: Classifier — check compliance clearance before rendering
  if (tool.name === 'RenderVariant') {
    const clearance = await checkComplianceClearance(input.asset_id)
    if (clearance.status === 'cleared') {
      return { decision: 'allow', reason: 'compliance cleared',
               clearanceId: clearance.id }
    }
    if (clearance.status === 'failed') {
      return { decision: 'deny', reason: 'compliance failed',
               issues: clearance.issues }
    }
    // Not yet checked — fall through, trigger compliance run
  }

  // Tier 3: Budget threshold — escalate to leader (NOT directly to human)
  // The leader (Orchestrator in coordinator mode, see §C) decides whether
  // to surface to a human or auto-handle from policy.
  if (tool.name === 'DeliverToAdPlatform') {
    const budget = await checkBudgetThreshold(input.campaign_id,
                                              input.estimated_spend)
    if (budget.wouldExceed) {
      return {
        decision: 'needs_leader',
        reason: `delivery would exceed budget by ${budget.overage}`,
        escalateTo: 'orchestrator',
      }
    }
  }

  return { decision: 'allow', reason: 'default allow' }
}


Pattern 5 — AgentTool + runAgent.ts: Spawning Specialist Agents
What it does in Claude Code: AgentTool.tsx is what the main model calls to spawn a sub-agent. It loads the agent definition from .claude/agents/, assembles the sub-agent's context, registers a LocalAgentTask in AppState, and calls runAgent.ts — the inner streaming loop. The sub-agent is not a new process; it is a new query() call with its own system prompt and tool set.
What we copy: The Orchestrator (running in coordinator mode, §C) spawns specialist agents the same way.
async function spawnEditingAgent(
  brief: EditBrief,
  orchestratorContext: OrchestratorContext
): Promise<TaskHandle> {

  // Load agent definition from .agents/editing-agent.md
  const agentDef = await loadAgentDefinition('editing-agent')

  // Build this agent's system prompt — context.ts pattern (Pattern 1)
  const systemPrompt = await buildEditingAgentContext(
    brief.brand_id,
    brief.campaign_id,
    brief.asset_id
  )

  // Register task in tracker — shows in UI, can be monitored/cancelled.
  // Equivalent: LocalAgentTask registered in AppState.
  // §J (v3 corrected): Claude Code AgentId is 16 hex chars matching
  // `a(?:.+-)?[0-9a-f]{16}` (types/ids.ts:35). Not 8-char base-36, not
  // typed prefixes — that scheme was a v2 fabrication. Two ID
  // namespaces in our system:
  //   AgentId  — issued by `newAgentId()`, used for every agent we
  //              spawn (Editing, Generation, Compliance, Performance).
  //              Format matches Claude Code exactly so any tooling we
  //              borrow (TaskOutputTool wiring, AgentSummary, telemetry)
  //              works unmodified.
  //   JobId    — our own namespace for non-agent units of work
  //              (LocalRenderJob, RemoteRenderJob, DeliveryJob). Not
  //              an agent, doesn't need to look like one. UUIDv7 is
  //              fine; we sort by it.
  const agentId = newAgentId('editing')  // → "aediting-7f3a9b2c1d4e5f60"
  registerTask({
    id: agentId,
    type: 'editing_agent',
    status: 'running',
    agentDef,
    brief,
    startedAt: Date.now(),
    recentActivities: [],     // last 5 raw tool calls (MAX_RECENT_ACTIVITIES = 5)
    summaryLabel: 'starting', // AGENTSUMMARY field, see §G
    summaryUpdatedAt: 0,
  })

  // Run the agent loop — equivalent: runAgent.ts inner streaming loop.
  // Hooks the AgentSummary periodic forked summarizer — see §G.
  const result = await runAgentLoop({
    systemPrompt,
    tools: agentDef.tools,
    initialMessage: formatBriefAsMessage(brief),
    onToolCall: (tool, input) => updateTaskActivity(taskId, tool, input),
    onProgress: (tokens) => updateTaskTokens(taskId, tokens),
    canUseTool: (tool, input) => canUseTool(tool, input, { agentId, brief }),
    preToolUseHooks: { 'DeliverToAdPlatform': preDeliverToAdPlatform },
    postToolUseHooks: { 'RenderVariant': onRenderComplete },
    agentSummaryEvery: 30_000,  // §G — 30s periodic forked summarizer
    compactStrategy: editingAgentCompactStrategy,  // §A
  })

  completeTask(agentId, result)
  return { agentId, result }
}


Pattern 6 — LocalAgentTask vs RemoteAgentTask: Task Routing
What it does in Claude Code: Claude Code routes work to LocalAgentTask (same process, runs to completion) or RemoteAgentTask (cloud-hosted, polled). The base contract is in Task.ts (TaskType, TaskStatus, TaskHandle, TaskContext). Remote tasks persist RemoteAgentMetadata to disk so they survive a process restart. AgentIds are 16 hex chars (types/ids.ts:35), not 8-char base-36.
What we copy: Render jobs get the same routing based on estimated duration. They are NOT agents — they don't reason, they execute — so they live in their own JobId namespace. Both Local and Remote render jobs implement Task from Task.ts so they show up in the same task tracker UI.
function createRenderJob(spec: RenderSpec): Task {
  const estimatedMs = estimateRenderTime(spec)
  // §J (v3): JobId is our own namespace, separate from AgentId. Use UUIDv7
  // so it sorts by creation time. Render jobs are not agents and do not
  // need to look like one.
  const jobId = newJobId('render')  // → "render_01HXY7..."

  if (estimatedMs < 60_000) {
    // Under 1 minute — run in-process
    // Equivalent: LocalAgentTask shape (implements Task from Task.ts).
    return new LocalRenderTask({
      id: jobId,
      spec,
      onProgress: (p) => updateAppState(p),
    })
  }

  // Over 1 minute — offload to cloud GPU / render farm
  // Equivalent: RemoteAgentTask shape, with RemoteAgentMetadata persisted to
  // disk so cross-session restore works (see remote/ — the same module that
  // backs Claude Code's hosted-task polling).
  return new RemoteRenderTask({
    id: jobId,
    spec,
    pollIntervalMs: 5_000,
    metadata: serializeForDisk(spec),  // RemoteAgentMetadata pattern
  })
}


Pattern 7 — autoDream + extractMemories: The Performance Feedback Loop
What autoDream does in Claude Code: services/autoDream/ runs on a schedule, spawns a forked sub-agent, consolidates learnings into MEMORY.md, writes the file back. The main loop picks it up on the next turn. Gate logic in autoDream.ts checks time AND sessions — i.e., enough new sessions have happened that there is something to consolidate. Cross-process lock in consolidationLock.ts prevents two instances from racing the same memory file.
What extractMemories does in Claude Code: Fires at the end of every query loop (when the model produces a final response with no tool calls), runs a forked sub-agent that reads the transcript, and writes factual learnings to the per-project memory directory.
Both use runForkedAgent() — a forked call that shares the parent's prompt cache so it doesn't bust it. This is only true if you pass CacheSafeParams (§B).
What we copy: The PerformanceAgent is autoDream. The post-delivery insight extraction is a custom post-delivery hook (§K) that uses the same forked-agent mechanism.
// autoDream equivalent — runs on cron schedule (§H) after campaign data accumulates
async function runPerformanceAgent(
  brandId: string,
  campaignId: string
): Promise<void> {

  // §H — Gate check, corrected to mirror autoDream:
  // gate on TIME + NEW DATAPOINTS, not impression volume.
  // (Volume gates produce no signal in the first 24h of a launch — most
  // variants haven't crossed any meaningful impression threshold yet.)
  const shouldRun = await checkPerformanceGate({
    minNewDatapointsSinceLastRun: 20,   // analogous to autoDream's "sessions"
    lastRunAt: await getLastPerformanceRun(brandId, campaignId),
    minIntervalMs: 24 * 60 * 60 * 1000,
  })
  if (!shouldRun) return

  // Cross-process lock — same as autoDream's consolidationLock.ts
  // (with mtime rewind on failure, exactly as Claude Code does).
  const lock = await acquirePerformanceLock(brandId)
  if (!lock.acquired) return

  try {
    // §B — CacheSafeParams: pass the parent's full tool list (so the cache
    // key matches) and rely on the forked canUseTool to deny non-readonly.
    // This is what services/AgentSummary/agentSummary.ts does: "tools kept
    // for cache-key match but denied via canUseTool."
    await runForkedAgent({
      cacheSafeParams: parentCacheParams(brandId, campaignId),
      systemPrompt: PERFORMANCE_AGENT_PROMPT,
      tools: parentToolList(brandId, campaignId),  // for cache key
      canUseTool: denyNonReadonly,                  // actual restriction
      initialMessage: buildPerformanceAnalysisPrompt(brandId, campaignId),
    })
  } finally {
    await lock.release()
  }
}

// §K — Post-delivery hook (NOT a stop hook).
// Claude Code's stop hook fires when the model produces a final response
// with no tool calls. That's the wrong trigger for us — agents stop for
// many reasons mid-campaign, and we'd get noise insights every time.
// Instead we register a custom PostDelivery hook that fires only when a
// variant batch has been successfully delivered AND has initial metrics.
async function extractCreativeInsights(
  completedBatch: DeliveredVariantBatch,
  context: AgentContext
): Promise<void> {

  if (!completedBatch.hasInitialMetrics) return

  // §B — Same CacheSafeParams discipline as runPerformanceAgent.
  await runForkedAgent({
    cacheSafeParams: parentCacheParams(context.brandId, context.campaignId),
    systemPrompt: INSIGHT_EXTRACTION_PROMPT,
    tools: parentToolList(context.brandId, context.campaignId),
    canUseTool: denyNonReadonly,
    initialMessage: formatBatchForExtraction(completedBatch),
    onComplete: async (insights) => {
      await appendToPerformanceMemory(context.brandId, insights, {
        maxLines: 200,
        maxBytes: 25_000,
      })
    },
  })
}

Pattern 7b — MEMORY.md: What the PerformanceAgent Writes
Not a dashboard. Not a report. A structured markdown file that gets injected directly into the next agent's system prompt as Layer 4 in buildEditingAgentContext(). The EditingAgent adjusts its TrimClip calls accordingly — without any human instruction.
§I — Why the 200-line / 25KB cap. From memdir/memdir.ts. The cap exists so this layer's byte footprint stays stable across runs. If memory grew freely, Layer 4 would change size every consolidation; that changes byte boundaries upstream of Layer 5, which can affect cache-key hashing in subtle ways. The cap is a cache-stability constraint, not a disk-space constraint. The same discipline applies to every dynamic layer — see "Dynamic-layer hygiene" below.
# Performance Memory — Brand: Acme Co
# Updated: 2025-04-27 | Lines: 18 / 200 max

## What works (confidence: high)
- product_closeup in positions 0-3s → +23% VTR on TikTok
- CTA overlay at ratio 0.85 → +18% CTR vs 0.75 (all platforms)
- voiceover_pace 140wpm → outperforms 160wpm for 25-34 segment

## What to avoid (confidence: high)
- lifestyle_scene >6000ms → 40% drop-off spike on Instagram Reels
- logo_position bottom-right → 12% lower brand recall vs bottom-left

## Hypotheses to test (confidence: medium)
- hook_duration <2000ms may outperform 3000-5000ms for Gen Z

## Active editing parameters (read by EditingAgent on every run)
trim_lifestyle_max_ms: 6000
cta_overlay_position: 0.85
preferred_hook_duration_ms: 2000

Dynamic-layer hygiene (§I, continued)
Every value that ends up in the prompt must be deterministic for a given input. Where v1 was implicit, v2 is explicit:
getAssetMetadata returns canonical fields only. No lastAccessed, no lastModified (use a separate state store for those). If a timestamp must be in the prompt, use getSessionStartDate-style memoization (memoized once per session — see constants/common.ts).
getVariantSpecs returns specs sorted by id (canonical ordering). Set semantics break the cache key.
Brand guidelines pulled via MagicDocs (§F) are only re-read at the boundary between agent runs, never mid-run.
The PerformanceMemory loader normalises trailing whitespace and ensures a stable line count — a 197-line file pads to 200 with empty lines so the byte count varies less.

Pattern 8 (NEW) — Compaction: compact + microCompact + reactiveCompact
§A — The biggest gap in v1. A 40-variant campaign produces tens of thousands of tokens of stale tool output before it finishes. The Orchestrator session, which spans many EditingAgent runs, drifts even further. Without compaction, long campaigns OOM the context window halfway through. Claude Code has a whole subsystem for this — services/compact/ — that v1 ignored.
Three flavours, each addressing a different failure mode:
// 1. autoCompact — token-budget triggered, end-of-turn
// Equivalent: services/compact/autoCompact.ts
// Fires when total context approaches the model's context limit minus a
// fixed buffer. Summarises older tool-result blocks into a compact
// boundary message. Restores attachments via postCompactCleanup.
//
// §A (v3 corrected): Claude Code does NOT use percent thresholds. It uses
// token-count BUFFERS — the trigger fires when remaining tokens drop
// below the buffer. autoCompact.ts:62 defines AUTOCOMPACT_BUFFER_TOKENS
// = 13_000 (a turn's worth of headroom). Our config mirrors that shape
// so the math is identical to Claude Code's.
const editingAgentCompactStrategy: CompactStrategy = {
  // Trigger when remaining context falls below this buffer. Matches the
  // shape of AUTOCOMPACT_BUFFER_TOKENS — pick a value that's at least one
  // worst-case agent turn (RenderVariant tool result + reasoning).
  autoCompactBufferTokens: 13_000,
  // Earlier buffer that fires compactWarningHook so the agent can finish
  // its current step cleanly before autoCompact actually triggers.
  warningBufferTokens: 25_000,
  preserveLatestNTurns: 3,            // keep last 3 turns verbatim
}

// 2. microCompact — in-place truncation of superseded tool results
// Equivalent: services/compact/microCompact.ts + apiMicrocompact.ts
// Once an EditPlan exists, the raw output of SceneDetect / TranscriptExtract
// can be replaced in the message history with a one-line reference. The
// plan captures everything the agent needs from those calls.
function shouldMicroCompact(toolResult: ToolResult, history: Message[]): boolean {
  if (toolResult.tool === 'SceneDetect' && history.some(isEditPlan)) return true
  if (toolResult.tool === 'TranscriptExtract' && history.some(isEditPlan)) return true
  if (toolResult.tool === 'VideoAnalyse' && history.some(isEditPlan)) return true
  return false
}

// 3. reactiveCompact — triggered by tool-result SIZE, not total context
// Equivalent: reactiveCompact in query.ts
// A VideoAnalyse on a 4K hour-long source returns metadata that can run
// to MB. Compact in-flight before the next turn rather than discovering
// the problem at turn boundary.
const reactiveCompactConfig = {
  perResultByteCap: 50_000,
  onExceed: 'summariseInPlace',
  preserveFields: ['duration_ms', 'resolution', 'frame_rate', 'has_audio'],
}

// 4. Orchestrator-level reactiveCompact
// The Orchestrator's context grows with every child agent that completes.
// Hook reactiveCompact at end-of-EditingAgent so the Orchestrator's own
// transcript shrinks each time — keep the EditPlan summary, drop the raw
// turn-by-turn child transcript.
function onChildAgentComplete(child: TaskHandle, orchestrator: OrchestratorContext) {
  orchestrator.reactiveCompact({
    target: child.taskId,
    keep: ['final_result', 'edit_plans', 'compliance_status'],
    drop: ['raw_messages', 'tool_use_history'],
  })
}

compactWarningHook is the small piece that makes the rest safe: when context is approaching the trigger, the agent gets a system message ("compact imminent, finish current step"). Without this you can get mid-render compaction, which corrupts edit plans whose context is summarised away while the agent is mid-decision.

Pattern 9 (NEW) — ToolSearch + shouldDefer: Don't Pay for Every Tool Every Turn
§E — Token economics. Claude Code's Tool interface has shouldDefer, alwaysLoad, and searchHint. Tools with shouldDefer: true aren't sent on turn 1 — they're hidden behind ToolSearch. The model has to search for them by keyword. Each tool schema in the system prompt costs tokens every cached turn; with rich Zod schemas (our VariantSpec, EditPlan etc. are verbose), tools used once cost as much as tools used every turn.
Tool loading strategy by phase of use:
Tool
alwaysLoad
shouldDefer
searchHint
VideoAnalyse
false
true
"analyse video metadata"
SceneDetect
false
true
"detect scenes"
TranscriptExtract
false
true
"extract transcript"
TrimClip
true
false
—
OverlayAsset
true
false
—
AdjustAudio
true
false
—
RenderVariant
true
false
—
ToolSearch
true
false
—
TaskOutputTool
true
false
— (needed turn-1 to react to background notifications)
EscalationRequest
false
true
"escalate to leader"

The first three are used in turns 1–3 only. After turn 3 they are dead weight in the prompt. Defer them: the agent calls ToolSearch("analyse video metadata") in turn 1, gets the schema, uses it, and the schema doesn't appear in subsequent cached turns.
TaskOutputTool is the inverse case — it's alwaysLoad: true in Claude Code because the model needs it visible turn 1 to react to background notifications. Our Orchestrator's task-polling tool mirrors this.

Pattern 10 (NEW) — Coordinator Mode: What the Orchestrator Actually Is
§C — The biggest reframing. v1 treated the Orchestrator as a normal main session running QueryEngine.ts + query.ts. It isn't. Claude Code has coordinator/coordinatorMode.ts — an explicit mode where the agent gets INTERNAL_WORKER_TOOLS (TeamCreate, TeamDelete, SendMessage, SyntheticOutput) instead of the standard tool palette, uses getCoordinatorUserContext for context, and has a dedicated coordinatorHandler.ts in the permission flow. The video Orchestrator is exactly this. Reframing now is cheap; retrofitting later isn't.
What coordinator mode gives us for free:
SendMessage / SyntheticOutput — typed inter-agent messaging instead of hand-rolled poll loops
permissionSync.ts / leaderPermissionBridge.ts — when the EditingAgent's compliance check escalates, the prompt is forwarded through the leader. The leader (Orchestrator) decides: auto-approve from a learned policy, escalate to a human, or kill the worker. v1 routed escalations directly to a human queue; v2 routes through the coordinator.
WorkerBadge — every escalated permission prompt carries the originating agent's identity. The human-review UI shows which EditingAgent on which campaign for which brand. v1 had no such surface.
Plan-mode approval — EnterPlanMode / ExitPlanMode. The EditingAgent produces an EditPlan and the Orchestrator (or a human via the Orchestrator) approves it before any RenderVariant call. v1 had the EditingAgent producing plans internally with no approval gate — a $50M-customer foot-gun.
// Orchestrator main loop — coordinator mode, NOT QueryEngine.ts directly
async function orchestratorLoop(
  brief: CreativeBrief,
  context: OrchestratorContext
): Promise<CampaignResult> {

  // Coordinator-mode context build. Different tools, different prompt.
  // Equivalent: getCoordinatorUserContext(scratchpadDir).
  const coordinatorContext = await buildOrchestratorCoordinatorContext(
    brief.brand_id, brief.campaign_id
  )

  // Spawn worker via the worker-tool palette (TeamCreate / SendMessage).
  // Workers are LocalAgentTask-style children, NOT raw runAgentLoop calls
  // from this file.
  const editTask = await processBrief(brief)

  // Plan-mode gate: receive plan, route to human if novel pattern detected.
  const plan = await waitForChildToProducePlan(editTask.id)
  const approved = await approvePlanInCoordinator(plan, {
    autoApproveIfMatchesPolicy: true,
    routeToHumanIfNovelty: true,
  })
  if (!approved) {
    await killTask(editTask.id, 'plan_not_approved')
    return { status: 'cancelled', reason: 'plan_not_approved' }
  }
  await sendToChild(editTask.id, { type: 'plan_approved', plan })

  // Monitor — TaskOutputTool pattern (non-blocking poll), but the leader
  // also receives forwarded escalations via the mailbox.
  while (!editTask.isComplete()) {
    const progress = await pollTask(editTask.id)
    updateOrchestratorState(progress)

    // §D — escalations from PostToolUse compliance hook arrive here
    // via permissionSync, not via a separate human-queue API.
    for (const issue of getOpenLeaderEscalations(editTask.id)) {
      const decision = await decideAtLeader(issue, {
        learnedPolicy: brandPolicy(context.brandId),
        humanFallback: true,
      })
      await respondToWorker(editTask.id, issue.id, decision)
    }

    await sleep(POLL_INTERVAL_MS)
  }

  // §K — post-delivery hook (custom event, NOT stop hook)
  if (editTask.result.delivered) {
    await extractCreativeInsights(editTask.result, context)
  }

  return editTask.result
}


Pattern 11 (NEW) — MagicDocs: Self-Updating Brand Guidelines
§F — Brand guidelines aren't actually static. Markets get added. Spokespeople get dropped. Sub-brands launch. v1's only path to update Layer 2 was a human edit. Claude Code's services/MagicDocs/ is exactly the right primitive: markdown files marked with # MAGIC DOC: [title]. When read by the agent, a forked subagent later updates the doc with new learnings — read-triggered, post-sampling, only when the assistant turn has no pending tool calls.
Apply: guidelines.md becomes a magic doc. Distinct from performance_memory.md:
performance_memory.md (Layer 4) — what performs. Quantitative. Updated by PerformanceAgent.
guidelines.md (Layer 2) — what the brand is. Descriptive. Updated by MagicDocs after delivered campaigns.
# MAGIC DOC: Acme Co Brand Guidelines

## Visual identity
- Primary palette: #1A1A2E, #16213E, #E94560, #F4A261
- Logo: bottom-left position preferred (12% better recall than bottom-right per perf memory)
- Typography: approved fonts — see fonts/

## Voice
- Confident, never aggressive
- Avoid superlatives ("best", "most", "perfect") — legal flagged 3× in EU market

## Recently observed (auto-updated by MagicDocs)
- 2026-04-12: "Summer Lite" sub-brand launched; observed colour #F4A261 used 4× without flag — propose adding to palette
- 2026-03-30: claim "clinically proven" triggered legal reject in EU market 3× — flag for review

The MagicDocs post-sampling hook only runs when the turn has no pending tool calls, so it can't corrupt an in-flight render plan. Updates land between runs, where Layer 2 is allowed to change (and where the cache will be naturally re-warmed).

Pattern 12 (NEW) — AgentSummary: Live Render Labels for Operators
§G — recentActivities is the wrong abstraction alone. v1 had recentActivities: [] // last 5 tool calls visible in UI. That's MAX_RECENT_ACTIVITIES = 5 from LocalAgentTask — correct, but Claude Code also runs services/AgentSummary/: every ~30 seconds, a forked subagent reads the running task's transcript and produces a 3-5 word present-tense progress label. For long render jobs (Phase 1 spec: >60s = remote task), the difference is "Tool: TrimClip" vs "Cutting hook scene to 2.4s." Operators monitoring 200 concurrent campaigns can scan the latter.
// services/AgentSummary equivalent
async function startAgentSummaryLoop(taskId: string, parentParams: CacheSafeParams) {
  setInterval(async () => {
    const task = getTask(taskId)
    if (task.status !== 'running') return

    // §B — CacheSafeParams: tools kept for cache-key match, denied via canUseTool
    await runForkedAgent({
      cacheSafeParams: parentParams,
      tools: task.parentToolList,
      canUseTool: denyAll,
      systemPrompt: AGENT_SUMMARY_PROMPT,
      initialMessage: 'Summarise current activity in 3-5 present-tense words.',
      onComplete: (label) => updateAgentSummary(taskId, label),
    })
  }, 30_000)
}

The recentActivities and the summaryLabel coexist. recentActivities is for forensics ("what tool was called when this failed?"), summaryLabel is for live monitoring ("is anything stuck?").

Pattern 13 (NEW) — cron + SessionMemory: Background Scheduling and Per-Session Notes
§H — Roll-your-own scheduling reinvents bugs. v1 said "runPerformanceAgent on a nightly schedule" without saying how. Claude Code has utils/cron.ts, cronJitterConfig.ts, cronScheduler.ts, cronTasks.ts, cronTasksLock.ts. Use these. Jitter exists so 200 brands don't all fire at midnight UTC. Per-task locks exist so retries don't double-fire. backgroundHousekeeping.ts integrates them with the rest of the lifecycle.
// utils/cron equivalent — schedule the PerformanceAgent
registerCronTask({
  id: 'performance-agent',
  schedule: '0 2 * * *',        // 02:00 daily
  jitterMs: 30 * 60 * 1000,     // ±30min so 200 brands stagger
  lockKey: (ctx) => `performance:${ctx.brandId}`,
  run: async (ctx) => runPerformanceAgent(ctx.brandId, ctx.campaignId),
})

§L — SessionMemory is the Orchestrator's scratchpad. Distinct from MEMORY.md (durable, cross-session) and performance_memory.md (durable, brand-scoped). services/SessionMemory/ is per-session notes maintained by a forked subagent during the session. For a long Orchestrator session running a multi-day campaign, this is where transient state lives that doesn't deserve durable performance memory but shouldn't be lost either.
/brand/{brand_id}/campaigns/{campaign_id}/sessions/{session_id}/
  session_memory.md          # SessionMemory equivalent — auto-maintained
                             # by forked subagent, NOT persisted across
                             # campaigns. Tracks: which variants we've
                             # already tried, which platforms rate-limited
                             # us today, which approval the human just gave
                             # 5 minutes ago.


Pattern 14 (NEW) — MCP Servers for Ad Platforms
§L (continued) — Ad platforms are MCP servers. v1 mentioned DeliverToAdPlatform as a tool without saying how to integrate TikTok / Meta / Google / etc. Each is a separate API with its own OAuth, rate limits, error semantics. Don't hand-roll. Claude Code's services/mcp/ handles connection lifecycle, OAuth, elicitation, and exposes a /mcp UI for monitoring server health.
// Each ad platform is an MCP server
const mcpServers: McpServerConfig[] = [
  { name: 'tiktok-ads',  url: 'mcp://internal/tiktok-ads',  oauthConfig: tiktokOAuth },
  { name: 'meta-ads',    url: 'mcp://internal/meta-ads',    oauthConfig: metaOAuth },
  { name: 'google-ads',  url: 'mcp://internal/google-ads',  oauthConfig: googleOAuth },
  { name: 'fetch-metrics', url: 'mcp://internal/metrics-aggregator' },
]

// `DeliverToAdPlatform` becomes a thin router that calls the right MCP server
// based on input.platform. Auth, retries, rate-limit backoff, error
// classification all live in the MCP layer (services/mcp/), not in the
// agent loop.

Health is observable in one place. Adding a new ad platform is a new MCP server, not a new tool integration spread across the codebase.

System Overview
┌──────────────────────────────────────────────────────────────────────┐
│                  Orchestrator (Coordinator Mode §C)                  │
│  - Worker tool palette: TeamCreate, SendMessage, SyntheticOutput     │
│  - Plan-mode approval gate before any RenderVariant                  │
│  - Receives forwarded compliance escalations via mailbox             │
│  - Owns SessionMemory.md for this campaign session (§L)              │
└─────────┬──────────────────────────────────────────┬─────────────────┘
          │                                          │
  ┌───────▼────────┐                       ┌─────────▼──────────┐
  │ Editing Agent  │                       │ Generation Agent   │
  │ runAgentLoop   │                       │ runAgentLoop       │
  │ + AgentSummary │                       │ + AgentSummary     │
  │ + ToolSearch   │                       │ + Multi-model      │
  │   for analysis │                       │   fan-out          │
  │   tools        │                       │                    │
  │ Phase 1        │                       │ Phase 2            │
  └───────┬────────┘                       └─────────┬──────────┘
          │                                          │
          ├── PreToolUse  → preDeliverToAdPlatform   │
          ├── PostToolUse → onRenderComplete         │
          │                 → ComplianceAgent (§D)   │
          └─────────────┬────────────────────────────┘
                        │
        ┌───────────────▼────────────────┐
        │     Cron-scheduled (§H)        │
        │     PerformanceAgent           │
        │     - autoDream gate           │
        │     - runForkedAgent           │
        │       (CacheSafeParams §B)     │
        │     - writes performance_      │
        │       memory.md (§I caps)      │
        │     Phase 4                    │
        └────────────────────────────────┘

         Side-channel: MagicDocs (§F) updates guidelines.md
                        between runs (post-sampling, no pending tools)

         Side-channel: SessionMemory (§L) per-session forked subagent

         Compaction (§A) runs throughout: autoCompact, microCompact,
         reactiveCompact at every level.

         Ad platforms (§L) accessed via MCP servers, not bespoke tools.


Phase 1 — Editing Agent (Ship This First)
Why editing first
Every customer already has footage. The immediate $50M problem is "take this winning 30-second ad and produce 40 variants." Generation models are improving fast but commoditising fast. Editing is where durable value is, and it gives real performance data to feed Phase 4 without waiting for generation to mature.
Agent definition file
---
name: editing-agent
description: Produces platform-specific variants from a source video asset
tools: VideoAnalyse, SceneDetect, TranscriptExtract, TrimClip, OverlayAsset, AdjustAudio, RenderVariant
model: claude-opus-4-7
defer_tools: [VideoAnalyse, SceneDetect, TranscriptExtract]   # §E
---

You are a video editing specialist. Your job is to take a source video
and a set of variant specifications and produce a complete set of edited
variants that satisfy each specification.

You always begin by analysing the source video fully before making any
edits. You produce an explicit edit plan and submit it for approval (via
ExitPlanMode) before executing any renders.

When a specification is ambiguous, you apply the brand guidelines to
resolve it. When brand guidelines do not cover a case, you flag it for
the leader rather than guessing.

Tools the Editing Agent calls
Tool
What it does
Auto-approved?
Loaded turn 1?
VideoAnalyse
Extracts metadata, duration, frame rate, aspect ratio
Yes — read only
No (§E, deferred)
SceneDetect
Identifies scene boundaries, classifies each
Yes — read only
No (§E, deferred)
TranscriptExtract
Extracts spoken audio as timestamped transcript
Yes — read only
No (§E, deferred)
TrimClip
Cuts a clip between two timestamps
Yes — non-destructive
Yes
OverlayAsset
Composites image, text, or logo onto a clip
Yes — non-destructive
Yes
AdjustAudio
Normalises, ducks, or replaces audio
Yes — non-destructive
Yes
RenderVariant
Assembles final variant from edit plan
No — requires compliance clearance
Yes
ToolSearch
Discovers deferred tools
n/a
Yes
TaskOutputTool
Reads background task output
n/a
Yes

The editing loop
Orchestrator (coordinator mode) → spawnEditingAgent(brief)
  → buildEditingAgentContext()    [Pattern 1, dynamic-layer hygiene §I]
  → runAgentLoop()                [§A compactStrategy, §G AgentSummary]

EditingAgent turns:
  turn 1: ToolSearch("analyse video")  →  schemas for analysis tools
          VideoAnalyse(source_asset)
          → metadata, duration, frame rate
  turn 2: SceneDetect(source_asset)
          → scene_map with timestamps and labels
  turn 3: TranscriptExtract(source_asset)
          → transcript with word-level timestamps
  turn 4: [internal reasoning — produces EditPlan per VariantSpec]
          ExitPlanMode(plans)  →  Orchestrator approves before turn 5
  turn 5: TrimClip / OverlayAsset / AdjustAudio (per spec)
          → assembled clips
          [microCompact §A: SceneDetect/Transcript/VideoAnalyse outputs
          replaced with one-line refs once the plan exists]
  turn 6: RenderVariant(assembled_clip) × N
          → each call triggers canUseTool() + onRenderComplete() hook
          → DeliverToAdPlatform calls also trigger preDeliverToAdPlatform
  final:  return VariantBatch

Data structures
interface VideoAsset {
  id: string
  path: string
  duration_ms: number
  resolution: { width: number; height: number }
  frame_rate: number
  has_audio: boolean
}

interface VariantSpec {
  id: string
  platform: 'instagram_reel' | 'youtube_pre' | 'tiktok' | 'display_16_9' | string
  max_duration_ms: number
  aspect_ratio: string
  audience_segment?: string
  market?: string
  cta_override?: string
}

interface EditPlan {
  variant_spec_id: string
  scenes: SceneInstruction[]
  overlays: OverlayInstruction[]
  audio: AudioInstruction
  estimated_duration_ms: number
}

interface VariantBatch {
  source_asset_id: string
  variants: RenderedVariant[]
  edit_plans: EditPlan[]
  compliance_status: 'pending' | 'passed' | 'failed' | 'auto_fixed'
}


Phase 2 — Generation Agent
Why generation is Phase 2
By Phase 2 you have real performance data from Phase 1. The GenerationAgent reads performance_memory.md as Layer 4 of its context — it generates informed by observed patterns, not into a void. Without Phase 1 data, generation produces interesting outputs with unknown performance.
Multi-model fan-out (the swarm pattern)
Shot generation is parallel. Multiple shots are generated concurrently as independent tasks — the spawnInProcess + InProcessTeammateTask pattern from Claude Code's swarm system. Each in-process teammate uses AsyncLocalStorage for context isolation.
async function generateShots(
  storyboard: Storyboard,
  context: GenerationContext
): Promise<Asset[]> {

  const shotTasks = storyboard.shots.map(shot => ({
    taskId: `t${generateBase36Id(7)}`,    // §J: 't' prefix for teammate, 8 chars total
    shot,
    modelConfig: routeShot(shot),
  }))

  // Dispatch all concurrently — same as spawnInProcess for swarm teammates
  const results = await Promise.all(
    shotTasks.map(({ taskId, shot, modelConfig }) =>
      runShotGeneration(taskId, shot, modelConfig)
    )
  )

  return results
}

function routeShot(shot: Shot): ModelConfig {
  if (shot.duration_ms < 4_000 && shot.motion === 'static') {
    return { model: 'image-gen', upscale: true }
  }
  if (shot.type === 'product_demo') {
    return { model: 'video-gen-v2', style: 'photorealistic' }
  }
  return { model: 'video-gen-v1', style: shot.style }
}


Phase 3 — Brand Compliance Agent
Compliance is two hooks, not a feature
The ComplianceAgent is invoked from two distinct gates wired into the render-and-deliver pipeline (see §D, Pattern 3):
onRenderComplete — PostToolUse on RenderVariant. Inspects rendered pixels.
preDeliverToAdPlatform — PreToolUse on DeliverToAdPlatform. Re-validates clearance freshness before money is spent.
Three outcomes — pass / auto-fix / escalate-to-leader — map to Claude Code's allow / modify+retry / deny+escalate.
ComplianceAgent loop
// ComplianceAgent — runs inside both hooks above.
// Layered context, Pattern 1 style:
//   Layer 1: COMPLIANCE_AGENT_BASE_PROMPT
//   Layer 2: brand guidelines (MagicDoc — §F)
//   Layer 3: market legal spec
//   Layer 4: platform technical spec
//   No dynamic layer — compliance is stateless per asset

async function runComplianceCheck(
  assetPath: string,
  brandId: string,
  market: string,
  platform: string
): Promise<ComplianceResult> {
  return runAgentLoop({
    systemPrompt: await buildComplianceAgentContext(brandId, market, platform),
    tools: ['ExtractFrames', 'DetectLogo', 'CheckColour', 'CheckTypography',
            'AnalyseTone', 'CheckLegal', 'CheckPlatformSpec'],
    initialMessage: `Check compliance for asset: ${assetPath}`,
    compactStrategy: complianceCompactStrategy,   // §A
  })
}

interface ComplianceResult {
  asset_id: string
  passed: boolean
  checks: {
    logo: LogoCheckResult
    colour: ColourCheckResult
    typography: TypoCheckResult
    tone: ToneCheckResult
    legal: LegalCheckResult
    platform: PlatformCheckResult
  }
  auto_fixable: ComplianceFix[]
  human_required: ComplianceIssue[]
  // §D — escalation routes to leader, not directly to human
  escalateTo: 'orchestrator'
}


Phase 4 — Performance Feedback Loop
The PerformanceAgent is autoDream (with the gate corrected per §H). Cron-scheduled (§H). Forked with CacheSafeParams (§B). Writes capped memory (§I). Insight extraction is post-delivery (§K), not stop-hook.
Claude Code autoDream:
  cron gate (time + jitter) →
  session/datapoint gate →
  acquire cross-process lock →
  runForkedAgent(CacheSafeParams) →
  write capped MEMORY.md →
  release lock →
  main loop reads it next turn

PerformanceAgent:
  cron gate (time + jitter)         [§H]
  new-datapoints gate (NOT volume)  [§H]
  acquire cross-process lock        [autoDream consolidationLock pattern]
  runForkedAgent(CacheSafeParams)   [§B]
  write capped performance_memory.md [§I caps and rationale]
  release lock
  EditingAgent reads it next run via buildEditingAgentContext()

The loop closes
Brief
  → processBrief()                     [Pattern 2]
  → Orchestrator (coordinator mode)    [§C]
  → spawnEditingAgent()                [Pattern 5]
  → buildEditingAgentContext()         [Pattern 1, §I hygiene]
  → ToolSearch for analysis tools      [§E]
  → ExitPlanMode → leader approval     [§C]
  → TrimClip/Overlay calls
  → microCompact superseded results    [§A]
  → RenderVariant calls
  → onRenderComplete (PostToolUse)     [§D]
  → preDeliverToAdPlatform (PreToolUse) [§D]
  → MCP server delivers                [§L]
  → extractCreativeInsights (post-delivery hook)  [§K]
  → cron PerformanceAgent              [§H]
  → CacheSafeParams forked agent       [§B]
  → writes capped performance_memory.md [§I]
  → MagicDocs updates guidelines.md    [§F]
  → back to buildEditingAgentContext() next run


Orchestrator Design (revised — §C coordinator mode)
The Orchestrator is a coordinator-mode session — Claude Code's coordinator/coordinatorMode.ts + services/SessionMemory/ running on top of QueryEngine.ts. It never touches media files. It coordinates, sequences, approves plans, and routes escalations.
async function buildOrchestratorCoordinatorContext(
  brandId: string,
  campaignId: string
): Promise<string[]> {
  return [
    ORCHESTRATOR_COORDINATOR_PROMPT,                     // stable
    await loadBrandGuidelines(brandId),                  // MagicDoc §F
    await loadPerformanceMemory(brandId, { maxLines: 200, maxBytes: 25_000 }),
    await loadSessionMemory(brandId, campaignId),        // §L
    await getActiveCampaignBrief(campaignId),            // semi-dynamic
    await getActiveTaskList(campaignId, { canonical: true }),  // §I sorted
  ]
}

The full orchestrator loop is in Pattern 10 (§C) above.

Infrastructure
Storage model
/brand/{brand_id}/
  guidelines.md                       # MagicDoc §F — auto-updated between runs
  performance_memory.md               # MEMORY.md equiv §I caps
  /campaigns/{campaign_id}/
    brief.md
    /sessions/{session_id}/
      session_memory.md               # §L per-session forked subagent
    /assets/{asset_id}/
      source.mp4
      /variants/
        {variant_id}.mp4
        {variant_id}_metadata.json
        {variant_id}_compliance.json
        {variant_id}_clearance.json   # PreToolUse re-validates this §D
    /edit_plans/
      {plan_id}.json
    /performance/
      {date}.json

Task ID scheme (§J — v3 corrected)
v2 invented an 8-char base-36 scheme with single-char type prefixes; that scheme does not exist in Claude Code. Verified in types/ids.ts:35 — the actual `AgentId` regex is `^a(?:.+-)?[0-9a-f]{16}$`, i.e. `a` + optional hyphenated label + 16 hex chars. v3 uses two ID namespaces:

AgentId (matches Claude Code byte-for-byte; reuse `newAgentId(label?)`)
- Issued for every entity that takes a turn through `runAgentLoop()`.
- Optional label segment is a hint, not a type discriminator — multiple agent kinds can share a label and still be distinguishable by their registered TaskType.
  - aediting-7f3a9b2c1d4e5f60        — EditingAgent
  - ageneration-2c4e6f8091a3b5d7      — GenerationAgent
  - acompliance-1d3f5b7e9c0a2468      — ComplianceAgent
  - aperformance-90817263544536271    — PerformanceAgent (cron-spawned)
- TaskType — separate field on the Task record — is the source of truth for "what kind of agent is this." That's what AppState filters on, what AgentSummary keys off, what the UI groups by. The label is operator-friendly but not load-bearing.

JobId (our own namespace, NOT an agent)
- Issued for non-agent units of work that still register in the task tracker.
- UUIDv7 with a kind prefix so it sorts by creation time and is greppable.
  - render_01HXY7K9...   — LocalRenderTask / RemoteRenderTask
  - deliver_01HXY7M2...  — DeliverJob (one MCP server call, retries inline)
  - compact_01HXY7N4...  — manual reactiveCompact run
- Implements Task from Task.ts so it shows in the same tracker UI as agents and the operator can monitor concurrent renders without a separate pane.

Task routing summary
Duration
Task type
Claude Code equivalent
< 60s
LocalRenderTask (in-process)
LocalAgentTask
> 60s
RemoteRenderTask (cloud GPU, polled)
RemoteAgentTask

Remote tasks persist RemoteAgentMetadata to disk for cross-session restore.

Phase Sequencing Summary
Phase
Core Capability
Key Claude Code Pattern
1
Edit existing footage into variants
context.ts, runAgent.ts, canUseTool(), compact, ToolSearch
2
Generate net-new creative material
spawnInProcess, InProcessTeammateTask
3
Brand compliance at every render gate
PreToolUse + PostToolUse hooks, permission classifier
4
Performance feedback closes the loop
autoDream, extractMemories, MagicDocs, cron, MEMORY.md

Each phase is independently shippable. Phase 4 on top of 1+2+3 is where the durable competitive advantage lives — the system gets measurably better every campaign cycle without human analysis.

What to Build First, Concretely (revised)
Week 1–2. Define VideoAsset, VariantSpec, EditPlan. Implement buildEditingAgentContext() with all five layers — put placeholder files for brand guidelines and performance memory so the structure is correct from day one. Wrap ffmpeg as three tools: TrimClip, OverlayAsset, RenderVariant — each with validateInput() and call(). Set up compact strategy from day one (§A) — even a stub autoCompact is better than nothing. Set shouldDefer: true on analysis tools (§E). Run one EditingAgent loop on one source asset, two variant specs. Get two rendered outputs.
Week 3–4. Add SceneDetect and TranscriptExtract (deferred, behind ToolSearch). Implement canUseTool() with the three-tier structure. Implement coordinator-mode Orchestrator (§C) now, not later — retrofitting is painful. Test on five real customer assets. The compliance clearance check in tier 2 can be a stub that always passes for now.
Week 5–6. Wire in onRenderComplete() as the PostToolUse hook AND preDeliverToAdPlatform() as the PreToolUse hook (§D). Implement the ComplianceAgent loop with logo detection and colour checks. Build the auto-fix path for repositionable failures. Build the leader-escalation path through utils/swarm/permissionSync.ts + leaderPermissionBridge.ts (§N) — child returns `needs_leader` from canUseTool, leader decides via brand policy classifier first, falls back to human review with WorkerBadge context. Nothing reaches delivery without compliance passing AND clearance freshness re-validated.
Week 7–8. Wire MagicDocs for guidelines.md (§F). Implement AgentSummary periodic forked summarizer (§G). Implement SessionMemory for the Orchestrator (§L). Centralise on a single forkVideoSubagent helper (§M) so AgentSummary, MagicDocs updates, SessionMemory updates, the cron PerformanceAgent run, and post-delivery insight extraction all share the same state-isolation discipline (cloned FileStateCache, snapshotted DenialTrackingState, snapshotted ContentReplacementState, identical tool list). Test end-to-end with a real brand's guidelines as a magic doc.
Month 3. GenerationAgent. One video model only. routeShot() with two model options. Parallel shot generation using the in-process teammate fan-out pattern. Outputs hand off to EditingAgent for variant production.
Month 4–5. PerformanceAgent. One ad platform via MCP server (§L) — not bespoke API integration. runPerformanceAgent() cron-scheduled with jitter and per-brand lock (§H). Forked through forkVideoSubagent (§M, which already wraps CacheSafeParams §B). First write to performance_memory.md with the caps and dynamic-layer hygiene from §I. Decide whether to enable contextCollapse (§O) — once Orchestrator sessions span multiple days with rolling generations, the linear transcript will accumulate beyond what compaction alone keeps in budget; A/B the loss-of-fidelity vs context-saving tradeoff on real campaigns rather than guess. Measure whether second-round creatives outperform first-round on VTR and CTR — proof of concept for the closed loop.

Pattern 15 (NEW in v3) — Forked-Agent State Isolation: The Full Story Behind CacheSafeParams
§M — v2 mentioned CacheSafeParams as a cache-key thing. It is, but that's only half. The forked subagent shares the parent's prompt cache key, AND it must NOT mutate state the parent can later observe. utils/forkedAgent.ts (line 489 exports runForkedAgent; CacheSafeParams at lines 57-68) snapshots and isolates four parent state objects before the fork runs:
1. FileStateCache — the per-session record of which files have been read at which mtime. If the fork reads a file that the parent later edits, the parent's "read before edit" guard would otherwise be confused. Cloned, not shared.
2. DenialTrackingState — past permission denials for canUseTool. The fork inherits the parent's denial history (so it doesn't re-prompt the user for things already denied) but cannot grow it.
3. ContentReplacementState — pending text replacements queued by the parent. Read-only inside the fork.
4. The tool list itself — kept identical to the parent's so the API cache key matches, with denial enforced at canUseTool time, not by removing tools from the list (services/AgentSummary/agentSummary.ts is the canonical example).
Apply directly: every forked-subagent we use — AgentSummary every 30s (§G), MagicDocs post-sampling update (§F), SessionMemory updates (§L), PerformanceAgent cron run (Phase 4), extractCreativeInsights post-delivery (§K) — passes CacheSafeParams the same way. None of them can corrupt parent state, none of them bust the parent's prompt cache. Build one helper (forkVideoSubagent(parentCtx, role, message)) and route all five through it; do not roll a per-call snapshot pattern.
async function forkVideoSubagent(
  parent: AgentContext,
  role: 'agent_summary' | 'magic_docs_update' | 'session_memory'
        | 'performance_agent' | 'insight_extraction',
  systemPrompt: string,
  message: string,
): Promise<ForkedResult> {
  return runForkedAgent({
    cacheSafeParams: {
      // Cloned. Reads visible inside the fork; writes invisible to parent.
      fileStateCache: parent.fileStateCache.clone(),
      // Inherited read-only. Fork can read past denials, cannot append.
      denialTrackingState: parent.denialTrackingState.snapshot(),
      // Snapshotted. Pending replacements are visible but not extendable.
      contentReplacementState: parent.contentReplacementState.snapshot(),
    },
    // Tools list identical to parent — the cache-key constraint. Restriction
    // happens via canUseTool below, not by removing tools.
    tools: parent.toolList,
    canUseTool: forkCanUseToolForRole(role),
    systemPrompt,
    initialMessage: message,
  })
}
Without this discipline you don't get a 30% cost reduction from cache hits — you get a hot reload of the entire system prompt every fork. With it, the parent prompt is genuinely cached across thousands of summary/insight/dream calls per day, and that's where the unit economics of running the system at $50M/yr ad spend actually work.

Pattern 16 (NEW in v3) — Swarm Permission Bridge: How Leader Escalation Actually Works
§N — v2 said compliance escalations route through the Orchestrator's mailbox. Correct in spirit, vague on infrastructure. The actual machinery is in utils/swarm/permissionSync.ts and utils/swarm/leaderPermissionBridge.ts: when a child agent's canUseTool decision is `needs_leader`, the prompt is forwarded up through a typed bus, the leader makes a decision (auto-approve from learned policy, escalate to a human via WorkerBadge UI, or kill the child), and the response routes back to the child's permission flow without restarting the agent loop. The child sees the answer as if its own canUseTool returned it — no special-case code path in the child.
Apply: our compliance escalation (Pattern 3 outcome 3) does not write to a separate "human queue" table. It returns `decision: 'needs_leader'` from canUseTool, and the swarm bridge does the rest. WorkerBadge in the leader's UI surfaces (brand, campaign, AgentId, asset, issue type) so a human reviewer sees enough context to decide without paging through logs. The leader's policy lookup is a learned-classifier call (Tier 2 of canUseTool, applied at the leader level) — most escalations never reach a human at all, which is the point.
Concretely:
// Child agent — no awareness of escalation infrastructure
const decision = await canUseTool(
  RenderVariantTool,
  input,
  context
)
if (decision.action === 'needs_leader') {
  // permissionSync forwards this up; we just await the answer
  const leaderDecision = await waitForLeaderDecision(decision.id)
  if (leaderDecision.allowed) { /* proceed */ }
}

// Leader (Orchestrator coordinator-mode) — receives via leaderPermissionBridge
async function onChildPermissionRequest(
  request: PermissionRequest,
  ctx: OrchestratorContext,
): Promise<PermissionResponse> {
  // Tier 2 at the leader: auto-approve via learned policy first
  const policyHit = await brandPolicyClassifier(ctx.brandId, request)
  if (policyHit.confidence > 0.9) {
    return { allowed: policyHit.decision, reason: 'learned_policy' }
  }
  // Else surface to a human reviewer with full WorkerBadge context
  return await humanReviewWithBadge(request, {
    brandId: ctx.brandId,
    campaignId: ctx.campaignId,
    agentId: request.fromAgentId,
    asset: request.assetId,
    issueType: request.issue,
  })
}
Why this matters in practice: the EditingAgent does NOT need to know whether its compliance escalation went to a policy classifier or a human. It blocks once at canUseTool, gets an answer, continues. The Orchestrator can swap the policy in/out, surface to different humans for different brands, batch reviews — all without changes downstream. v2's "mailbox" framing left this implementation-defined; v3 names the actual modules so the design is portable.

Pattern 17 (NEW in v3) — contextCollapse for the Orchestrator's Long Horizon
§O — A Phase-1 Orchestrator session running a 40-variant campaign accumulates child-agent results for hours. Compaction (Pattern 8) is good, but Claude Code has a separate, feature-gated subsystem for the harder case: services/contextCollapse/ (referenced from query.ts and setup.ts behind feature('CONTEXT_COLLAPSE')). Where compact summarises recent tool results in place, contextCollapse rewrites the entire transcript into a denser representation by collapsing whole subtrees of completed work — e.g. "edited 18 variants for spec batch A, all delivered, all metrics nominal" replaces 18 detailed child-agent transcripts.
Apply (selectively): leave it OFF in Phase 1. Phase 1 campaigns end before the Orchestrator's context becomes the bottleneck. Turn it ON in Phase 4, when the Orchestrator may oversee multi-day campaigns with rolling generations, ongoing performance feedback, and continuous variant fan-out. Gate it the same way Claude Code does — feature flag, off by default — so we can A/B the loss-of-fidelity cost vs the context-saving benefit on real campaigns rather than guess.
Don't conflate with reactiveCompact (Pattern 8 #4). reactiveCompact trims a single child's transcript at the end of that child's run, reducing what enters the Orchestrator's transcript. contextCollapse rewrites the Orchestrator's transcript itself, after many children have already entered it. They compose: reactiveCompact reduces the ingest rate; contextCollapse cleans up the accumulation.

Mapping: Function → Claude Code File
Every function in this architecture maps to a named file in Claude Code:
Our function
Claude Code
buildEditingAgentContext()
context.ts
runAgentLoop()
runAgent.ts
processBrief()
processUserInput.ts
onRenderComplete()
PostToolUse hooks (utils/hooks/)
preDeliverToAdPlatform()
PreToolUse hooks (utils/hooks/)
runPerformanceAgent()
services/autoDream/autoDream.ts
extractCreativeInsights()
services/extractMemories/ (post-delivery variant)
performance_memory.md
MEMORY.md (memdir/memdir.ts caps)
guidelines.md
services/MagicDocs/
Orchestrator
coordinator/coordinatorMode.ts
Compaction
services/compact/ (auto / micro / reactive)
Tool deferring
Tool.shouldDefer, ToolSearch
AgentSummary periodic label
services/AgentSummary/agentSummary.ts
Cron-scheduled jobs
utils/cron*
Session-scoped notes
services/SessionMemory/
Ad platforms
services/mcp/
runForkedAgent cache safety
CacheSafeParams (see services/AgentSummary/)
forkVideoSubagent state isolation (§M)
utils/forkedAgent.ts (FileStateCache, DenialTrackingState, ContentReplacementState)
Leader permission escalation (§N)
utils/swarm/permissionSync.ts + leaderPermissionBridge.ts
WorkerBadge surface for human review
coordinator/coordinatorMode.ts (re-exported)
contextCollapse for Orchestrator (§O, Phase 4)
services/contextCollapse/ (gated by feature('CONTEXT_COLLAPSE'))
HookDecision shape
types/hooks.ts
AgentId format and minter
types/ids.ts (regex `a(?:.+-)?[0-9a-f]{16}`) + newAgentId()
JobId namespace (render / deliver / compact)
our own; UUIDv7 — no Claude Code equivalent (intentional)

Study those files; build these functions.
