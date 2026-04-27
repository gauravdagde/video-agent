import {
  McpError,
  nextRequestId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type Transport,
} from "./Transport.ts";

// JSON-RPC over HTTP POST. Real ad-platform integrations target this —
// they expose `/mcp` endpoints under their authenticated APIs. Phase-1
// supports a minimal subset: POST to one URL, JSON-RPC body, JSON-RPC
// response.

export interface HttpTransportOpts {
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly callTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class HttpTransport implements Transport {
  private callTimeoutMs: number;
  private fetchFn: typeof globalThis.fetch;

  constructor(private opts: HttpTransportOpts) {
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: nextRequestId(),
      method,
      params,
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.callTimeoutMs);
    let resp: Response;
    try {
      resp = await this.fetchFn(this.opts.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.opts.headers ?? {}) },
        body: JSON.stringify(req),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if ((e as { name?: string }).name === "AbortError") {
        throw new McpError(
          -32000,
          `HTTP RPC timed out after ${this.callTimeoutMs}ms: ${method}`,
        );
      }
      throw new McpError(
        -32001,
        `HTTP transport error: ${(e as Error).message}`,
      );
    }
    clearTimeout(timer);
    if (!resp.ok) {
      throw new McpError(-32002, `HTTP ${resp.status}: ${resp.statusText}`);
    }
    const parsed = (await resp.json()) as JsonRpcResponse;
    if (parsed.error !== undefined) {
      throw new McpError(
        parsed.error.code,
        parsed.error.message,
        parsed.error.data,
      );
    }
    return parsed.result;
  }

  async close(): Promise<void> {
    // Stateless transport — nothing to clean up.
  }
}
