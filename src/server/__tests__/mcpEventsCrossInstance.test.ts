// Runs under Node: `tsx --test`. Covers the cross-instance mcp/events poll
// (HA): fingerprint change → correct event type, org isolation, no re-emit
// of locally broadcast changes, first-sight silent seeding, plus fingerprint
// sensitivity of getOrgChangeFingerprints. Uses a real McpStore(":memory:")
// and fake SSE responses.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { McpStore } from "../mcp/db.js";
import { SqliteDriver } from "../db/driver.js";
import {
  handleMcpSseConnection,
  broadcastMcpEvent,
  configureMcpChangeDetection,
  __resetMcpEventsForTest,
  __tickMcpChangeDetectionForTest,
} from "../api/mcpEvents.js";

type Captured = { events: string[]; ended: boolean };

function makeFakeRes(): { res: EventEmitter; captured: Captured } {
  const captured: Captured = { events: [], ended: false };
  const res = new EventEmitter() as EventEmitter & {
    writeHead: (status: number, headers: Record<string, string>) => void;
    write: (chunk: string) => void;
    end: () => void;
  };
  res.writeHead = () => undefined as unknown as void;
  res.write = (chunk: string) => {
    // SSE frame format: `event: <type>\ndata: <json>\n\n`
    const m = /event: (\S+)/.exec(chunk);
    if (m) captured.events.push(m[1]);
    return true as unknown as void;
  };
  res.end = () => {
    captured.ended = true;
  };
  return { res, captured };
}

// The store queries go through the async driver; the test keeps its own db
// handle for direct row inserts (McpStore no longer exposes the raw handle).
function setup(): { store: McpStore; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  McpStore.ensureTables(db);
  const store = new McpStore(new SqliteDriver(db));
  configureMcpChangeDetection((orgId) => store.getOrgChangeFingerprints(orgId));
  return { store, db };
}

// Minimal row insert helpers — the fingerprints only look at COUNT + MAX
// timestamps, so full-column MCP rows are unnecessary.
function insertMcpServer(db: DatabaseSync, orgId: string) {
  db
    .prepare(
      `INSERT INTO mcp_servers (id, org_id, name, display_name, scope, owner_type, owner_id, mcp_type, url, status, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, 'n', 'n', 'user', 'org', '', 'sse', 'http://x', 'approved', 1, 'u', ?, ?)`,
    )
    .run(`srv-${Math.random().toString(36).slice(2)}`, orgId, Date.now(), Date.now());
}

function insertPolicy(db: DatabaseSync, orgId: string) {
  db
    .prepare(
      `INSERT INTO mcp_policies (org_id, created_by, created_at, updated_at)
       VALUES (?, 'u', ?, ?)`,
    )
    .run(orgId, Date.now(), Date.now());
}

describe("mcp/events cross-instance poll (HA)", () => {
  let store: McpStore;
  let db: DatabaseSync;

  beforeEach(() => {
    __resetMcpEventsForTest();
    ({ store, db } = setup());
  });

  afterEach(() => {
    __resetMcpEventsForTest();
  });

  it("seeds silently on first sight of an org (no replay of history)", async () => {
    insertMcpServer(db, "o1");
    const { res, captured } = makeFakeRes();
    handleMcpSseConnection(res, "o1");
    await __tickMcpChangeDetectionForTest();
    assert.equal(captured.events.length, 0);
  });

  it("emits mcp.changed when a remote instance writes mcp_servers", async () => {
    const { res, captured } = makeFakeRes();
    handleMcpSseConnection(res, "o1");
    await __tickMcpChangeDetectionForTest(); // seed
    insertMcpServer(db, "o1");
    await __tickMcpChangeDetectionForTest();
    assert.deepEqual(captured.events, ["mcp.changed"]);
  });

  it("emits mcp.policy.changed when only the policy table changes (type mapping)", async () => {
    const { res, captured } = makeFakeRes();
    handleMcpSseConnection(res, "o1");
    await __tickMcpChangeDetectionForTest();
    insertPolicy(db, "o1");
    await __tickMcpChangeDetectionForTest();
    assert.deepEqual(captured.events, ["mcp.policy.changed"]);
  });

  it("does not re-emit a locally broadcast change (baseline refresh)", async () => {
    const { res, captured } = makeFakeRes();
    handleMcpSseConnection(res, "o1");
    await __tickMcpChangeDetectionForTest();
    insertMcpServer(db, "o1");
    broadcastMcpEvent({ org_id: "o1", type: "mcp.changed" });
    // baseline refresh in broadcast is async (fire-and-forget); let it settle
    // before polling so the poll sees the refreshed baseline, not the old one.
    await new Promise((r) => setTimeout(r, 0));
    captured.events.length = 0;
    await __tickMcpChangeDetectionForTest();
    assert.equal(captured.events.length, 0, "poll must not re-emit the local change");
  });

  it("keeps orgs isolated (o2 client sees nothing on o1 change)", async () => {
    const { res: res1, captured: c1 } = makeFakeRes();
    const { res: res2, captured: c2 } = makeFakeRes();
    handleMcpSseConnection(res1, "o1");
    handleMcpSseConnection(res2, "o2");
    await __tickMcpChangeDetectionForTest();
    insertMcpServer(db, "o1");
    await __tickMcpChangeDetectionForTest();
    assert.deepEqual(c1.events, ["mcp.changed"]);
    assert.equal(c2.events.length, 0);
  });

  it("fingerprint is sensitive to each of the four tables", async () => {
    const before = await store.getOrgChangeFingerprints("o1");
    insertMcpServer(db, "o1");
    const afterServers = await store.getOrgChangeFingerprints("o1");
    assert.notEqual(before.servers, afterServers);
    assert.equal(before.policy, afterServers.policy);

    db
      .prepare(
        `INSERT INTO mcp_user_disabled (org_id, user_id, mcp_server_id, created_at) VALUES ('o1','u1','srv-x',?)`,
      )
      .run(Date.now());
    const afterDisabled = await store.getOrgChangeFingerprints("o1");
    assert.notEqual(afterServers.servers, afterDisabled.servers);

    db
      .prepare(
        `INSERT INTO mcp_templates (org_id, name, description, icon, created_by, created_at, updated_at)
         VALUES ('o1','t','d','i','u',?,?)`,
      )
      .run(Date.now(), Date.now());
    const afterTemplates = await store.getOrgChangeFingerprints("o1");
    assert.notEqual(afterDisabled.servers, afterTemplates.servers);

    insertPolicy(db, "o1");
    const afterPolicy = await store.getOrgChangeFingerprints("o1");
    assert.notEqual(afterTemplates.policy, afterPolicy.policy);
  });
});
