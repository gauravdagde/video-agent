import type { JsonRpcRequest, JsonRpcResponse } from "./Transport.ts";

// Plan §L (T2.1) — minimal MCP server helpers. Two roles:
//   1. Build a JSON-RPC handler from a tool registry (same shape regardless
//      of transport).
//   2. Expose either a stdio main (for `bun run ./mockAdPlatform.ts`) or
//      an HTTP listener (for `bun --hot` style hosting).
//
// Phase-1 scope: enough to power the mock ad-platform server + parity
// tests. No session state, no notifications, no auth.

export interface McpToolHandler {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  call(args: unknown): Promise<{
    readonly content: ReadonlyArray<{
      readonly type: string;
      readonly text?: string;
      readonly data?: unknown;
    }>;
    readonly isError?: boolean;
  }>;
}

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

export function buildHandler(
  info: McpServerInfo,
  tools: readonly McpToolHandler[],
): (req: JsonRpcRequest) => Promise<JsonRpcResponse> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return async (req) => {
    const reply = (result: unknown): JsonRpcResponse => ({
      jsonrpc: "2.0",
      id: req.id,
      result,
    });
    const err = (code: number, message: string): JsonRpcResponse => ({
      jsonrpc: "2.0",
      id: req.id,
      error: { code, message },
    });

    switch (req.method) {
      case "initialize":
        return reply({
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: info,
        });
      case "tools/list":
        return reply({
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case "tools/call": {
        const params = req.params as
          | { name?: string; arguments?: unknown }
          | undefined;
        if (params === undefined || typeof params.name !== "string") {
          return err(-32602, "tools/call requires {name, arguments}");
        }
        const t = byName.get(params.name);
        if (t === undefined) {
          return err(-32601, `unknown tool: ${params.name}`);
        }
        try {
          return reply(await t.call(params.arguments ?? {}));
        } catch (e) {
          return err(-32000, (e as Error).message);
        }
      }
      default:
        return err(-32601, `method not found: ${req.method}`);
    }
  };
}

// Stdio main loop — read framed messages from stdin, write responses to
// stdout. Used by servers run as `bun run ./server.ts` and connected via
// `StdioTransport`.
export async function runStdioServer(
  handler: (req: JsonRpcRequest) => Promise<JsonRpcResponse>,
): Promise<void> {
  let buf = "";
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    while (true) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = buf.slice(0, headerEnd);
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (m === null) {
        buf = buf.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1]!, 10);
      const bodyStart = headerEnd + 4;
      if (buf.length < bodyStart + len) break;
      const body = buf.slice(bodyStart, bodyStart + len);
      buf = buf.slice(bodyStart + len);
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(body) as JsonRpcRequest;
      } catch {
        continue;
      }
      const resp = await handler(req);
      const out = JSON.stringify(resp);
      const framed = `Content-Length: ${Buffer.byteLength(out, "utf-8")}\r\n\r\n${out}`;
      process.stdout.write(framed);
    }
  }
}

// HTTP main — Bun.serve hosting JSON-RPC at POST /mcp. Used by HTTP-mode
// servers and the parity test.
export interface ServeOpts {
  readonly port: number;
  readonly handler: (req: JsonRpcRequest) => Promise<JsonRpcResponse>;
}

export interface RunningHttpServer {
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
}

export function startHttpServer(opts: ServeOpts): RunningHttpServer {
  const server = Bun.serve({
    port: opts.port,
    async fetch(req) {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      let body: JsonRpcRequest;
      try {
        body = (await req.json()) as JsonRpcRequest;
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const resp = await opts.handler(body);
      return new Response(JSON.stringify(resp), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    port: server.port ?? opts.port,
    url: `http://localhost:${server.port ?? opts.port}/mcp`,
    async stop() {
      server.stop();
    },
  };
}
