import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildHandler,
  type McpToolHandler,
} from "../Server.ts";

// Plan §L (T2.1) — minimal mock ad-platform server. Pretends to deliver
// rendered variants and stores receipts on disk. Real platforms (TikTok,
// Meta, Google) implement the same `submit` interface but route to real
// APIs.

interface SubmitArgs {
  readonly platform?: string;
  readonly variant_spec_id?: string;
  readonly asset_id?: string;
  readonly output_path?: string;
  readonly compliance_check_id?: string;
  readonly estimated_spend?: number;
}

interface SubmitResult {
  readonly receipt_id: string;
  readonly platform: string;
  readonly status: "submitted";
  readonly submitted_at_ms: number;
}

const DEFAULT_RECEIPT_DIR = (): string =>
  path.join(
    process.env.VIDEO_AGENT_STORAGE ?? "./storage",
    ".delivery-receipts",
  );

export const mockSubmitTool: McpToolHandler = {
  name: "submit",
  description:
    "Submit a rendered variant for delivery. Returns a receipt_id once accepted by the (mock) platform.",
  inputSchema: {
    type: "object",
    required: ["platform", "variant_spec_id", "asset_id", "output_path"],
    properties: {
      platform: { type: "string" },
      variant_spec_id: { type: "string" },
      asset_id: { type: "string" },
      output_path: { type: "string" },
      compliance_check_id: { type: "string" },
      estimated_spend: { type: "number" },
    },
  },
  async call(args: unknown) {
    const a = args as SubmitArgs;
    if (
      a.platform === undefined ||
      a.variant_spec_id === undefined ||
      a.asset_id === undefined ||
      a.output_path === undefined
    ) {
      return {
        content: [
          {
            type: "text",
            text: "missing required fields (platform, variant_spec_id, asset_id, output_path)",
          },
        ],
        isError: true,
      };
    }
    const receiptId = `mock_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const result: SubmitResult = {
      receipt_id: receiptId,
      platform: a.platform,
      status: "submitted",
      submitted_at_ms: Date.now(),
    };
    const dir = DEFAULT_RECEIPT_DIR();
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, `${receiptId}.json`),
      JSON.stringify({ ...a, ...result }, null, 2),
      "utf-8",
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  },
};

export const mockHandler = buildHandler(
  { name: "mock-ad-platform", version: "0.0.1" },
  [mockSubmitTool],
);
