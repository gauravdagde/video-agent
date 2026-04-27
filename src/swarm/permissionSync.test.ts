import { afterEach, describe, expect, test } from "bun:test";
import {
  defaultLeaderHandler,
  denyAllLeaderHandler,
  type LeaderHandler,
} from "./leaderPermissionBridge.ts";
import {
  newPermissionRequestId,
  type PermissionRequest,
  type PermissionResponse,
} from "./PermissionRequest.ts";
import { PermissionBus, permissionSync } from "./permissionSync.ts";

function fakeReq(reason = "test"): PermissionRequest {
  return {
    id: newPermissionRequestId(),
    fromAgentId: "atest-0000000000000000",
    brandId: "demo-brand",
    campaignId: "demo-campaign",
    toolName: "RenderVariant",
    input: {},
    reason,
    hookKind: "post_tool_use",
  };
}

afterEach(() => {
  // Reset the singleton between tests so state doesn't leak.
  permissionSync.setHandler(defaultLeaderHandler);
  permissionSync.cancelAllPending("test-cleanup");
});

describe("PermissionBus — sync handler mode", () => {
  test("default handler approves every request", async () => {
    const bus = new PermissionBus();
    const r = await bus.forwardToLeader(fakeReq());
    expect(r.allowed).toBe(true);
    expect(r.reason).toContain("Phase 1");
  });

  test("denyAll handler rejects every request", async () => {
    const bus = new PermissionBus();
    bus.setHandler(denyAllLeaderHandler);
    const r = await bus.forwardToLeader(fakeReq());
    expect(r.allowed).toBe(false);
  });

  test("custom handler sees the request payload verbatim", async () => {
    const bus = new PermissionBus();
    let captured: PermissionRequest | null = null;
    const recordingHandler: LeaderHandler = {
      async onRequest(req) {
        captured = req;
        return { id: req.id, allowed: true, reason: "captured" };
      },
    };
    bus.setHandler(recordingHandler);
    const req = fakeReq("compliance failed");
    await bus.forwardToLeader(req);
    expect(captured).not.toBeNull();
    expect(captured!.toolName).toBe("RenderVariant");
    expect(captured!.reason).toBe("compliance failed");
  });
});

describe("PermissionBus — queued mode", () => {
  test("with no handler, requests queue and resolve via respondToWorker", async () => {
    const bus = new PermissionBus();
    bus.setHandler(null);

    const req = fakeReq();
    const promise = bus.forwardToLeader(req);
    // Hasn't resolved yet — request is queued.
    expect(bus.pendingSize()).toBe(1);

    bus.respondToWorker(req.id, {
      id: req.id,
      allowed: true,
      reason: "manually approved",
    });
    const r = await promise;
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("manually approved");
    expect(bus.pendingSize()).toBe(0);
  });

  test("pendingRequests reports queued requests", async () => {
    const bus = new PermissionBus();
    bus.setHandler(null);
    const a = fakeReq("a");
    const b = fakeReq("b");
    // Attach catch handlers up front — cancelAllPending below rejects
    // them, and unhandled rejections in Bun fail the test.
    const pa = bus.forwardToLeader(a).catch(() => undefined);
    const pb = bus.forwardToLeader(b).catch(() => undefined);
    const pending = bus.pendingRequests();
    expect(pending).toHaveLength(2);
    const reasons = pending.map((p) => p.reason).sort();
    expect(reasons).toEqual(["a", "b"]);
    bus.cancelAllPending("test-cleanup");
    await Promise.all([pa, pb]);
  });

  test("respondToWorker for unknown id throws", () => {
    const bus = new PermissionBus();
    bus.setHandler(null);
    expect(() =>
      bus.respondToWorker("nope", { id: "nope", allowed: true, reason: "" }),
    ).toThrow();
  });

  test("cancelAllPending rejects in-flight requests", async () => {
    const bus = new PermissionBus();
    bus.setHandler(null);
    const promise = bus.forwardToLeader(fakeReq());
    bus.cancelAllPending("shutdown");
    await expect(promise).rejects.toThrow(/cancelled.*shutdown/);
    expect(bus.pendingSize()).toBe(0);
  });
});

describe("permissionSync singleton", () => {
  test("starts with the default auto-approve handler", async () => {
    const r = await permissionSync.forwardToLeader(fakeReq());
    expect(r.allowed).toBe(true);
  });

  test("setHandler swaps behaviour for subsequent requests", async () => {
    permissionSync.setHandler(denyAllLeaderHandler);
    const r = await permissionSync.forwardToLeader(fakeReq());
    expect(r.allowed).toBe(false);
  });
});

describe("newPermissionRequestId", () => {
  test("ids are unique and prefixed", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(newPermissionRequestId());
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id.startsWith("perm_")).toBe(true);
  });
});
