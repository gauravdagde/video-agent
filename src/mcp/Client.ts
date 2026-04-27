import { HttpTransport, type HttpTransportOpts } from "./HttpTransport.ts";
import { StdioTransport, type StdioTransportOpts } from "./StdioTransport.ts";
import type { Transport } from "./Transport.ts";

// Plan §L (T2.1) — minimal MCP client. Phase-1 subset: initialize
// handshake, tools/list, tools/call. Session lifecycle (notifications,
// cancellation, server-initiated requests) is out of scope.

export type McpClientConfig =
  | { readonly transport: "stdio"; readonly opts: StdioTransportOpts }
  | { readonly transport: "http"; readonly opts: HttpTransportOpts };

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

export interface McpToolCallResult {
  readonly content: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
    readonly data?: unknown;
  }>;
  readonly isError?: boolean;
}

export class McpClient {
  private constructor(private transport: Transport) {}

  static async connect(cfg: McpClientConfig): Promise<McpClient> {
    let transport: Transport;
    if (cfg.transport === "stdio") {
      const t = new StdioTransport(cfg.opts);
      await t.start();
      transport = t;
    } else {
      transport = new HttpTransport(cfg.opts);
    }
    const client = new McpClient(transport);
    await client.initialize();
    return client;
  }

  private async initialize(): Promise<void> {
    await this.transport.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "video-agent", version: "0.0.1" },
    });
  }

  async listTools(): Promise<readonly McpToolDescriptor[]> {
    const r = (await this.transport.call("tools/list")) as {
      tools?: McpToolDescriptor[];
    };
    return r.tools ?? [];
  }

  async callTool(
    name: string,
    args: unknown,
  ): Promise<McpToolCallResult> {
    return (await this.transport.call("tools/call", {
      name,
      arguments: args,
    })) as McpToolCallResult;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
