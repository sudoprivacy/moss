import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { SqliteDriver } from "../db/driver.js";
import { ExternalProviderError } from "../externalProviders/policy.js";
import type {
  ExecutionGrant,
  CheckExecutionGrant,
  AssetRecord,
} from "../../../contracts/agent-registry/v1alpha1/contract.gen.js";
import { ExecutionModelGateway } from "./executionModelGateway.js";
import { NexusModelRelay } from "./nexusModelRelay.js";
import { AgentRouterClient } from "./routerAgentClient.js";

async function setup(t: TestContext, contentPath = false) {
  const db = new SqliteDriver(new DatabaseSync(":memory:"));
  t.after(() => db.close());
  const digest = "sha256:" + "a".repeat(64),
    token = "sk-synthetic-iam-only";
  const grant: ExecutionGrant = {
    id: "grant-a",
    zone: "zone-a",
    issuer: "user:admin",
    worker_id: "worker-a",
    key_id: "iam-key-a",
    delegation_id: "delegation-a",
    owner_user_id: "owner-a",
    department_id: "department-a",
    status: "active",
    cleanup_pending: false,
    created_at: Date.now(),
    expires_at: Date.now() + 120000,
    request: {
      request_id: "request-a",
      asset_id: "asset-a",
      metadata_digest: digest,
      spec_digest: digest,
      task_id: "task-a",
      initiated_by: "user-a",
      mode: "evaluation",
      dataset_digest: digest,
      permissions: [{ operation: "model.invoke", resource: "model-a" }],
      ttl_seconds: 120,
      max_model_calls: 2,
    },
  };
  const state = {
    checks: 0,
    issued: 0,
    models: 0,
    denySecond: false,
    denyThird: false,
    redact: false,
    prompts: [] as string[],
    modelFailure: false,
    issueAmbiguous: false,
    disableFailure: false,
    wrongLedger: false,
    noLedger: false,
    metadataChanged: false,
    metadataUnavailable: false,
  };
  const tokens = new Map<number, any>();
  const router = new AgentRouterClient({
    baseUrl: "http://127.0.0.1:12345",
    accountId: 1,
    quotaPerCall: 25000,
    group: "default",
    getConsoleToken: async () => "synthetic-console-only",
    request: async (input, init) => {
      const url = new URL(String(input)),
        body = init?.body ? JSON.parse(String(init.body)) : null;
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer synthetic-console-only",
      );
      if (url.pathname === "/api/token/" && init?.method === "POST") {
        assert.equal(body.unlimited_quota, false);
        assert.equal(body.model_limits_enabled, true);
        assert.equal(body.model_limits, "test-model");
        const id = ++state.issued,
          item = { ...body, id, user_id: 1, key: "x".repeat(48), status: 1 };
        tokens.set(id, item);
        if (state.issueAmbiguous) throw new Error("synthetic-private-outage");
        return Response.json({ success: true, data: item });
      }
      if (url.pathname === "/api/token/" && init?.method === "PUT") {
        if (state.disableFailure) throw new Error("synthetic-private-outage");
        tokens.get(body.id).status = 2;
        return Response.json({ success: true });
      }
      if (url.pathname === "/api/token/search") {
        const items = [...tokens.values()].filter(
          (item) => item.name === url.searchParams.get("keyword"),
        );
        return Response.json({
          success: true,
          data: { items, total: items.length },
        });
      }
      if (/^\/api\/token\/\d+$/.test(url.pathname))
        return Response.json({
          success: true,
          data: tokens.get(Number(url.pathname.split("/").at(-1))),
        });
      if (url.pathname === "/api/log/") {
        const item = [...tokens.values()].find(
          (item) => item.name === url.searchParams.get("token_name"),
        )!;
        const items = state.noLedger
          ? []
          : [
              {
                id: item.id,
                user_id: state.wrongLedger ? 2 : 1,
                token_id: item.id,
                token_name: item.name,
                type: 2,
                model_name: "test-model",
                created_at: Math.floor(Date.now() / 1000),
                quota: 7,
                prompt_tokens: 3,
                completion_tokens: 1,
              },
            ];
        return Response.json({
          success: true,
          data: { total: items.length, items },
        });
      }
      throw new Error("Unexpected endpoint");
    },
  });
  const registry = {
    inventoryGet: async (org: string, id: string): Promise<AssetRecord> => {
      assert.equal(org, 'org-a'); assert.equal(id, grant.request.asset_id)
      if (state.metadataUnavailable) throw new Error('owner temporarily unavailable')
      return { id, owner_zone: grant.zone, metadata_digest: state.metadataChanged ? 'sha256:' + 'b'.repeat(64) : grant.request.metadata_digest,
        metadata: { owner_user_id: grant.owner_user_id, department_id: grant.department_id, source_platform: 'dify', name: 'Reviewed name' } } as AssetRecord
    },
    scope: () => ({ zoneId: "zone-a", trustDomain: "agents.example" }),
    executionAuthorize: async (org: string, request: CheckExecutionGrant) => {
      state.checks++;
      if (
        org !== "org-a" ||
        request.token !== token ||
        grant.status !== "active" ||
        request.task_id !== "task-a" ||
        (state.denySecond && state.checks === 2) ||
        (state.denyThird && state.checks === 3)
      )
        throw new ExternalProviderError(401, "EXECUTION_INACTIVE");
      return {
        kind: "ExecutionAuthorization" as const,
        grant,
        authorized_at: Date.now(),
        cacheable: false as const,
      };
    },
  };
  let relayUrl = "";
  const relay = contentPath
    ? new NexusModelRelay(
        "synthetic-mount-" + "x".repeat(32),
        async (_target, body, _signal, _context, requestId) => {
          if (state.redact) (body as any).messages[0].content = "[REDACTED]";
          return fetch(`${relayUrl}/chat/completions`, {
            method: "POST",
            headers: {
              authorization: "Bearer synthetic-mount-" + "x".repeat(32),
              "content-type": "application/json",
              "x-request-id": requestId!,
            },
            body: JSON.stringify(body),
          });
        },
      )
    : undefined;
  if (relay) {
    relayUrl = await relay.listen();
    t.after(() => relay.close());
  }
  const gateway = new ExecutionModelGateway(db, registry, [
    {
      orgId: "org-a",
      id: "model-a",
      model: "test-model",
      endpoint: "http://127.0.0.1:12345/v1",
      maxOutputTokens: 64,
      router,
      ...(relay
        ? {
            contentPath: {
              relay,
              target: {
                nexus_endpoint: "https://nexus.example",
                model_mount: "/model",
              },
            },
          }
        : {}),
      request: async (_input, init) => {
        state.models++;
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer sk-" + "x".repeat(48),
        );
        const body = JSON.parse(String(init?.body));
        state.prompts.push(body.messages[0].content);
        assert.equal(body.model, "test-model");
        assert.equal(body.stream, false);
        if (state.modelFailure)
          throw new Error("synthetic-private-network-error");
        return Response.json({
          choices: [{ finish_reason: "stop", message: { content: "42" } }],
        });
      },
    },
  ]);
  const body = {
    call_id: randomUUID(),
    grant_id: grant.id,
    task_id: grant.request.task_id,
    spec_digest: digest,
    resource: "model-a",
    input: {
      messages: [{ role: "user", content: "private prompt" }],
      max_tokens: 32,
    },
  };
  await gateway.ready;
  return { db, gateway, state, body, token, grant, router, tokens };
}

void test('model usage captures matching owner metadata and Router authority once; changed/missing metadata stays unknown', async t => {
  const first = await setup(t)
  const call = await first.gateway.invoke('org-a', first.body, first.token)
  assert.equal(call.routerAuthorityId, first.router.authorityId)
  assert.deepEqual(call.attribution, { metadataDigest: first.grant.request.metadata_digest, sourcePlatform: 'dify', assetName: 'Reviewed name' })
  first.state.metadataChanged = true
  assert.deepEqual((await first.gateway.invoke('org-a', first.body, first.token)).attribution, call.attribution, 'replay cannot rewrite historical attribution')
  for (const field of ['metadataChanged', 'metadataUnavailable'] as const) {
    const env = await setup(t); env.state[field] = true
    const missing = await env.gateway.invoke('org-a', env.body, env.token)
    assert.equal(missing.status, 'completed'); assert.equal(missing.attribution, undefined)
  }
})

void test("scoped model gateway persists attribution without secrets and never redispatches replay", async (t) => {
  const f = await setup(t),
    result = await f.gateway.invoke("org-a", f.body, f.token);
  assert.equal(result.status, "completed");
  assert.equal(result.answer, "42");
  assert.equal(result.ledgerStatus, "router_verified");
  assert.equal(result.ownerUserId, "owner-a");
  assert.equal(result.departmentId, "department-a");
  assert.equal(
    (await f.gateway.invoke("org-a", f.body, f.token)).id,
    result.id,
  );
  assert.equal(f.state.issued, 1);
  assert.equal(f.state.models, 1);
  const row = await f.db.get("SELECT document FROM agent_model_calls");
  for (const secret of [
    f.token,
    "x".repeat(48),
    "private prompt",
    "synthetic-console-only",
  ])
    assert.ok(!String(row!.document).includes(secret));
  f.grant.status = "revoked";
  await assert.rejects(
    f.gateway.invoke("org-a", { ...f.body, call_id: randomUUID() }, f.token),
    /EXECUTION_INACTIVE/,
  );
  assert.equal(f.state.models, 1);
});
void test("concurrent calls consume the durable grant count once and obey its maximum", async (t) => {
  const f = await setup(t);
  const results = await Promise.allSettled(
    [1, 2, 3, 4].map(() =>
      f.gateway.invoke("org-a", { ...f.body, call_id: randomUUID() }, f.token),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  for (const r of results)
    if (r.status === "rejected")
      assert.equal(r.reason.code, "EXECUTION_CALL_LIMIT_EXHAUSTED");
  assert.equal(f.state.issued, 2);
  assert.equal(f.state.models, 2);
  assert.equal(
    (await f.db.get("SELECT reserved FROM agent_model_grant_limits"))?.reserved,
    2,
  );
});
void test("revocation after token issue denies dispatch and cleans Router token", async (t) => {
  const f = await setup(t);
  f.state.denySecond = true;
  const result = await f.gateway.invoke("org-a", f.body, f.token);
  assert.equal(result.status, "rejected");
  assert.equal(f.state.models, 0);
  assert.equal(result.tokenCleanupPending, false);
});
void test("model ambiguity is durable and does not become success or a automatic retry", async (t) => {
  const f = await setup(t);
  f.state.modelFailure = true;
  f.state.noLedger = true;
  const result = await f.gateway.invoke("org-a", f.body, f.token);
  assert.equal(result.status, "unknown");
  assert.equal(result.ledgerStatus, "pending");
  assert.deepEqual(result.consumption, []);
  assert.ok(
    !JSON.stringify(result).includes("synthetic-private-network-error"),
  );
  await f.gateway.invoke("org-a", f.body, f.token);
  assert.equal(f.state.models, 1);
});
void test("ambiguous Router token creation recovers metadata and revokes without repeating create", async (t) => {
  const f = await setup(t);
  f.state.issueAmbiguous = true;
  const result = await f.gateway.invoke("org-a", f.body, f.token);
  assert.equal(result.status, "rejected");
  assert.equal(result.tokenCleanupPending, true);
  assert.equal(f.state.models, 0);
  const cleaned = await f.gateway.reconcile("org-a", result.id);
  assert.equal(cleaned.tokenCleanupPending, false);
  assert.equal(cleaned.status, "rejected");
  assert.equal(f.tokens.get(1).status, 2);
  assert.equal(f.state.issued, 1);
});
void test("cleanup outage and foreign ledger identities remain explicit and retryable", async (t) => {
  const f = await setup(t);
  f.state.disableFailure = true;
  f.state.wrongLedger = true;
  const result = await f.gateway.invoke("org-a", f.body, f.token);
  assert.equal(result.status, "completed");
  assert.equal(result.tokenCleanupPending, true);
  assert.equal(result.ledgerStatus, "pending");
  f.state.disableFailure = false;
  f.state.wrongLedger = false;
  const reconciled = await f.gateway.reconcile("org-a", result.id);
  assert.equal(reconciled.ledgerStatus, "router_verified");
  assert.equal(reconciled.tokenCleanupPending, false);
  await assert.rejects(
    f.gateway.reconcile("foreign-org", result.id),
    /MODEL_CALL_NOT_FOUND/,
  );
});
void test("invocation rejects forged attribution, arbitrary endpoints, tools and model options", async (t) => {
  const f = await setup(t);
  for (const body of [
    { ...f.body, ownerUserId: "forged" },
    { ...f.body, resource: "http://foreign" },
    { ...f.body, input: { ...f.body.input, model: "expensive" } },
    { ...f.body, input: { ...f.body.input, max_tokens: 65 } },
    { ...f.body, input: { ...f.body.input, tools: [] } },
  ])
    await assert.rejects(f.gateway.invoke("org-a", body, f.token));
  assert.equal(f.state.models, 0);
  assert.equal(f.state.issued, 0);
});
void test("production runs cannot bypass the existing Nexus content-enforced model path", async (t) => {
  const f = await setup(t);
  f.grant.request.mode = "run";
  await assert.rejects(
    f.gateway.invoke("org-a", f.body, f.token),
    /MODEL_CONTENT_PATH_NOT_CONFIGURED/,
  );
  assert.equal(f.state.issued, 0);
  assert.equal(f.state.models, 0);
});

void test("production content path preserves redaction and rechecks IAM immediately before Router", async (t) => {
  const f = await setup(t, true);
  f.grant.request.mode = "run";
  f.state.redact = true;
  const result = await f.gateway.invoke("org-a", f.body, f.token);
  assert.equal(result.status, "completed");
  assert.equal(f.state.checks, 3);
  assert.deepEqual(f.state.prompts, ["[REDACTED]"]);
  assert.equal(result.ledgerStatus, "router_verified");
});
void test("revocation while content inspection runs blocks production dispatch and replay", async (t) => {
  const f = await setup(t, true);
  f.grant.request.mode = "run";
  f.state.denyThird = true;
  const result = await f.gateway.invoke("org-a", f.body, f.token);
  assert.equal(result.status, "rejected");
  assert.equal(result.error, "EXECUTION_INACTIVE");
  assert.equal(f.state.models, 0);
  assert.equal(result.tokenCleanupPending, false);
  await f.gateway.invoke("org-a", f.body, f.token);
  assert.equal(f.state.issued, 1);
  assert.equal(f.state.models, 0);
});

void test('suspension during delayed Router token creation stays pending until the late token is disabled', async t => {
  const f = await setup(t)
  let release!: () => void, started!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const begun = new Promise<void>(resolve => { started = resolve })
  const original = f.router.issue.bind(f.router)
  f.router.issue = async (...args) => { started(); await waiting; return original(...args) }
  const invocation = f.gateway.invoke('org-a', f.body, f.token)
  await begun
  await f.db.run('UPDATE agent_asset_gates SET operation_id = ? WHERE org_id = ? AND asset_id = ?', ['suspension-a', 'org-a', 'asset-a'])
  const stopped = await f.gateway.suspendAsset('org-a', 'asset-a')
  assert.equal(stopped.pending, 1)
  assert.equal(f.state.issued, 0)
  release()
  const result = await invocation
  assert.equal(result.status, 'unknown')
  assert.equal(f.state.models, 0)
  assert.equal(f.state.issued, 1)
  assert.equal([...f.tokens.values()][0].status, 2)
  assert.equal((await f.gateway.suspendAsset('org-a', 'asset-a')).pending, 0)
  await assert.rejects(f.gateway.invoke('org-a', { ...f.body, call_id: randomUUID() }, f.token), /AGENT_SUSPENSION_ACTIVE/)
  assert.equal(f.state.issued, 1)
})
void test('suspension recovers an already-created token when its response is still in flight', async t => {
  const f = await setup(t)
  let release!: () => void, started!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const begun = new Promise<void>(resolve => { started = resolve })
  const original = f.router.issue.bind(f.router)
  f.router.issue = async (...args) => { const issued = await original(...args); started(); await waiting; return issued }
  const invocation = f.gateway.invoke('org-a', f.body, f.token)
  await begun
  await f.db.run('UPDATE agent_asset_gates SET operation_id = ? WHERE org_id = ? AND asset_id = ?', ['suspension-a', 'org-a', 'asset-a'])
  const stopped = await f.gateway.suspendAsset('org-a', 'asset-a')
  assert.equal(stopped.pending, 0)
  assert.equal([...f.tokens.values()][0].status, 2)
  release(); await invocation
  assert.equal(f.state.models, 0)
  assert.equal((await f.gateway.suspendAsset('org-a', 'asset-a')).pending, 0)
})

void test('task cleanup finds arbitrary call IDs, isolates tenants and disables before expiry even if another call fails', async t => {
  const f = await setup(t)
  f.state.disableFailure = true
  const first = await f.gateway.invoke('org-a', f.body, f.token)
  const second = await f.gateway.invoke('org-a', { ...f.body, call_id: 'provider-chosen-sequence' }, f.token)
  assert.deepEqual((await f.gateway.taskCalls('org-a', 'task-a')).map(c => c.id).sort(), [first.id, second.id].sort())
  assert.equal((await f.gateway.taskCalls('org-b', 'task-a')).length, 0)
  assert.equal((await f.gateway.stopTaskCalls('org-a', 'task-a')).pending, 2)
  f.state.disableFailure = false
  const result = await f.gateway.stopTaskCalls('org-a', 'task-a')
  assert.deepEqual(result, { calls: 2, pending: 0 })
  assert.equal(f.state.models, 2)
  assert([...f.tokens.values()].every(token => token.status === 2))
})
