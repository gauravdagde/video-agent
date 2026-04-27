import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { microCompact } from "./microCompact.ts";

type MessageParam = Anthropic.Messages.MessageParam;

// Builders that mirror what the loop pushes into messages[].
function userMsg(text: string): MessageParam {
  return { role: "user", content: text };
}

function assistantToolUse(
  id: string,
  name: string,
  input: unknown = {},
): MessageParam {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input }],
  };
}

function userToolResult(toolUseId: string, content: string): MessageParam {
  return {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: toolUseId, content },
    ],
  };
}

describe("microCompact", () => {
  test("noop when no ExitPlanMode call has happened yet", () => {
    const messages: MessageParam[] = [
      userMsg("brief"),
      assistantToolUse("u1", "VideoAnalyse"),
      userToolResult("u1", JSON.stringify({ duration_ms: 30000 })),
    ];
    const r = microCompact(messages);
    expect(r.rewroteCount).toBe(0);
    expect(r.messages).toEqual(messages);
  });

  test("rewrites SceneDetect / TranscriptExtract / VideoAnalyse after ExitPlanMode", () => {
    const messages: MessageParam[] = [
      userMsg("brief"),
      assistantToolUse("u1", "VideoAnalyse"),
      userToolResult("u1", JSON.stringify({ duration_ms: 30000, big_blob: "x".repeat(1000) })),
      assistantToolUse("u2", "SceneDetect"),
      userToolResult("u2", JSON.stringify({ scenes: Array(50).fill({ a: 1 }) })),
      assistantToolUse("u3", "TranscriptExtract"),
      userToolResult("u3", JSON.stringify({ words: Array(200).fill({ t: "x" }) })),
      assistantToolUse("u4", "ExitPlanMode", { plans: [] }),
      userToolResult("u4", JSON.stringify({ approved: true })),
    ];
    const r = microCompact(messages);
    expect(r.rewroteCount).toBe(3);

    // The three analysis tool_results were rewritten.
    const tu1 = r.messages[2]!;
    if (tu1.role !== "user" || !Array.isArray(tu1.content))
      throw new Error("type narrow");
    const block1 = tu1.content[0]!;
    if (block1.type !== "tool_result") throw new Error("type narrow");
    expect(typeof block1.content).toBe("string");
    expect(block1.content as string).toContain("microCompacted by EditPlan");

    // The ExitPlanMode result itself is NOT rewritten.
    const tuExit = r.messages[8]!;
    if (tuExit.role !== "user" || !Array.isArray(tuExit.content))
      throw new Error("type narrow");
    const blockExit = tuExit.content[0]!;
    if (blockExit.type !== "tool_result") throw new Error("type narrow");
    expect(blockExit.content).toContain("approved");
  });

  test("idempotent — running twice has the same effect as once", () => {
    const messages: MessageParam[] = [
      userMsg("brief"),
      assistantToolUse("u1", "VideoAnalyse"),
      userToolResult("u1", JSON.stringify({ duration_ms: 30000 })),
      assistantToolUse("u2", "ExitPlanMode"),
      userToolResult("u2", JSON.stringify({ approved: true })),
    ];
    const once = microCompact(messages);
    expect(once.rewroteCount).toBe(1);
    const twice = microCompact(once.messages);
    expect(twice.rewroteCount).toBe(0);
    expect(twice.messages).toEqual(once.messages);
  });

  test("does not touch tool_results for non-targeted tools", () => {
    const messages: MessageParam[] = [
      userMsg("brief"),
      assistantToolUse("u1", "TrimClip"),
      userToolResult("u1", JSON.stringify({ output_path: "/x.mp4" })),
      assistantToolUse("u2", "ExitPlanMode"),
      userToolResult("u2", JSON.stringify({ approved: true })),
    ];
    const r = microCompact(messages);
    expect(r.rewroteCount).toBe(0);
  });

  test("preserves message order and message count", () => {
    const messages: MessageParam[] = [
      userMsg("brief"),
      assistantToolUse("u1", "VideoAnalyse"),
      userToolResult("u1", JSON.stringify({ a: 1 })),
      assistantToolUse("u2", "ExitPlanMode"),
      userToolResult("u2", JSON.stringify({ approved: true })),
    ];
    const r = microCompact(messages);
    expect(r.messages.length).toBe(messages.length);
    expect(r.messages.map((m) => m.role)).toEqual(
      messages.map((m) => m.role),
    );
  });
});
