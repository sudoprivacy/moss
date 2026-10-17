// Runs under Node (the store uses node:sqlite, which Bun lacks): `tsx --test`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DirectConnectStore } from "../db.js";
import { ExternalTaskStore } from "../externalProviders/store.js";
import { ExternalExecutionOwnership } from "../agentFederation/executionOwnership.js";

it("external execution shares the registered controller identity and preserves real peers", async () => {
  const store = setup();
  try {
    const instance = await store.registerServerInstance("controller", process.pid);
    const ownership = new ExternalExecutionOwnership(new ExternalTaskStore(store.driver), instance.instanceId);
    await ownership.ready;
    assert.equal(ownership.ownerId, instance.instanceId);
    assert.equal(await store.countLiveOtherInstances(instance.instanceId, 30_000), 0);
    await store.registerServerInstance("peer", process.pid + 1, "real-peer");
    assert.equal(await store.countLiveOtherInstances(instance.instanceId, 30_000), 1);
    await store.driver.run("UPDATE server_instances SET heartbeat_at = 1 WHERE instance_id = ?", [instance.instanceId]);
    await ownership.heartbeat();
    await ownership.stop();
    const row = await store.driver.get("SELECT status, heartbeat_at FROM server_instances WHERE instance_id = ?", [instance.instanceId]);
    assert.equal(row?.status, "running", "Only the controller owns its lifecycle");
    assert.equal(Number(row?.heartbeat_at), 1, "Only the controller owns its heartbeat");
  } finally {
    await store.close();
  }
});

it("external execution rejects an unregistered, stopped or foreign process identity", async () => {
  const store = setup();
  try {
    const external = new ExternalTaskStore(store.driver);
    await assert.rejects(new ExternalExecutionOwnership(external, "missing").ready, /registered running controller/);
    await store.registerServerInstance("other", process.pid + 1, "other-process");
    await assert.rejects(new ExternalExecutionOwnership(external, "other-process").ready, /registered running controller/);
    await store.registerServerInstance("stopped", process.pid, "stopped");
    await store.stopServerInstance("stopped");
    await assert.rejects(new ExternalExecutionOwnership(external, "stopped").ready, /registered running controller/);
  } finally {
    await store.close();
  }
});

function setup() {
  return new DirectConnectStore(":memory:");
}

describe("registerServerInstance — stable MOSS_INSTANCE_ID (LB multi-instance)", () => {
  it("uses the provided instanceId when given", async () => {
    const store = setup();
    const rec = await store.registerServerInstance("hostA", 101, "a");
    assert.equal(rec.instanceId, "a");
    assert.equal(rec.status, "running");
    const row = store.requireSqliteDb()
      .prepare("SELECT instance_id, status FROM server_instances WHERE instance_id = ?")
      .get("a") as { instance_id: string; status: string };
    assert.equal(row.status, "running");
  });

  it("falls back to a random UUID when no instanceId is passed (single-instance behavior)", async () => {
    const store = setup();
    const rec = await store.registerServerInstance("hostA", 101);
    // Shape check only: UUIDv4 format, differs between calls.
    assert.match(rec.instanceId, /^[0-9a-f-]{36}$/);
    const rec2 = await store.registerServerInstance("hostA", 102);
    assert.notEqual(rec.instanceId, rec2.instanceId);
  });

  it("re-registering a fixed id after a stop UPSERTs instead of failing on the PRIMARY KEY (H1)", async () => {
    const store = setup();
    await store.registerServerInstance("hostA", 101, "a");
    await store.stopServerInstance("a");

    const stoppedRow = store.requireSqliteDb()
      .prepare("SELECT status, stopped_at FROM server_instances WHERE instance_id = ?")
      .get("a") as { status: string; stopped_at: number };
    assert.equal(stoppedRow.status, "stopped");
    assert.ok(stoppedRow.stopped_at !== null);

    // Second start of the same fixed id — must not throw UNIQUE constraint.
    const rec = await store.registerServerInstance("hostB", 202, "a");
    assert.equal(rec.instanceId, "a");
    assert.equal(rec.status, "running");

    const row = store.requireSqliteDb()
      .prepare("SELECT status, stopped_at, host, pid FROM server_instances WHERE instance_id = ?")
      .get("a") as { status: string; stopped_at: number | null; host: string; pid: number };
    assert.equal(row.status, "running");
    assert.equal(row.stopped_at, null, "stopped_at must reset on the new incarnation");
    assert.equal(row.host, "hostB", "host must refresh to the new incarnation");
    assert.equal(row.pid, 202);

    // Only one row for the fixed id — no duplicates.
    const count = store.requireSqliteDb()
      .prepare("SELECT COUNT(*) AS n FROM server_instances WHERE instance_id = ?")
      .get("a") as { n: number };
    assert.equal(count.n, 1);
  });
});
