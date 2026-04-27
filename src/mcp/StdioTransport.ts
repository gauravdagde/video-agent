import {
  McpError,
  nextRequestId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type Transport,
} from "./Transport.ts";

// JSON-RPC over stdio. MCP framing uses Content-Length headers — we
// implement the spec's "headers + JSON body" framing as the canonical
// transport for stdio servers.

export interface StdioTransportOpts {
  readonly command: readonly string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly callTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class StdioTransport implements Transport {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private buffer = "";
  private pending = new Map<
    string | number,
    {
      resolve: (r: unknown) => void;
      reject: (e: Error) => void;
      timer: Timer;
    }
  >();
  private callTimeoutMs: number;
  private readerLoop: Promise<void> | null = null;

  constructor(private opts: StdioTransportOpts) {
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    const [bin, ...args] = this.opts.command;
    if (bin === undefined) {
      throw new Error("StdioTransport: empty command");
    }
    this.proc = Bun.spawn([bin, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: this.opts.env ?? process.env,
      ...(this.opts.cwd !== undefined ? { cwd: this.opts.cwd } : {}),
    });
    this.readerLoop = this.consumeStdout();
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    if (this.proc === null) {
      throw new Error("StdioTransport: call before start");
    }
    const id = nextRequestId();
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const body = JSON.stringify(req);
    const framed = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(-32000, `RPC call timed out after ${this.callTimeoutMs}ms: ${method}`));
      }, this.callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const stdin = this.proc!.stdin;
      if (stdin === null || stdin === undefined) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("StdioTransport: stdin not available"));
        return;
      }
      // Bun stdin is a FileSink-ish; use write().
      (stdin as unknown as { write(d: string): void }).write(framed);
      (stdin as unknown as { flush?(): void }).flush?.();
    });
  }

  async close(): Promise<void> {
    if (this.proc === null) return;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("StdioTransport closed"));
    }
    this.pending.clear();
    this.proc.kill();
    await this.proc.exited;
    this.proc = null;
  }

  private async consumeStdout(): Promise<void> {
    if (this.proc === null) return;
    const stdout = this.proc.stdout as ReadableStream<Uint8Array>;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      try {
        const chunk = await reader.read();
        if (chunk.done) return;
        this.buffer += decoder.decode(chunk.value, { stream: true });
        this.drainFramedMessages();
      } catch {
        return;
      }
    }
  }

  private drainFramedMessages(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd);
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (m === null) {
        // Malformed — drop the bad header and try to recover.
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1]!, 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + len) return; // partial
      const body = this.buffer.slice(bodyStart, bodyStart + len);
      this.buffer = this.buffer.slice(bodyStart + len);
      this.dispatchResponse(body);
    }
  }

  private dispatchResponse(body: string): void {
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(body) as JsonRpcResponse;
    } catch {
      return;
    }
    const entry = this.pending.get(parsed.id);
    if (entry === undefined) return;
    this.pending.delete(parsed.id);
    clearTimeout(entry.timer);
    if (parsed.error !== undefined) {
      entry.reject(
        new McpError(parsed.error.code, parsed.error.message, parsed.error.data),
      );
    } else {
      entry.resolve(parsed.result);
    }
  }
}
