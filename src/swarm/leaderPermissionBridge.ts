import type {
  PermissionRequest,
  PermissionResponse,
} from "./PermissionRequest.ts";

// Plan §N — the leader-side handler. Implementations:
//   defaultLeaderHandler        — Phase-1, auto-approve everything (matches
//                                 current behaviour where escalations
//                                 fell through to allow).
//   orchestratorLeaderHandler   — Phase-2 / T5.1, queues requests for the
//                                 orchestrator coordinator-mode agent to
//                                 see + respond via SendMessage.
//   policyClassifierHandler     — Phase-2, brand-policy classifier first,
//                                 falls back to one of the above.
//
// The handler abstraction lets the bus delegate without knowing whether
// processing is synchronous (Phase-1 sync function) or queued (Phase-2
// orchestrator polling).
export interface LeaderHandler {
  onRequest(req: PermissionRequest): Promise<PermissionResponse>;
}

// Default Phase-1 handler. Matches the system's prior behaviour: every
// escalation passes through. The point of routing through the bus rather
// than just allowing inline is so Phase-2's policy classifier and human
// review can be slotted in later by swapping the handler — no caller-site
// changes needed.
export const defaultLeaderHandler: LeaderHandler = {
  async onRequest(req: PermissionRequest): Promise<PermissionResponse> {
    return {
      id: req.id,
      allowed: true,
      reason: "default leader: auto-approve (Phase 1)",
    };
  },
};

// A handler that always denies — useful for tests and for environments
// where the system is supposed to halt on any escalation.
export const denyAllLeaderHandler: LeaderHandler = {
  async onRequest(req: PermissionRequest): Promise<PermissionResponse> {
    return { id: req.id, allowed: false, reason: "deny-all leader handler" };
  },
};
