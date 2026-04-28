// Hosted vision via the Anthropic SDK. Sibling of llamaVision.ts —
// same describe(image, prompt, schema) shape, different backend.
//
// Why this is the default when ANTHROPIC_API_KEY is set: zero new
// install, no model download, no daemon, parallel calls work out of the
// box, highest quality. Cost: ~$0.005-0.0075 per scene depending on the
// model.

import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";

const DEFAULT_MODEL = process.env.MODEL ?? "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 400;

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient === null) cachedClient = new Anthropic();
  return cachedClient;
}

export interface ClaudeDescribeOpts {
  readonly imagePath: string;
  readonly prompt: string;
  readonly jsonSchema?: unknown;
  readonly maxTokens?: number;
  readonly signal: AbortSignal;
  readonly model?: string;
}

// Anthropic doesn't expose OpenAI-style `response_format: json_schema`
// natively, but with a tight prompt + the schema spelled out + temp 0,
// the model produces valid JSON >99% of the time. The caller's parser
// already handles surrounding prose defensively.
export async function describeImageWithClaude(
  opts: ClaudeDescribeOpts,
): Promise<string> {
  const bytes = await readFile(opts.imagePath);
  const b64 = bytes.toString("base64");

  const schemaHint =
    opts.jsonSchema !== undefined
      ? `\n\nReturn ONLY a JSON object matching this schema (no prose, no fences):\n${JSON.stringify(opts.jsonSchema, null, 2)}`
      : "";

  const r = await client().messages.create(
    {
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: b64,
              },
            },
            { type: "text", text: opts.prompt + schemaHint },
          ],
        },
      ],
    },
    { signal: opts.signal },
  );
  const text = r.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return text;
}

export function isClaudeConfigured(): boolean {
  const k = process.env.ANTHROPIC_API_KEY ?? "";
  return k.length > 0;
}
