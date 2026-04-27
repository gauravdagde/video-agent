// Base task contract — mirrors claude-code-src/Task.ts.
// Both AgentIds and JobIds (plan §J v3) implement this so the operator
// sees one unified task tracker UI for agents and render jobs alike.

import type { AgentId, JobId } from "./types/ids.ts";

export type TaskType =
  | "editing_agent"
  | "generation_agent"
  | "compliance_agent"
  | "performance_agent"
  | "orchestrator"
  | "local_render"
  | "remote_render"
  | "deliver";

export type TaskStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export function isTerminalStatus(s: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(s);
}

// §G — recentActivities cap matches Claude Code's MAX_RECENT_ACTIVITIES = 5
// (verified in claude-code-src/tasks/LocalAgentTask/LocalAgentTask.tsx).
export const MAX_RECENT_ACTIVITIES = 5;

export interface RecentActivity {
  tool: string;
  startedAtMs: number;
  // Truncated input — full input lives in the transcript, this is for the UI.
  inputPreview: string;
}

// §G — AgentSummary periodic forked summary label, ~30s cadence
// (verified SUMMARY_INTERVAL_MS = 30_000 in
// claude-code-src/services/AgentSummary/agentSummary.ts:26).
export const SUMMARY_INTERVAL_MS = 30_000;

export interface TaskRecord {
  readonly id: AgentId | JobId;
  readonly type: TaskType;
  status: TaskStatus;
  readonly startedAtMs: number;
  endedAtMs?: number;
  // §G live label for the operator monitor.
  summaryLabel: string;
  summaryUpdatedAtMs: number;
  // §G forensic trail. Capped at MAX_RECENT_ACTIVITIES.
  recentActivities: RecentActivity[];
  // brand/campaign context for filtering and WorkerBadge surfaces (§N).
  readonly brandId: string;
  readonly campaignId: string;
}

export interface TaskHandle<TResult = unknown> {
  readonly id: AgentId | JobId;
  isComplete(): boolean;
  result(): TResult | undefined;
  cancel(reason: string): Promise<void>;
}
