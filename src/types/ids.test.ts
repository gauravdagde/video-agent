import { describe, expect, test } from "bun:test";
import { isAgentId, isJobId, newAgentId, newJobId } from "./ids.ts";

describe("AgentId", () => {
  // Regex byte-for-byte matches claude-code-src/types/ids.ts:35
  test("matches Claude Code's AgentId regex", () => {
    expect(isAgentId(newAgentId())).toBe(true);
    expect(isAgentId(newAgentId("editing"))).toBe(true);
    expect(isAgentId(newAgentId("generation"))).toBe(true);
    expect(isAgentId(newAgentId("compliance"))).toBe(true);
  });

  test("label appears in id, hex is 16 chars", () => {
    const id = newAgentId("editing");
    expect(id.startsWith("aediting-")).toBe(true);
    expect(id.length).toBe("aediting-".length + 16);
  });

  test("rejects malformed input", () => {
    expect(isAgentId("aZ12345678901234")).toBe(false); // uppercase hex
    expect(isAgentId("a12345")).toBe(false); // too short
    expect(isAgentId("editing-1234567890abcdef")).toBe(false); // missing leading a
  });

  test("rejects bad labels at construction time", () => {
    expect(() => newAgentId("Editing")).toThrow(); // capital
    expect(() => newAgentId("with-hyphen")).toThrow(); // hyphen
    expect(() => newAgentId("a".repeat(32))).toThrow(); // too long
  });

  test("ids are unique across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(newAgentId("editing"));
    expect(seen.size).toBe(1000);
  });
});

describe("JobId", () => {
  test("kind prefix and ULID-ish body", () => {
    const id = newJobId("render");
    expect(id.startsWith("render_")).toBe(true);
    expect(isJobId(id)).toBe(true);
  });

  test("each kind round-trips", () => {
    for (const kind of ["render", "deliver", "compact"] as const) {
      const id = newJobId(kind);
      expect(isJobId(id)).toBe(true);
      expect(id.startsWith(`${kind}_`)).toBe(true);
    }
  });

  test("sortable — newer ids sort after older ones", async () => {
    const a = newJobId("render");
    await Bun.sleep(2); // distinct ms timestamp
    const b = newJobId("render");
    expect(a < b).toBe(true);
  });
});
