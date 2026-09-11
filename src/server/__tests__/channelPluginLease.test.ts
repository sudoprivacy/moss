// Runs under Node: `tsx --test`. B8/R10: per-(id,user_id) channel-plugin lease.
// One instance holds a plugin row's lease while it runs, so two instances
// sharing the DB never both start the same plugin (e.g. double Telegram
// polling). The PluginManager tick/reload wiring is exercised in the WSL
// integration run; this pins the store-level CAS semantics.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DirectConnectStore } from "../db.js";

function insertPlugin(store: DirectConnectStore, id: string, userId: string) {
  const now = Date.now();
  store.db
    .prepare(
      `INSERT INTO channel_plugins (id, type, name, enabled, status, user_id, created_at, updated_at)
       VALUES (?, 'telegram', 'n', 1, 'stopped', ?, ?, ?)`,
    )
    .run(id, userId, now, now);
}

describe("B8: channel plugin lease claim/release", () => {
  it("only one instance holds a row; renew works; expiry lets a peer take over; release frees it", async () => {
    const store = new DirectConnectStore(":memory:");
    insertPlugin(store, "tg", "u1");
    const now = 100_000;
    const ttl = 60_000;

    assert.equal(await store.claimChannelPluginLease("tg", "u1", "A", now + ttl, now), true, "first claim wins");
    assert.equal(await store.claimChannelPluginLease("tg", "u1", "B", now + ttl, now + 1_000), false, "peer blocked while fresh");
    assert.equal(await store.claimChannelPluginLease("tg", "u1", "A", now + 2 * ttl, now + 1_000), true, "owner renews");

    // After A's lease expires, B can take over.
    assert.equal(await store.claimChannelPluginLease("tg", "u1", "B", now + 3 * ttl, now + 2 * ttl + 1), true, "takeover after expiry");

    // Graceful release by the current holder frees it.
    await store.releaseAllChannelPluginLeases("B");
    assert.equal(await store.claimChannelPluginLease("tg", "u1", "A", now + 4 * ttl, now + 2 * ttl + 2), true, "reclaimable after release");

    store.db.close();
  });

  it("same plugin id under different users leases independently", async () => {
    const store = new DirectConnectStore(":memory:");
    insertPlugin(store, "tg", "u1");
    insertPlugin(store, "tg", "u2");
    const now = 100_000;
    const ttl = 60_000;
    assert.equal(await store.claimChannelPluginLease("tg", "u1", "A", now + ttl, now), true);
    assert.equal(await store.claimChannelPluginLease("tg", "u2", "B", now + ttl, now), true);
    // A cannot steal u2 (B holds it fresh).
    assert.equal(await store.claimChannelPluginLease("tg", "u2", "A", now + ttl, now + 1_000), false);
    store.db.close();
  });

  it("does not claim a disabled row", async () => {
    const store = new DirectConnectStore(":memory:");
    const now = 100_000;
    store.db
      .prepare(
        `INSERT INTO channel_plugins (id, type, name, enabled, status, user_id, created_at, updated_at)
         VALUES ('tg', 'telegram', 'n', 0, 'stopped', 'u1', ?, ?)`,
      )
      .run(now, now);
    assert.equal(await store.claimChannelPluginLease("tg", "u1", "A", now + 60_000, now), false, "disabled rows are never leased");
    store.db.close();
  });
});
