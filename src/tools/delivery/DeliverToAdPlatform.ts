import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { McpClient } from "../../mcp/Client.ts";
import { storagePaths } from "../../storage/paths.ts";
import type { Tool, ToolUseContext } from "../../Tool.ts";
import type {
  AssetId,
  BrandId,
  CampaignId,
} from "../../types/video.ts";

// Plan §L (T2.1) — single tool the agent calls to deliver any variant to
// any platform. Routes to the right MCP server based on `input.platform`.
// Auth, rate limits, error semantics live in the MCP layer.

const Input = z.object({
  platform: z.string(),
  variant_spec_id: z.string(),
  asset_id: z.string(),
  output_path: z.string(),
  compliance_check_id: z.string().optional(),
  estimated_spend: z.number().nonnegative().optional(),
});

const Output = z.object({
  receipt_id: z.string(),
  platform: z.string(),
  status: z.literal("submitted"),
  submitted_at_ms: z.number(),
});

type In = z.infer<typeof Input>;
type Out = z.infer<typeof Output>;

// Resolution: env var per platform supplies the MCP endpoint, e.g.
//   VIDEO_AGENT_MCP_TIKTOK=stdio:///path/to/tiktok-server.ts
//   VIDEO_AGENT_MCP_META=http://meta-mcp.internal:9000/mcp
// For tests / local dev the routing is overridable via setPlatformResolver.
export type PlatformResolver = (platform: string) => Promise<McpClient>;

let resolver: PlatformResolver = defaultResolverFromEnv;
export function setPlatformResolver(r: PlatformResolver): void {
  resolver = r;
}
export function resetPlatformResolver(): void {
  resolver = defaultResolverFromEnv;
}

async function defaultResolverFromEnv(platform: string): Promise<McpClient> {
  const envKey = `VIDEO_AGENT_MCP_${platform.toUpperCase().replace(/-/g, "_")}`;
  const url = process.env[envKey];
  if (url === undefined || url === "") {
    throw new Error(
      `no MCP endpoint configured for platform "${platform}" — set ${envKey}`,
    );
  }
  if (url.startsWith("stdio://")) {
    const cmd = url.slice("stdio://".length).split(/\s+/);
    return McpClient.connect({ transport: "stdio", opts: { command: cmd } });
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return McpClient.connect({ transport: "http", opts: { url } });
  }
  throw new Error(
    `${envKey} must start with stdio:// or http(s):// — got: ${url}`,
  );
}

export const DeliverToAdPlatformTool: Tool<In, Out> = {
  name: "DeliverToAdPlatform",
  description:
    "Submit a rendered variant for delivery to a specific ad platform. " +
    "Compliance clearance must be present (gated by canUseTool Tier 2) and " +
    "the spend must fit budget (gated by Tier 3 — leader review for over-budget). " +
    "Returns a receipt_id on success.",
  inputSchema: Input,
  shouldDefer: false,
  alwaysLoad: true,
  readonly: false,
  microCompactable: false,

  validateInput(input: unknown): In {
    return Input.parse(input);
  },

  async call(input: In, ctx: ToolUseContext) {
    let client: McpClient;
    try {
      client = await resolver(input.platform);
    } catch (e) {
      return {
        ok: false as const,
        error: (e as Error).message,
        retryable: false,
      };
    }
    try {
      const r = await client.callTool("submit", input);
      if (r.isError === true) {
        const text =
          r.content.find((c) => c.type === "text")?.text ??
          "platform rejected delivery";
        return { ok: false as const, error: text, retryable: false };
      }
      // Mock + real platforms both return the receipt as JSON in a text
      // content block.
      const text = r.content.find((c) => c.type === "text")?.text;
      if (text === undefined) {
        return {
          ok: false as const,
          error: "platform response had no text content",
          retryable: false,
        };
      }
      const parsed = Output.parse(JSON.parse(text));

      // Persist a receipt sidecar next to the campaign — recoverable
      // record of "we delivered X for Y." The PerformanceAgent (T2.4)
      // and extractCreativeInsights (T2.3) both read these.
      const receiptPath = storagePaths.deliveryReceipt(
        ctx.brandId as BrandId,
        ctx.campaignId as CampaignId,
        parsed.receipt_id,
      );
      await mkdir(path.dirname(receiptPath), { recursive: true });
      await writeFile(
        receiptPath,
        JSON.stringify({ ...input, ...parsed }, null, 2),
        "utf-8",
      );

      return { ok: true as const, output: parsed };
    } catch (e) {
      return {
        ok: false as const,
        error: (e as Error).message,
        retryable: true,
      };
    } finally {
      await client.close();
    }
  },
};

export const _DeliverToAdPlatformOutputSchema = Output;
// Used by T2.3 to discover delivered batches.
export type DeliveryReceipt = z.infer<typeof Output> & {
  readonly platform: string;
  readonly variant_spec_id: string;
  readonly asset_id: string;
};
