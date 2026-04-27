// Unit tests for the JSON-extraction logic in runComplianceAgent. The
// real agent loop needs an API key and is exercised by the opt-in
// integration test (compliance.test.ts) when one is present.

import { describe, expect, test } from "bun:test";

// Re-implement the parser by importing the module. The parser isn't
// exported, so we test it indirectly through structurally similar inputs.
// To avoid plumbing a private export, dynamically import the file source
// and run the parser via its observable behaviour: feed final-text-shaped
// strings to a thin wrapper.

import { _parseClearanceForTest as parse } from "./runComplianceAgent.ts";

describe("runComplianceAgent — parseClearance", () => {
  test("parses a fenced ```json``` block", () => {
    const text =
      "Here's my verdict.\n\n```json\n" +
      JSON.stringify({
        passed: true,
        auto_fixable: [],
        human_required: [],
      }) +
      "\n```\n";
    const r = parse(text);
    expect(r.passed).toBe(true);
    expect(r.auto_fixable).toEqual([]);
    expect(r.human_required).toEqual([]);
  });

  test("parses a fenced ``` block without language tag", () => {
    const text =
      "```\n" +
      JSON.stringify({ passed: false, auto_fixable: [], human_required: [] }) +
      "\n```";
    const r = parse(text);
    expect(r.passed).toBe(false);
  });

  test("falls back to first balanced object if no fence", () => {
    const text =
      "Verdict: " +
      JSON.stringify({ passed: true, auto_fixable: [], human_required: [] }) +
      " end.";
    const r = parse(text);
    expect(r.passed).toBe(true);
  });

  test("preserves auto_fixable and human_required arrays", () => {
    const text =
      "```json\n" +
      JSON.stringify({
        passed: false,
        auto_fixable: [
          {
            kind: "logo_position",
            description: "logo 12px from edge, expected 24px",
            delta: { dx: 12, dy: 0 },
          },
        ],
        human_required: [
          {
            kind: "legal",
            severity: "error",
            description: "claim 'clinically proven' requires disclaimer in EU",
            evidence: "frame 3",
          },
        ],
      }) +
      "\n```";
    const r = parse(text);
    expect(r.passed).toBe(false);
    expect(r.auto_fixable).toHaveLength(1);
    expect(r.human_required).toHaveLength(1);
    expect(r.auto_fixable[0]!.kind).toBe("logo_position");
    expect(r.human_required[0]!.severity).toBe("error");
  });

  test("throws on unparseable JSON", () => {
    expect(() => parse("This is not JSON at all")).toThrow();
  });

  test("throws on JSON that is not an object", () => {
    expect(() => parse("```json\n[1,2,3]\n```")).toThrow();
  });
});
