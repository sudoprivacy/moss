import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { contentDigest, AgentProtocolError } from "./provider/protocol.js";
import type { NexusHttpModelExchange } from "./provider/nexusModelExecutor.js";
import type {
  ModelExecutionContext,
  NexusModelTarget,
} from "./provider/runtime.js";

const BODY_LIMIT = 256000,
  RESPONSE_LIMIT = 2 * 1024 * 1024;
const unavailable = () =>
  new AgentProtocolError(503, "MODEL_RELAY_UNAVAILABLE");
interface Pending {
  original: Record<string, unknown>;
  signal: AbortSignal;
  lifetime: AbortController;
  forward: (
    body: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<Response>;
  claimed: boolean;
  response?: { status: number; bytes: Buffer };
}

/** Only message text may be rewritten by the Nexus content hook. Routing and limits are immutable. */
function validRewrite(
  original: Record<string, unknown>,
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const { messages: expected, ...options } = original;
  const { messages, ...actualOptions } = body;
  if (
    contentDigest(options) !== contentDigest(actualOptions) ||
    !Array.isArray(expected) ||
    !Array.isArray(messages) ||
    expected.length !== messages.length
  )
    return false;
  return messages.every((message, i) => {
    const before = expected[i];
    return (
      message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      Object.keys(message).length === 2 &&
      message.role === before.role &&
      typeof message.content === "string" &&
      message.content.length <= 32000
    );
  });
}
async function readRequest(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw unavailable();
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
}
async function responseBytes(response: Response): Promise<Buffer> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get("content-type") ?? "",
    )
  )
    throw unavailable();
  const reader = response.body?.getReader(),
    chunks: Buffer[] = [];
  let size = 0;
  if (!reader) return Buffer.alloc(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > RESPONSE_LIMIT) throw unavailable();
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

/**
 * Per-instance loopback upstream for llm_mount. The static mount credential is
 * configured in Nexus, never passed through a prompt. Short-lived Router keys
 * exist only in the forward closure. An opaque one-use request ID is the sole
 * prompt header. Restart/lost replies cannot recreate a pending dispatch.
 */
export class NexusModelRelay {
  private readonly pending = new Map<string, Pending>();
  private readonly credential: Buffer;
  private server?: Server;
  private ready = false;
  constructor(
    credential: string,
    private readonly exchange: NexusHttpModelExchange,
  ) {
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(credential)) throw unavailable();
    this.credential = Buffer.from(`Bearer ${credential}`);
  }
  async listen(port = 0): Promise<string> {
    if (this.server) throw unavailable();
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.maxHeadersCount = 16;
    server.timeout = 125000;
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      this.ready = true;
      const address = server.address();
      if (!address || typeof address === "string") throw unavailable();
      return `http://127.0.0.1:${address.port}/v1`;
    } catch (error) {
      this.server = undefined;
      server.close();
      throw error;
    }
  }
  async close(): Promise<void> {
    this.ready = false;
    for (const entry of this.pending.values()) entry.lifetime.abort();
    this.pending.clear();
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  async invoke(
    target: NexusModelTarget,
    body: Record<string, unknown>,
    signal: AbortSignal,
    context: ModelExecutionContext,
    forward: Pending["forward"],
  ): Promise<Response> {
    if (!this.ready || signal.aborted || this.pending.size >= 128)
      throw unavailable();
    // Snapshot invocation data: a caller cannot change limits while the content hook is running.
    const original = JSON.parse(JSON.stringify(body)) as Record<
      string,
      unknown
    >;
    if (
      !validRewrite(original, original) ||
      Buffer.byteLength(JSON.stringify(original)) > BODY_LIMIT
    )
      throw unavailable();
    const lifetime = new AbortController();
    const requestId = randomUUID(),
      entry: Pending = {
        original,
        signal: AbortSignal.any([signal, lifetime.signal]),
        lifetime,
        forward,
        claimed: false,
      };
    this.pending.set(requestId, entry);
    try {
      const response = await this.exchange(
        target,
        structuredClone(original),
        entry.signal,
        context,
        requestId,
      );
      const bytes = await responseBytes(response);
      // An old .reply or an unrelated mount cannot manufacture a completed relay exchange.
      if (
        !entry.response ||
        response.status !== entry.response.status ||
        !bytes.equals(entry.response.bytes)
      )
        throw unavailable();
      return new Response(
        [204, 205, 304].includes(response.status) ? null : bytes,
        {
          status: response.status,
          headers: { "content-type": "application/json" },
        },
      );
    } finally {
      this.pending.delete(requestId);
      lifetime.abort();
    }
  }
  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const send = (status: number, body: string | Buffer) => {
      if (!response.destroyed) {
        response.writeHead(status, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(body);
      }
    };
    try {
      const authorization = Buffer.from(request.headers.authorization ?? "");
      if (
        !this.ready ||
        authorization.length !== this.credential.length ||
        !timingSafeEqual(authorization, this.credential)
      ) {
        send(401, '{"error":"MODEL_RELAY_UNAUTHORIZED"}');
        return;
      }
      if (
        request.method !== "POST" ||
        request.url !== "/v1/chat/completions" ||
        !/^application\/json(?:\s*;|$)/i.test(
          request.headers["content-type"] ?? "",
        ) ||
        (request.headers["content-encoding"] &&
          request.headers["content-encoding"] !== "identity")
      ) {
        send(400, '{"error":"MODEL_RELAY_INVALID_REQUEST"}');
        return;
      }
      const id = request.headers["x-request-id"];
      const entry = typeof id === "string" ? this.pending.get(id) : undefined;
      if (!entry || entry.claimed || entry.signal.aborted) {
        send(409, '{"error":"MODEL_RELAY_REQUEST_UNAVAILABLE"}');
        return;
      }
      // Claim before the first await: two connections can never dispatch the same model call.
      entry.claimed = true;
      const body = await readRequest(request);
      if (
        !validRewrite(entry.original, body) ||
        this.pending.get(String(id)) !== entry ||
        entry.signal.aborted ||
        !this.ready
      ) {
        send(403, '{"error":"MODEL_RELAY_REWRITE_DENIED"}');
        return;
      }
      const disconnected = new AbortController();
      const abort = () => disconnected.abort();
      response.once("close", abort);
      try {
        const upstream = await entry.forward(
          body,
          AbortSignal.any([entry.signal, disconnected.signal]),
        );
        const bytes = await responseBytes(upstream);
        entry.response = { status: upstream.status, bytes };
        send(upstream.status, bytes);
      } finally {
        response.removeListener("close", abort);
      }
    } catch {
      // Never serialize model bodies, IAM/Router credentials, or transport diagnostics.
      send(502, '{"error":"MODEL_RELAY_UNCONFIRMED"}');
    }
  }
}
