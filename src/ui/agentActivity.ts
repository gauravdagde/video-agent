// Tiny pub-sub registry of currently-active agents. The renderer reads
// from it on each spinner tick; Conversation/spawnEditingAgent/
// runComplianceAgent/etc. write to it as they spin agents up and down.
//
// Goal is purely UX: when the user types in chat, they should be able
// to see at a glance how many agents are alive and what each one is
// doing right now ("EditingAgent: analysing video", "ComplianceAgent:
// checking variant tiktok-1"). Nothing about agent lifecycle / output
// flows through here — it's read-only for the renderer.

export type AgentKind =
  | "editing"
  | "compliance"
  | "generation"
  | "subagent";

export interface AgentEntry {
  readonly id: string;
  readonly kind: AgentKind;
  // Short human-readable label shown in the live line. Examples:
  //   "EditingAgent (chat)"
  //   "ComplianceAgent · variant tiktok-1"
  readonly label: string;
  // Current activity — updated as tools fire. Examples:
  //   "thinking"
  //   "probing source video"
  //   "drafting plans"
  readonly activity: string;
  readonly startedAtMs: number;
}

export interface AgentActivity {
  register(id: string, kind: AgentKind, label: string): void;
  setActivity(id: string, activity: string): void;
  unregister(id: string): void;
  list(): readonly AgentEntry[];
  // Subscribe to mutations. The renderer calls list() each tick anyway,
  // but having a change signal lets a future renderer push instead of
  // poll. Returns an unsubscribe function.
  onChange(cb: () => void): () => void;
}

export function createAgentActivity(): AgentActivity {
  const entries = new Map<string, AgentEntry>();
  const subscribers = new Set<() => void>();

  const notify = (): void => {
    for (const cb of subscribers) cb();
  };

  return {
    register(id, kind, label) {
      if (entries.has(id)) return;
      entries.set(id, {
        id,
        kind,
        label,
        activity: "starting",
        startedAtMs: Date.now(),
      });
      notify();
    },
    setActivity(id, activity) {
      const cur = entries.get(id);
      if (cur === undefined) return;
      if (cur.activity === activity) return;
      entries.set(id, { ...cur, activity });
      notify();
    },
    unregister(id) {
      if (!entries.has(id)) return;
      entries.delete(id);
      notify();
    },
    list() {
      return [...entries.values()];
    },
    onChange(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
  };
}

// Singleton — one registry per process. All agents (Editing in chat,
// Compliance forks, Generation forks) write to the same one so the
// renderer can show them in one place.
export const agentActivity: AgentActivity = createAgentActivity();
