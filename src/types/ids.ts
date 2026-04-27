// Mirrors Claude Code's AgentId scheme (claude-code-src/types/ids.ts:35).
// Format: `a` + optional hyphenated label + 16 hex chars.
// The label is operator-friendly only — TaskType (on the Task record) is
// the source of truth for "what kind of agent is this."
export type AgentId = string & { readonly __brand: "AgentId" };

const AGENT_ID_REGEX = /^a(?:.+-)?[0-9a-f]{16}$/;
const AGENT_ID_LABEL_REGEX = /^[a-z][a-z0-9_]{0,30}$/;

export function newAgentId(label?: string): AgentId {
  if (label !== undefined && !AGENT_ID_LABEL_REGEX.test(label)) {
    throw new Error(
      `agent label must be lowercase alnum/underscore, ≤31 chars: got ${JSON.stringify(label)}`,
    );
  }
  const hex = randomHexChars(16);
  const id = label ? `a${label}-${hex}` : `a${hex}`;
  return id as AgentId;
}

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && AGENT_ID_REGEX.test(value);
}

// JobId — our own namespace. NOT an agent (no reasoning loop).
// UUIDv7 so it sorts by creation time. Kind prefix for greppability.
export type JobKind = "render" | "deliver" | "compact";
export type JobId = string & { readonly __brand: "JobId" };

const JOB_ID_REGEX = /^(render|deliver|compact)_[0-9A-HJKMNP-TV-Z]{26}$/;

export function newJobId(kind: JobKind): JobId {
  return `${kind}_${uuidV7Crockford()}` as JobId;
}

export function isJobId(value: unknown): value is JobId {
  return typeof value === "string" && JOB_ID_REGEX.test(value);
}

// --- helpers ---

function randomHexChars(chars: number): string {
  const buf = new Uint8Array(Math.ceil(chars / 2));
  crypto.getRandomValues(buf);
  let out = "";
  for (const byte of buf) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out.slice(0, chars);
}

// UUIDv7 in Crockford base32 (26 chars, ULID-compatible alphabet).
// 48-bit unix-ms timestamp + 80 bits random. Sorts lexicographically by time.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function uuidV7Crockford(): string {
  const ms = BigInt(Date.now());
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);

  // Pack: 48 bits time + 80 bits random into 130 bits, encode lower 130 → 26
  // chars of base32. The top 4 bits of the first char are zero for ms <
  // 2^48, which is fine through the year 10895.
  let bits = ms;
  for (const byte of rand) {
    bits = (bits << 8n) | BigInt(byte);
  }

  let out = "";
  for (let i = 0; i < 26; i++) {
    const idx = Number(bits & 0x1fn);
    out = CROCKFORD[idx]! + out;
    bits >>= 5n;
  }
  return out;
}
