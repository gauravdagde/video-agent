import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import {
  checkAutoCompact,
  performAutoCompact,
} from "./autoCompact.ts";
import { editingAgentCompactStrategy } from "./CompactStrategy.ts";

type MessageParam = Anthropic.Messages.MessageParam;

describe("checkAutoCompact — signal classification", () => {
  test("returns ok when remaining tokens are well above buffer", async () => {
    const r = await checkAutoCompact(
      {
        modelContextLimit: 200_000,
        lastInputTokens: 10_000,
        remainingTokens: 190_000,
        turnIndex: 1,
      },
      editingAgentCompactStrategy,
    );
    expect(r.signal.kind).toBe("ok");
  });

  test("returns warning when remaining drops below warningBufferTokens", async () => {
    let warned = false;
    const r = await checkAutoCompact(
      {
        modelContextLimit: 200_000,
        lastInputTokens: 180_000,
        remainingTokens: 20_000,
        turnIndex: 5,
      },
      editingAgentCompactStrategy,
      () => {
        warned = true;
      },
    );
    expect(r.signal.kind).toBe("warning");
    expect(warned).toBe(true);
  });

  test("returns trigger when remaining drops below autoCompactBufferTokens", async () => {
    let triggered = false;
    const r = await checkAutoCompact(
      {
        modelContextLimit: 200_000,
        lastInputTokens: 195_000,
        remainingTokens: 5_000,
        turnIndex: 10,
      },
      editingAgentCompactStrategy,
      undefined,
      () => {
        triggered = true;
      },
    );
    expect(r.signal.kind).toBe("trigger");
    expect(triggered).toBe(true);
  });
});

describe("performAutoCompact — message rewrite", () => {
  // Each "turn" in the loop = 1 assistant message + 1 user message.
  function turn(i: number): [MessageParam, MessageParam] {
    return [
      { role: "assistant", content: `assistant turn ${i}` },
      { role: "user", content: `user follow-up ${i}` },
    ];
  }

  test("noop when message count is at or below preserve threshold", async () => {
    // preserveLatestNTurns = 3, so 6 messages of paired turn data.
    const messages: MessageParam[] = [
      { role: "user", content: "initial" },
      ...turn(1).flat(),
      ...turn(2).flat(),
      ...turn(3).flat(),
    ];
    const r = await performAutoCompact(messages, editingAgentCompactStrategy);
    expect(r.compacted).toBe(false);
    expect(r.droppedCount).toBe(0);
    expect(r.messages).toEqual(messages);
  });

  test("rewrites older turns when threshold exceeded", async () => {
    const messages: MessageParam[] = [
      { role: "user", content: "initial brief" },
      ...turn(1).flat(),
      ...turn(2).flat(),
      ...turn(3).flat(),
      ...turn(4).flat(),
      ...turn(5).flat(),
    ];
    const r = await performAutoCompact(messages, editingAgentCompactStrategy);
    expect(r.compacted).toBe(true);
    expect(r.droppedCount).toBeGreaterThan(0);
    // First message is now the boundary summary.
    const first = r.messages[0]!;
    expect(first.role).toBe("user");
    expect(first.content).toContain("previous-context-summary");
    // Latest 3 turns (= 6 messages) are preserved verbatim.
    const tail = r.messages.slice(-6);
    expect(tail[0]!.content).toBe("assistant turn 3");
    expect(tail[5]!.content).toBe("user follow-up 5");
  });

  test("custom summariser is invoked when provided", async () => {
    let summarisedCount = 0;
    const messages: MessageParam[] = [
      { role: "user", content: "init" },
      ...turn(1).flat(),
      ...turn(2).flat(),
      ...turn(3).flat(),
      ...turn(4).flat(),
      ...turn(5).flat(),
    ];
    const r = await performAutoCompact(messages, editingAgentCompactStrategy, {
      summarise: async (older) => {
        summarisedCount = older.length;
        return "FORKED SUMMARY OF EARLIER WORK";
      },
    });
    expect(r.compacted).toBe(true);
    expect(summarisedCount).toBeGreaterThan(0);
    expect(r.messages[0]!.content).toContain("FORKED SUMMARY OF EARLIER WORK");
  });
});
