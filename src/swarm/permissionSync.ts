import {
  defaultLeaderHandler,
  type LeaderHandler,
} from "./leaderPermissionBridge.ts";
import type {
  PermissionRequest,
  PermissionResponse,
} from "./PermissionRequest.ts";

// Plan §N — in-process bus connecting workers (escalating agents) to the
// leader (orchestrator or its stand-in). Two modes:
//
//   1. Sync handler set (default). Every `forwardToLeader` call goes
//      straight through `handler.onRequest`. Phase-1 default behaviour.
//   2. No handler set. Requests get queued in `pending`. The leader
//      polls via `pendingRequests()` and replies via `respondToWorker`.
//      Phase-2 orchestrator coordinator-mode (T5.1) uses this path.
//
// Both modes coexist because the orchestrator might want sync handling
// for some routes and queued for others — `setHandler(null)` flips the
// bus into queued mode.

interface PendingEntry {
  readonly req: PermissionRequest;
  readonly resolve: (r: PermissionResponse) => void;
  readonly reject: (e: Error) => void;
}

export class PermissionBus {
  private pending = new Map<string, PendingEntry>();
  private handler: LeaderHandler | null = defaultLeaderHandler;

  // null means "no sync handler — queue and wait for respondToWorker".
  setHandler(h: LeaderHandler | null): void {
    this.handler = h;
  }

  getHandler(): LeaderHandler | null {
    return this.handler;
  }

  async forwardToLeader(
    req: PermissionRequest,
  ): Promise<PermissionResponse> {
    if (this.handler !== null) {
      return await this.handler.onRequest(req);
    }
    return new Promise<PermissionResponse>((resolve, reject) => {
      this.pending.set(req.id, { req, resolve, reject });
    });
  }

  // Leader-side polling. Returns a snapshot — leader iterates and decides
  // for each, then calls respondToWorker per entry.
  pendingRequests(): readonly PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }

  respondToWorker(id: string, response: PermissionResponse): void {
    const entry = this.pending.get(id);
    if (entry === undefined) {
      throw new Error(`respondToWorker: no pending request for id ${id}`);
    }
    this.pending.delete(id);
    entry.resolve(response);
  }

  // Cancel any in-flight queued request — propagates to the worker as
  // a rejected promise. Used when the leader is shutting down.
  cancelAllPending(reason: string): void {
    for (const entry of this.pending.values()) {
      entry.reject(new Error(`permission bus cancelled: ${reason}`));
    }
    this.pending.clear();
  }

  // Test helper.
  pendingSize(): number {
    return this.pending.size;
  }
}

// Process-wide singleton. Workers reach for this; the orchestrator (T5.1)
// will swap the handler at startup.
export const permissionSync = new PermissionBus();
