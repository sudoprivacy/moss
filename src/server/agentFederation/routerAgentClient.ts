import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { ExternalProviderError } from "../externalProviders/policy.js";

export interface AgentRouterToken {
  id: number;
  accountId: number;
  name: string;
  model: string;
  expiresAt: number;
  quotaLimit: number;
}
export interface RouterConsumption {
  id: number;
  tokenId: number;
  accountId: number;
  createdAt: number;
  model: string;
  quota: number;
  promptTokens: number;
  completionTokens: number;
}
function fail(code: string, status = 503): never {
  throw new ExternalProviderError(status, code);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("ROUTER_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    fail("ROUTER_RESPONSE_INVALID");
  return Number(value);
}

/** Uses SudoRouter's actual token and ledger authority. Caller supplies no attribution headers. */
export class AgentRouterClient {
  private readonly root: string;
  constructor(
    private readonly options: {
      baseUrl: string;
      accountId: number;
      getConsoleToken: () => Promise<string>;
      quotaPerCall: number;
      group: string;
      request?: (
        url: string,
        init: {
          method: string;
          redirect: "error";
          cache: "no-store";
          signal: AbortSignal;
          headers: Record<string, string>;
          body?: string;
        },
      ) => Promise<Response>;
    },
  ) {
    const url = new URL(options.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol === "http:" &&
        !isIP(url.hostname.replace(/^\[|\]$/g, ""))) ||
      !Number.isSafeInteger(options.accountId) ||
      options.accountId < 1 ||
      !Number.isSafeInteger(options.quotaPerCall) ||
      options.quotaPerCall < 1 ||
      options.quotaPerCall > 500000 ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(options.group) ||
      options.group === "auto"
    )
      fail("ROUTER_CONFIGURATION_INVALID", 500);
    this.root = url.origin;
  }
  private async call(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    const token = await this.options.getConsoleToken();
    if (!token || token.length > 8192 || /[\r\n]/.test(token))
      fail("ROUTER_CREDENTIAL_UNAVAILABLE");
    let response: Response;
    try {
      response = await (this.options.request ?? fetch)(this.root + path, {
        method,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${token}`,
          "New-Api-User": String(this.options.accountId),
          "Content-Type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      fail(
        method === "GET" ? "ROUTER_UNAVAILABLE" : "ROUTER_MUTATION_UNCONFIRMED",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      fail(
        method === "GET" ? "ROUTER_UNAVAILABLE" : "ROUTER_MUTATION_UNCONFIRMED",
      );
    }
    const reader = response.body?.getReader();
    if (!reader) fail("ROUTER_RESPONSE_INVALID");
    const chunks: Uint8Array[] = [];
    let bytes = 0,
      value: Record<string, unknown>;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 2 * 1024 * 1024) fail("ROUTER_RESPONSE_INVALID");
        chunks.push(next.value);
      }
      value = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      fail(
        method === "GET"
          ? "ROUTER_RESPONSE_INVALID"
          : "ROUTER_MUTATION_UNCONFIRMED",
      );
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (value.success !== true) fail("ROUTER_REQUEST_REJECTED", 502);
    return value.data;
  }
  /** Call only once after a durable call reservation. Unknown outcomes must be reconciled, not retried. */
  async issue(
    callId: string,
    model: string,
    expiresAt: number,
  ): Promise<{ token: AgentRouterToken; key: string }> {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,149}$/.test(callId) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,199}$/.test(model) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now() + 1000 ||
      expiresAt > Date.now() + 300000
    )
      fail("INVALID_ROUTER_TOKEN_SCOPE", 400);
    const name = `agent-${createHash("sha256").update(callId).digest("hex").slice(0, 40)}`;
    const expiration = Math.floor(expiresAt / 1000);
    const value = record(
      await this.call("/api/token/", "POST", {
        name,
        expired_time: expiration,
        remain_quota: this.options.quotaPerCall,
        unlimited_quota: false,
        model_limits_enabled: true,
        model_limits: model,
        group: this.options.group,
        cross_group_retry: false,
      }),
    );
    const id = integer(value.id);
    if (
      !id ||
      integer(value.user_id) !== this.options.accountId ||
      value.name !== name ||
      value.expired_time !== expiration ||
      value.unlimited_quota !== false ||
      value.model_limits_enabled !== true ||
      value.model_limits !== model ||
      value.remain_quota !== this.options.quotaPerCall ||
      value.status !== 1 ||
      value.group !== this.options.group ||
      value.cross_group_retry !== false ||
      typeof value.key !== "string" ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(value.key)
    )
      fail("ROUTER_MUTATION_UNCONFIRMED");
    return {
      token: {
        id,
        accountId: this.options.accountId,
        name,
        model,
        expiresAt: expiration * 1000,
        quotaLimit: this.options.quotaPerCall,
      },
      key: `sk-${value.key}`,
    };
  }
  async disable(token: AgentRouterToken): Promise<void> {
    this.check(token);
    await this.call("/api/token/?status_only=true", "PUT", {
      id: token.id,
      status: 2,
    });
    const current = record(await this.call(`/api/token/${token.id}`));
    if (
      current.id !== token.id ||
      current.user_id !== token.accountId ||
      current.name !== token.name ||
      current.status !== 2
    )
      fail("ROUTER_REVOCATION_UNCONFIRMED");
  }
  /** Recover metadata after an ambiguous create response; never recovers a raw key. */
  async recover(
    callId: string,
    model: string,
    expiresAt: number,
  ): Promise<AgentRouterToken | null> {
    if (!identifierForCall(callId)) fail("INVALID_ROUTER_TOKEN_SCOPE", 400);
    const name = `agent-${createHash("sha256").update(callId).digest("hex").slice(0, 40)}`;
    const data = record(
      await this.call(
        `/api/token/search?${new URLSearchParams({ keyword: name, p: "1", page_size: "100" })}`,
      ),
    );
    if (
      !Array.isArray(data.items) ||
      integer(data.total) !== data.items.length ||
      data.items.length > 100
    )
      fail("ROUTER_TOKEN_RECOVERY_INCOMPLETE");
    const matches = data.items.map(record).filter((row) => row.name === name);
    if (matches.length > 1) fail("ROUTER_TOKEN_RECOVERY_AMBIGUOUS");
    if (!matches.length) return null;
    const row = matches[0];
    if (
      row.user_id !== this.options.accountId ||
      row.model_limits !== model ||
      row.model_limits_enabled !== true ||
      row.unlimited_quota !== false ||
      row.expired_time !== Math.floor(expiresAt / 1000) ||
      !integer(row.id)
    )
      fail("ROUTER_TOKEN_RECOVERY_AMBIGUOUS");
    return {
      id: Number(row.id),
      accountId: this.options.accountId,
      name,
      model,
      expiresAt: Number(row.expired_time) * 1000,
      quotaLimit: this.options.quotaPerCall,
    };
  }
  private check(token: AgentRouterToken) {
    if (
      !Number.isSafeInteger(token.id) ||
      token.id < 1 ||
      token.accountId !== this.options.accountId ||
      !/^agent-[a-f0-9]{40}$/.test(token.name)
    )
      fail("INVALID_ROUTER_TOKEN_SCOPE", 400);
  }
  async consumption(
    token: AgentRouterToken,
    fromSec: number,
    toSec: number,
  ): Promise<{
    status: "pending" | "router_verified";
    records: RouterConsumption[];
  }> {
    this.check(token);
    if (
      !Number.isSafeInteger(fromSec) ||
      !Number.isSafeInteger(toSec) ||
      fromSec < 0 ||
      toSec < fromSec ||
      toSec - fromSec > 86400
    )
      fail("INVALID_ROUTER_TIME_SCOPE", 400);
    // /api/log/query returns a user-facing DTO WITHOUT token_id/log id. It cannot
    // establish attribution. Use the actual admin ledger and check every identity.
    const query = new URLSearchParams({
      type: "2",
      token_name: token.name,
      start_timestamp: String(fromSec),
      end_timestamp: String(toSec),
      page_size: "100",
      p: "1",
    });
    const data = record(await this.call(`/api/log/?${query}`));
    const total = integer(data.total);
    if (
      !Array.isArray(data.items) ||
      total > 100 ||
      data.items.length !== total
    )
      fail("ROUTER_LEDGER_INCOMPLETE");
    const records = data.items.map((raw) => {
      const log = record(raw),
        timestamp = integer(log.created_at);
      if (
        log.user_id !== token.accountId ||
        log.token_id !== token.id ||
        log.token_name !== token.name ||
        log.type !== 2 ||
        log.model_name !== token.model ||
        timestamp < fromSec ||
        timestamp > toSec
      )
        fail("ROUTER_LEDGER_SCOPE_MISMATCH");
      return {
        id: integer(log.id),
        tokenId: token.id,
        accountId: token.accountId,
        createdAt: timestamp,
        model: token.model,
        quota: integer(log.quota),
        promptTokens: integer(log.prompt_tokens),
        completionTokens: integer(log.completion_tokens),
      };
    });
    if (
      records.some((r) => !r.id) ||
      new Set(records.map((r) => r.id)).size !== records.length
    )
      fail("ROUTER_LEDGER_INCOMPLETE");
    return { status: records.length ? "router_verified" : "pending", records };
  }
}

function identifierForCall(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,149}$/.test(value);
}
