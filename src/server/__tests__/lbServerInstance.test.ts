// Runs under Node (the store uses node:sqlite, which Bun lacks): `tsx --test`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DirectConnectStore } from "../db.js";

function setup() {
  return new DirectConnectStore(":memory:");
}

describe("registerServerInstance — stable MOSS_INSTANCE_ID (LB multi-instance)", () => {
  it("uses the provided instanceId when given", async () => {
    const store = setup();
    const rec = await store.registerServerInstance("hostA", 101, "a");
    assert.equal(rec.instanceId, "a");
    assert.equal(rec.status, "running");
    const row = store.db
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

    const stoppedRow = store.db
      .prepare("SELECT status, stopped_at FROM server_instances WHERE instance_id = ?")
      .get("a") as { status: string; stopped_at: number };
    assert.equal(stoppedRow.status, "stopped");
    assert.ok(stoppedRow.stopped_at !== null);

    // Second start of the same fixed id — must not throw UNIQUE constraint.
    const rec = await store.registerServerInstance("hostB", 202, "a");
    assert.equal(rec.instanceId, "a");
    assert.equal(rec.status, "running");

    const row = store.db
      .prepare("SELECT status, stopped_at, host, pid FROM server_instances WHERE instance_id = ?")
      .get("a") as { status: string; stopped_at: number | null; host: string; pid: number };
    assert.equal(row.status, "running");
    assert.equal(row.stopped_at, null, "stopped_at must reset on the new incarnation");
    assert.equal(row.host, "hostB", "host must refresh to the new incarnation");
    assert.equal(row.pid, 202);

    // Only one row for the fixed id — no duplicates.
    const count = store.db
      .prepare("SELECT COUNT(*) AS n FROM server_instances WHERE instance_id = ?")
      .get("a") as { n: number };
    assert.equal(count.n, 1);
  });
});
