// Plan §A — reactiveCompact replaces oversized tool outputs with a
// compact summary blob BEFORE they enter the message history. Different
// from autoCompact (end-of-turn token budget) and microCompact (post-plan
// dead-weight rewrite): this fires per-tool-result, mid-turn, when one
// output alone is large enough to matter (think VideoAnalyse on a 4K
// hour-long source returning multi-MB metadata).
//
// `preserveFields` keeps named keys verbatim so the model still sees the
// load-bearing pieces (duration_ms, resolution, frame_rate, has_audio,
// etc.) even when the rest is dropped.

export interface ReactiveCompactOpts {
  readonly perResultByteCap: number;
  readonly preserveFields?: readonly string[];
  // Optional summariser — when provided, called instead of plain truncation.
  // Production wiring (T2.x and later) passes a forkVideoSubagent-backed
  // summariser; tests and the default Phase-1 path use truncation.
  readonly summarise?: (json: string) => Promise<string>;
}

export const reactiveCompactDefault: ReactiveCompactOpts = {
  perResultByteCap: 50_000,
  preserveFields: ["duration_ms", "resolution", "frame_rate", "has_audio"],
};

export interface ReactiveCompactResult {
  // String content to put in the tool_result block.
  readonly content: string;
  readonly compacted: boolean;
  readonly originalSize: number;
  readonly compactedSize: number;
}

export async function reactiveCompact(
  output: unknown,
  opts: ReactiveCompactOpts = reactiveCompactDefault,
): Promise<ReactiveCompactResult> {
  const json = JSON.stringify(output);
  if (json.length <= opts.perResultByteCap) {
    return {
      content: json,
      compacted: false,
      originalSize: json.length,
      compactedSize: json.length,
    };
  }

  const preserved = extractPreservedFields(output, opts.preserveFields);
  const summary = opts.summarise
    ? await opts.summarise(json)
    : `[reactiveCompacted: ${json.length} bytes truncated; preserved fields kept verbatim]`;

  const replacement = JSON.stringify({
    _reactive_compacted: true,
    summary,
    preserved,
    original_size_bytes: json.length,
  });

  return {
    content: replacement,
    compacted: true,
    originalSize: json.length,
    compactedSize: replacement.length,
  };
}

function extractPreservedFields(
  output: unknown,
  fields: readonly string[] | undefined,
): Record<string, unknown> {
  if (fields === undefined || fields.length === 0) return {};
  if (typeof output !== "object" || output === null) return {};
  if (Array.isArray(output)) return {};
  const o = output as Record<string, unknown>;
  const preserved: Record<string, unknown> = {};
  for (const f of fields) {
    if (Object.hasOwn(o, f)) preserved[f] = o[f];
  }
  return preserved;
}
