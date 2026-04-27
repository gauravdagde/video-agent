// Plan §L (T2.1) — transport abstraction for MCP. Two implementations:
// stdio (child-process, JSON-RPC over stdin/stdout) and HTTP (POST to
// /mcp). Real ad-platform integrations target HTTP; the mock ad platform
// is spawnable via either for parity testing.

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

export interface Transport {
  call(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export class McpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpError";
  }
}

let nextId = 1;
export function nextRequestId(): number {
  return nextId++;
}
