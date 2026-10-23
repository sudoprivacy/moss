import { strict as assert } from "node:assert";
import { test } from "node:test";
import fixture from "../../../contracts/agent-registry/v1alpha1/signed-version.fixture.json" with { type: "json" };
import type {
  ExecutionGrant,
  IssueExecutionGrant,
} from "../../../contracts/agent-registry/v1alpha1/contract.gen.js";
import { ProductRegistryClient } from "./registryClient.js";

const options = {
  endpoint: "http://127.0.0.1:12345",
  token: "gateway-key",
  publicKeys: [fixture.public_key_pem],
  organizations: { org: { trustDomain: "fixture.example", zoneId: "zone-a" } },
};
const permission = {
  operation: "model.invoke" as const,
  resource: "model:lab",
};
const command: IssueExecutionGrant = {
  api_version: "agent-registry.sudo.dev/v1alpha1",
  kind: "IssueExecutionGrant",
  request_id: "request-0001",
  asset_id: "asset-a",
  metadata_digest: fixture.version.digest,
  spec_digest: fixture.version.digest,
  task_id: "task-a",
  initiated_by: "alice",
  mode: "evaluation",
  version: null,
  dataset_digest: fixture.version.digest,
  permissions: [permission],
  ttl_seconds: 120,
  max_model_calls: 8,
};
function grant(): ExecutionGrant {
  return {
    api_version: "agent-registry.sudo.dev/v1alpha1",
    kind: "AgentExecutionGrant",
    id: "grant-a",
    zone: "zone-a",
    issuer: "user:admin",
    request: structuredClone(command),
    worker_id: "worker-a",
    delegation_id: "delegation-a",
    key_id: "key-a",
    owner_user_id: "alice",
    department_id: "support",
    status: "active",
    cleanup_pending: false,
    created_at: Date.now(),
    expires_at: Date.now() + 120_000,
    reason: null,
    stopped_by: null,
    stopped_at: null,
  };
}
void test("execution transport fixes gateway identity, never caches and binds one-time issuance response", async () => {
  let calls = 0;
  const value = grant();
  const client = new ProductRegistryClient({
    ...options,
    request: async (url, init) => {
      calls++;
      assert.equal(
        new URL(url).pathname,
        "/api/v2/product-agents/execution/grants",
      );
      assert.equal(init.headers.Authorization, "Bearer gateway-key");
      assert.equal(init.headers["X-Nexus-Zone-ID"], "zone-a");
      assert.equal(init.redirect, "error");
      assert.equal(init.cache, "no-store");
      return Response.json({
        kind: "ExecutionGrantResult",
        grant: value,
        api_key: calls === 1 ? "sk-synthetic-worker-token-123456" : null,
      });
    },
  });
  assert.ok((await client.executionIssue("org", command)).api_key);
  assert.equal((await client.executionIssue("org", command)).api_key, null);
  value.request.task_id = "foreign-task";
  await assert.rejects(
    client.executionIssue("org", command),
    /EXECUTION_RESPONSE_INVALID/,
  );
});
void test("authorization refuses stale, unbound, cross-zone or reusable decisions", async () => {
  const check = {
    grant_id: "grant-a",
    task_id: "task-a",
    spec_digest: command.spec_digest,
    permission,
    token: "sk-synthetic-worker-token-123456",
  };
  for (const change of [
    (v: any) => {
      v.authorized_at = 1000;
    },
    (v: any) => {
      v.cacheable = true;
    },
    (v: any) => {
      v.grant.zone = "other";
    },
    (v: any) => {
      v.grant.request.task_id = "other";
    },
    (v: any) => {
      v.grant.status = "revoked";
    },
    (v: any) => {
      v.grant.request.permissions = [];
    },
    (v: any) => {
      v.grant.expires_at = v.grant.created_at + 301000;
    },
  ]) {
    const value = {
      kind: "ExecutionAuthorization",
      grant: grant(),
      authorized_at: Date.now(),
      cacheable: false,
    };
    change(value);
    const client = new ProductRegistryClient({
      ...options,
      request: async () => Response.json(value),
    });
    await assert.rejects(
      client.executionAuthorize("org", check),
      /EXECUTION_RESPONSE_INVALID/,
    );
  }
  const client = new ProductRegistryClient({
    ...options,
    request: async (url, init) => {
      assert.ok(!url.includes(check.token));
      assert.equal(JSON.parse(init.body!).token, check.token);
      return Response.json({
        kind: "ExecutionAuthorization",
        grant: grant(),
        authorized_at: Date.now(),
        cacheable: false,
      });
    },
  });
  assert.equal(
    (await client.executionAuthorize("org", check)).cacheable,
    false,
  );
});
void test("execution failures are normalized and cleanup pending remains visible", async () => {
  const denied = new ProductRegistryClient({
    ...options,
    request: async () =>
      Response.json(
        { detail: { code: "EXECUTION_TOKEN_INVALID" } },
        { status: 401 },
      ),
  });
  await assert.rejects(denied.executionGet("org", "grant-a"), {
    status: 401,
    code: "EXECUTION_TOKEN_INVALID",
  });
  const value = { ...grant(), status: "revoked", cleanup_pending: true };
  const client = new ProductRegistryClient({
    ...options,
    request: async () => Response.json(value),
  });
  assert.equal(
    (await client.executionRevoke("org", "grant-a")).cleanup_pending,
    true,
  );
});

void test('request revocation validates durable fence scope and cleanup across credential rotation', async () => {
  const response = { kind: 'ExecutionRequestRevocation', zone: 'zone-a', request_id: command.request_id,
    task_id: command.task_id, fenced_at: Date.now(), stopped_by: 'user:rotated', grants: [] as ExecutionGrant[], cleanup_pending: false }
  let value: unknown = response
  const client = new ProductRegistryClient({ ...options, request: async (url, init) => {
    assert.equal(new URL(url).pathname, '/api/v2/product-agents/execution/requests/revoke')
    assert.equal(init.method, 'POST')
    assert.equal(JSON.parse(init.body!).task_id, command.task_id)
    return Response.json(value)
  } })
  assert.equal((await client.executionRevokeRequest('org', command.request_id, command.task_id)).cleanup_pending, false)
  for (const patch of [
    { zone: 'other' }, { task_id: 'other' }, { request_id: 'other' }, { cleanup_pending: true },
    { fenced_at: Date.now() + 60000 }, { grants: [grant()] },
    { api_key: 'must-not-be-exposed' },
  ]) {
    value = { ...response, ...patch }
    await assert.rejects(client.executionRevokeRequest('org', command.request_id, command.task_id), /EXECUTION_RESPONSE_INVALID/)
  }
  value = { ...response, grants: [{ ...grant(), status: 'revoked', cleanup_pending: true }], cleanup_pending: true }
  assert.equal((await client.executionRevokeRequest('org', command.request_id, command.task_id)).cleanup_pending, true)
})
