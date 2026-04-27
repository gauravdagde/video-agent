// Plan §N — typed request/response for the swarm permission bridge.
// Workers (any agent that hits an `escalate_to_leader` outcome) build a
// PermissionRequest and send it through `permissionSync`. The leader
// (Phase-1: default auto-approve handler; Phase-2: orchestrator
// coordinator-mode agent) returns a PermissionResponse.
//
// `data` is opaque to the bus — hooks pass through whatever escalation
// context they need (compliance issue list, applied/skipped fix lists,
// etc.). The leader handler unpacks based on `hookKind`.

export type PermissionHookKind =
  | "pre_tool_use"
  | "post_tool_use"
  | "permission_classifier"; // canUseTool Tier 3 (T3.3)

export interface PermissionRequest {
  readonly id: string;
  readonly fromAgentId: string;
  readonly brandId: string;
  readonly campaignId: string;
  readonly toolName: string;
  readonly input: unknown;
  // Present for PostToolUse escalations (the tool already produced a
  // result that the hook flagged); absent for PreToolUse / classifier.
  readonly output?: unknown;
  readonly reason: string;
  readonly data?: unknown;
  readonly hookKind: PermissionHookKind;
}

export interface PermissionResponse {
  readonly id: string;
  readonly allowed: boolean;
  readonly reason: string;
}

// Generate a request id. crypto.randomUUID is available in Bun + modern
// Node and gives us a globally-unique id without taking on UUIDv7.
export function newPermissionRequestId(): string {
  return `perm_${crypto.randomUUID()}`;
}
