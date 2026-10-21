import { randomUUID } from "node:crypto";
import {
  NexusWriteRejected,
  type NexusWriteReceipt,
} from "./provider/nexusWriteRejection.js";
import type { NexusModelRelay } from "./nexusModelRelay.js";
import type { NexusModelTarget } from "./provider/runtime.js";
import type { ExecutionGrant } from "../../../contracts/agent-registry/v1alpha1/contract.gen.js";
import type { DbDriver } from "../db/driver.js";
import { ExternalProviderError } from "../externalProviders/policy.js";
import { contentDigest } from "./provider/protocol.js";
import { boundedJson, modelAnswer } from "./provider/runtime.js";
import {
  routerTransport,
  type RouterRequest,
} from "./provider/routerTransport.js";
import type { ProductRegistryClient } from "./registryClient.js";
import {
  AgentRouterClient,
  type AgentRouterToken,
  type RouterConsumption,
} from "./routerAgentClient.js";

export interface ExecutionModelResource {
  orgId: string;
  id: string;
  model: string;
  endpoint: string;
  maxOutputTokens: number;
  router: AgentRouterClient;
  request?: RouterRequest;
  allowedAddresses?: readonly string[];
  contentPath?: { relay: NexusModelRelay; target: NexusModelTarget };
}
interface ModelInput {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  max_tokens: number;
  temperature?: number;
}
interface ModelCallInput {
  call_id: string;
  grant_id: string;
  task_id: string;
  spec_digest: string;
  resource: string;
  input: ModelInput;
}
export interface ExecutionModelCall {
  id: string;
  callId: string;
  orgId: string;
  grantId: string;
  assetId: string;
  taskId: string;
  specDigest: string;
  grantExpiresAt: number;
  ownerUserId: string;
  departmentId: string | null;
  resource: string;
  model: string;
  mode: "run" | "evaluation";
  status: "preparing" | "dispatching" | "completed" | "rejected" | "unknown";
  createdAt: number;
  updatedAt: number;
  answer?: string;
  error?: string;
  contentRejection?: NexusWriteReceipt;
  routerToken?: AgentRouterToken;
  tokenCleanupPending: boolean;
  ledgerStatus: "pending" | "router_verified";
  consumption: RouterConsumption[];
}
function fail(code: string, status = 400): never {
  throw new ExternalProviderError(status, code);
}
const identifier = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,149}$/.test(value);
function object(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    fail("INVALID_MODEL_CALL");
  return value as Record<string, unknown>;
}
function parse(
  value: unknown,
  resource: ExecutionModelResource,
): ModelCallInput {
  const body = object(value, [
    "call_id",
    "grant_id",
    "task_id",
    "spec_digest",
    "resource",
    "input",
  ]);
  if (
    ![body.call_id, body.grant_id, body.task_id].every(identifier) ||
    typeof body.spec_digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(body.spec_digest) ||
    body.resource !== resource.id
  )
    fail("INVALID_MODEL_CALL");
  const input = object(body.input, ["messages", "max_tokens", "temperature"]);
  if (
    !Array.isArray(input.messages) ||
    !input.messages.length ||
    input.messages.length > 64 ||
    !Number.isSafeInteger(input.max_tokens) ||
    Number(input.max_tokens) < 1 ||
    Number(input.max_tokens) > resource.maxOutputTokens ||
    (input.temperature !== undefined &&
      (typeof input.temperature !== "number" ||
        !Number.isFinite(input.temperature) ||
        input.temperature < 0 ||
        input.temperature > 2))
  )
    fail("INVALID_MODEL_CALL");
  for (const message of input.messages) {
    const m = object(message, ["role", "content"]);
    if (
      !["system", "user", "assistant"].includes(String(m.role)) ||
      typeof m.content !== "string" ||
      m.content.length > 32000
    )
      fail("INVALID_MODEL_CALL");
  }
  if (Buffer.byteLength(JSON.stringify(body)) > 256000)
    fail("MODEL_CALL_TOO_LARGE", 413);
  return body as unknown as ModelCallInput;
}

/** Durable model side-effect gateway. No browser identities, direct model keys or cost estimates. */
export class ExecutionModelGateway {
  readonly ready: Promise<void>;
  private readonly resources = new Map<string, ExecutionModelResource>();
  constructor(
    private readonly db: DbDriver,
    private readonly registry: Pick<
      ProductRegistryClient,
      "scope" | "executionAuthorize"
    >,
    resources: ExecutionModelResource[],
  ) {
    for (const resource of resources) {
      const key = JSON.stringify([resource.orgId, resource.id]);
      if (
        this.resources.has(key) ||
        !identifier(resource.orgId) ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,499}$/.test(resource.id) ||
        !Number.isSafeInteger(resource.maxOutputTokens) ||
        resource.maxOutputTokens < 1 ||
        resource.maxOutputTokens > 4096
      )
        fail("MODEL_RESOURCE_CONFIGURATION_INVALID", 500);
      registry.scope(resource.orgId);
      this.resources.set(key, {
        ...resource,
        request:
          resource.request ??
          routerTransport(resource.endpoint, {
            allowedAddresses: resource.allowedAddresses,
          }),
      });
    }
    this.ready = db.exec(`CREATE TABLE IF NOT EXISTS agent_model_calls (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, call_id TEXT NOT NULL, grant_id TEXT NOT NULL,
      request_digest TEXT NOT NULL, document TEXT NOT NULL, UNIQUE(org_id, call_id)
    ); CREATE INDEX IF NOT EXISTS agent_model_calls_grant ON agent_model_calls(org_id, grant_id);
    CREATE TABLE IF NOT EXISTS agent_model_grant_limits (
      org_id TEXT NOT NULL, grant_id TEXT NOT NULL, reserved INTEGER NOT NULL,
      PRIMARY KEY(org_id, grant_id)
    );`);
  }
  private resource(orgId: string, id: string) {
    const resource = this.resources.get(JSON.stringify([orgId, id]));
    if (!resource) fail("MODEL_RESOURCE_UNAVAILABLE", 403);
    return resource;
  }
  private async save(call: ExecutionModelCall) {
    await this.db.transaction(async () => {
      // Serialize competing completion/reconciliation writers on the same call.
      await this.db.run(
        "UPDATE agent_model_calls SET document = document WHERE id = ? AND org_id = ?",
        [call.id, call.orgId],
      );
      const row = await this.db.get(
        "SELECT document FROM agent_model_calls WHERE id = ? AND org_id = ?",
        [call.id, call.orgId],
      );
      if (!row) fail("MODEL_CALL_NOT_FOUND", 404);
      const previous = JSON.parse(String(row.document)) as ExecutionModelCall;
      if (
        ["completed", "unknown", "rejected"].includes(previous.status) &&
        previous.status !== call.status
      ) {
        call.status = previous.status;
        call.answer = previous.answer;
        call.error = previous.error;
      }
      if (previous.routerToken && !previous.tokenCleanupPending)
        call.tokenCleanupPending = false;
      if (
        previous.ledgerStatus === "router_verified" &&
        call.ledgerStatus === "pending"
      ) {
        call.ledgerStatus = previous.ledgerStatus;
        call.consumption = previous.consumption;
      }
      call.updatedAt = Date.now();
      await this.db.run(
        "UPDATE agent_model_calls SET document = ? WHERE id = ? AND org_id = ?",
        [JSON.stringify(call), call.id, call.orgId],
      );
    });
  }
  private authorize(orgId: string, body: ModelCallInput, token: string) {
    return this.registry.executionAuthorize(orgId, {
      grant_id: body.grant_id,
      task_id: body.task_id,
      spec_digest: body.spec_digest,
      permission: { operation: "model.invoke", resource: body.resource },
      token,
    });
  }
  private async reserve(
    orgId: string,
    body: ModelCallInput,
    grant: ExecutionGrant,
    resource: ExecutionModelResource,
  ) {
    const fingerprint = contentDigest(body);
    const call: ExecutionModelCall = {
      id: randomUUID(),
      callId: body.call_id,
      orgId,
      grantId: grant.id,
      assetId: grant.request.asset_id,
      taskId: grant.request.task_id,
      specDigest: grant.request.spec_digest,
      ownerUserId: grant.owner_user_id,
      departmentId: grant.department_id,
      grantExpiresAt: grant.expires_at,
      resource: resource.id,
      model: resource.model,
      mode: grant.request.mode,
      status: "preparing",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tokenCleanupPending: false,
      ledgerStatus: "pending",
      consumption: [],
    };
    return this.db.transaction(async () => {
      await this.db.run(
        "INSERT INTO agent_model_calls(id, org_id, call_id, grant_id, request_digest, document) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(org_id, call_id) DO NOTHING",
        [
          call.id,
          orgId,
          body.call_id,
          grant.id,
          fingerprint,
          JSON.stringify(call),
        ],
      );
      const row = await this.db.get(
        "SELECT * FROM agent_model_calls WHERE org_id = ? AND call_id = ?",
        [orgId, body.call_id],
      );
      if (
        !row ||
        row.request_digest !== fingerprint ||
        row.grant_id !== grant.id
      )
        fail("MODEL_CALL_CONFLICT", 409);
      if (row.id === call.id) {
        const limit = grant.request.max_model_calls;
        if (!Number.isSafeInteger(limit) || !limit || limit < 1 || limit > 32)
          fail("EXECUTION_CALL_LIMIT_INVALID", 503);
        await this.db.run(
          "INSERT INTO agent_model_grant_limits(org_id, grant_id, reserved) VALUES (?, ?, 0) ON CONFLICT(org_id, grant_id) DO NOTHING",
          [orgId, grant.id],
        );
        const changed = await this.db.run(
          "UPDATE agent_model_grant_limits SET reserved = reserved + 1 WHERE org_id = ? AND grant_id = ? AND reserved < ?",
          [orgId, grant.id, limit],
        );
        if (!changed) fail("EXECUTION_CALL_LIMIT_EXHAUSTED", 429);
      }
      return {
        created: row.id === call.id,
        call: JSON.parse(String(row.document)) as ExecutionModelCall,
      };
    });
  }
  async invoke(
    orgId: string,
    value: unknown,
    token: string,
    cancellation?: AbortSignal,
  ): Promise<ExecutionModelCall> {
    await this.ready;
    if (cancellation?.aborted) fail("EXECUTION_CANCELLED", 409);
    if (!token || token.length > 8192 || /[\r\n]/.test(token))
      fail("EXECUTION_TOKEN_INVALID", 401);
    const fields = object(value, [
      "call_id",
      "grant_id",
      "task_id",
      "spec_digest",
      "resource",
      "input",
    ]);
    const resource = this.resource(orgId, String(fields.resource)),
      body = parse(value, resource);
    const auth = await this.authorize(orgId, body, token);
    // Production calls must traverse Nexus; evaluation can explicitly use the
    // isolated direct path to establish a pre-migration baseline.
    if (auth.grant.request.mode !== "evaluation" && !resource.contentPath)
      fail("MODEL_CONTENT_PATH_NOT_CONFIGURED", 503);
    const reservation = await this.reserve(orgId, body, auth.grant, resource),
      call = reservation.call;
    // Replays never dispatch again, including a crash with an unfinished record.
    if (!reservation.created) return call;
    let dispatched = false;
    let dispatchError: unknown;
    try {
      const issued = await resource.router.issue(
        call.id,
        resource.model,
        auth.grant.expires_at,
      );
      call.routerToken = issued.token;
      call.tokenCleanupPending = true;
      await this.save(call);
      const current = await this.authorize(orgId, body, token);
      const remaining =
        Math.min(current.grant.expires_at, issued.token.expiresAt) - Date.now();
      if (remaining <= 0) fail("EXECUTION_EXPIRED", 401);
      call.status = "dispatching";
      await this.save(call);
      const signal = AbortSignal.any([
        AbortSignal.timeout(Math.min(remaining, 120000)),
        ...(cancellation ? [cancellation] : []),
      ]);
      const requestBody = {
        ...body.input,
        model: resource.model,
        stream: false,
      };
      const forward = async (
        approvedBody: Record<string, unknown>,
        dispatchSignal: AbortSignal,
      ) => {
        try {
          // Authorization may change while Nexus evaluates content. Check again
          // immediately before the only Router dispatch; no cached decision.
          const live = await this.authorize(orgId, body, token);
          if (
            Math.min(live.grant.expires_at, issued.token.expiresAt) <=
            Date.now()
          )
            fail("EXECUTION_EXPIRED", 401);
          dispatchSignal.throwIfAborted();
          dispatched = true;
          return await resource.request!(
            `${resource.endpoint}/chat/completions`,
            {
              method: "POST",
              redirect: "error",
              signal: dispatchSignal,
              headers: {
                Authorization: `Bearer ${issued.key}`,
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify(approvedBody),
            },
          );
        } catch (error) {
          dispatchError = error;
          throw error;
        }
      };
      const response = resource.contentPath
        ? await resource.contentPath.relay.invoke(
            resource.contentPath.target,
            requestBody,
            signal,
            { clientId: orgId, providerRunId: call.id },
            forward,
          )
        : await forward(requestBody, signal);
      if (!response.ok) {
        await response.body?.cancel();
        fail("MODEL_EXECUTION_UNCONFIRMED", 502);
      }
      call.answer = modelAnswer(await boundedJson(response, 2 * 1024 * 1024));
      call.status = "completed";
      await this.save(call);
    } catch (error) {
      call.status = dispatched ? "unknown" : "rejected";
      const cause = dispatchError ?? error;
      if (cause instanceof NexusWriteRejected && !dispatched)
        call.contentRejection = cause.receipt;
      call.error =
        cause instanceof ExternalProviderError ||
        cause instanceof NexusWriteRejected
          ? cause.code
          : dispatched
            ? "MODEL_EXECUTION_UNCONFIRMED"
            : "MODEL_PREPARATION_FAILED";
      if (call.error === "ROUTER_MUTATION_UNCONFIRMED")
        call.tokenCleanupPending = true;
      await this.save(call);
    } finally {
      if (call.routerToken) {
        try {
          await resource.router.disable(call.routerToken);
          call.tokenCleanupPending = false;
        } catch {
          call.tokenCleanupPending = true;
        }
        await this.save(call);
      }
    }
    if (call.routerToken && dispatched) {
      try {
        const ledger = await resource.router.consumption(
          call.routerToken,
          Math.floor(call.createdAt / 1000) - 2,
          Math.floor(Date.now() / 1000) + 1,
        );
        call.ledgerStatus = ledger.status;
        call.consumption = ledger.records;
        await this.save(call);
      } catch {
        /* A successful model answer does not prove ledger reconciliation. Keep pending. */
      }
    }
    return call;
  }
  /** Management gateway only; authorization belongs to the enclosing admin route. */
  async reconcile(orgId: string, callId: string): Promise<ExecutionModelCall> {
    await this.ready;
    const row = await this.db.get(
      "SELECT document FROM agent_model_calls WHERE org_id = ? AND id = ?",
      [orgId, callId],
    );
    if (!row) fail("MODEL_CALL_NOT_FOUND", 404);
    const call = JSON.parse(String(row.document)) as ExecutionModelCall,
      resource = this.resource(orgId, call.resource);
    if (call.status === "preparing" || call.status === "dispatching") {
      if (Date.now() <= call.grantExpiresAt + 1000)
        fail("MODEL_CALL_STILL_UNCONFIRMED", 409);
      call.status = "unknown";
      call.error = "MODEL_CALL_INTERRUPTED";
      call.tokenCleanupPending = true;
      await this.save(call);
    }
    if (!call.routerToken && call.tokenCleanupPending) {
      const recovered = await resource.router.recover(
        call.id,
        call.model,
        call.grantExpiresAt,
      );
      if (recovered) call.routerToken = recovered;
      else if (Date.now() > call.grantExpiresAt + 1000)
        call.tokenCleanupPending = false;
      await this.save(call);
    }
    if (call.routerToken) {
      await resource.router.disable(call.routerToken);
      call.tokenCleanupPending = false;
      const ledger = await resource.router.consumption(
        call.routerToken,
        Math.floor(call.createdAt / 1000) - 2,
        Math.min(
          Math.floor(Date.now() / 1000) + 1,
          Math.floor(call.routerToken.expiresAt / 1000) + 120,
        ),
      );
      call.ledgerStatus = ledger.status;
      call.consumption = ledger.records;
      await this.save(call);
    }
    return call;
  }
}
