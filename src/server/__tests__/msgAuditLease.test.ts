// Runs under Node: `tsx --test`. SQLite-side coverage for the msgaudit
// per-corpApp lease (E2/R18). This also anchors the UPSERT-with-WHERE claim
// semantics the plan required proving before use (no such precedent existed in
// the repo): the conflict-with-unmet-WHERE must report 0 affected rows. The
// two-pool concurrent-claim race is in pgBackend.test.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DirectConnectStore } from "../db.js";

describe("E2: msgaudit per-corpApp lease claim/release", () => {
  it("first claim wins; a held lease blocks a second instance; expiry and release both free it", async () => {
    const store = new DirectConnectStore(":memory:");
    const now = 10_000;
    const ttl = 60_000;

    // No row yet → INSERT wins.
    assert.equal(await store.claimMsgAuditLease("c1", "A", now + ttl, now), true);

    // Held by A, not expired → B's conflicting claim's WHERE is false → 0 rows → false.
    assert.equal(await store.claimMsgAuditLease("c1", "B", now + ttl + 100, now + 1_000), false);

    // Re-claim by the SAME holder before expiry is also a no-op (still held).
    assert.equal(await store.claimMsgAuditLease("c1", "A", now + ttl + 100, now + 1_000), false);

    // After A's lease expires → B can take it (WHERE lease_until < now is true).
    assert.equal(await store.claimMsgAuditLease("c1", "B", now + 2 * ttl, now + ttl + 1), true);

    // Release by the non-owner does nothing; by the owner frees it for reclaim.
    await store.releaseMsgAuditLease("c1", "A"); // A no longer owns → no-op
    assert.equal(await store.claimMsgAuditLease("c1", "A", now + 3 * ttl, now + 1_000), false, "still held by B");
    await store.releaseMsgAuditLease("c1", "B"); // owner releases
    assert.equal(await store.claimMsgAuditLease("c1", "A", now + 3 * ttl, now + 1_000), true, "reclaimable after release");

    store.db.close();
  });

  it("independent corpApps do not contend", async () => {
    const store = new DirectConnectStore(":memory:");
    const now = 1_000;
    assert.equal(await store.claimMsgAuditLease("c1", "A", now + 60_000, now), true);
    assert.equal(await store.claimMsgAuditLease("c2", "B", now + 60_000, now), true);
    store.db.close();
  });
});
