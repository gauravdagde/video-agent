import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { McpClient } from "./Client.ts";
import { mockHandler, mockSubmitTool } from "./servers/mockAdPlatform.ts";
import { startHttpServer } from "./Server.ts";

const TMP = path.join(
  process.env.TMPDIR ?? "/tmp",
  `video-agent-mcp-${Date.now()}`,
);

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  process.env.VIDEO_AGENT_STORAGE = TMP;
});
afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
  delete process.env.VIDEO_AGENT_STORAGE;
});

describe("MCP — handler shape", () => {
  test("initialize returns the server info", async () => {
    const r = await mockHandler({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    expect(r.error).toBeUndefined();
    const result = r.result as {
      protocolVersion: string;
      serverInfo: { name: string };
    };
    expect(result.serverInfo.name).toBe("mock-ad-platform");
  });

  test("tools/list reports the registered tools", async () => {
    const r = await mockHandler({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const result = r.result as { tools: { name: string }[] };
    expect(result.tools.map((t) => t.name)).toContain("submit");
  });

  test("tools/call submit returns a receipt", async () => {
    const r = await mockHandler({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "submit",
        arguments: {
          platform: "tiktok",
          variant_spec_id: "v1",
          asset_id: "a1",
          output_path: "/tmp/x.mp4",
        },
      },
    });
    const result = r.result as { content: { text: string }[] };
    const text = result.content[0]!.text!;
    const parsed = JSON.parse(text) as { receipt_id: string; status: string };
    expect(parsed.receipt_id.startsWith("mock_")).toBe(true);
    expect(parsed.status).toBe("submitted");
  });

  test("tools/call rejects unknown tool with -32601", async () => {
    const r = await mockHandler({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "nope" },
    });
    expect(r.error?.code).toBe(-32601);
  });

  test("submit with missing fields returns isError", async () => {
    const r = await mockSubmitTool.call({});
    expect(r.isError).toBe(true);
  });
});

describe("MCP — HTTP transport parity", () => {
  let server: { port: number; url: string; stop(): Promise<void> } | null =
    null;

  afterEach(async () => {
    if (server !== null) {
      await server.stop();
      server = null;
    }
  });

  test("HTTP transport: initialize + tools/list + tools/call", async () => {
    server = startHttpServer({ port: 0, handler: mockHandler });
    const client = await McpClient.connect({
      transport: "http",
      opts: { url: server.url },
    });
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("submit");
    const r = await client.callTool("submit", {
      platform: "tiktok",
      variant_spec_id: "v1",
      asset_id: "a1",
      output_path: "/tmp/y.mp4",
    });
    expect(r.isError).toBeUndefined();
    const text = r.content[0]!.text!;
    const parsed = JSON.parse(text) as { status: string };
    expect(parsed.status).toBe("submitted");
    await client.close();
  });

  test("HTTP transport: error responses surface as McpError", async () => {
    server = startHttpServer({ port: 0, handler: mockHandler });
    const client = await McpClient.connect({
      transport: "http",
      opts: { url: server.url },
    });
    await expect(client.callTool("nope", {})).rejects.toThrow();
    await client.close();
  });
});
