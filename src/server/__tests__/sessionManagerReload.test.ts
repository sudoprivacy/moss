// Runs under Node: `tsx --test`. B7/R22: whenReady() gates message handling on
// the initial cache load (PG startup window), and reload() re-reads the cache
// so a lease failover picks up sessions a previous holder created — both
// prevent duplicate channel_sessions rows.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DirectConnectStore } from "../db.js";
import { SessionManager } from "../../channels/core/SessionManager.js";

describe("B7: SessionManager whenReady + reload", () => {
  it("whenReady resolves and reload picks up a row created by another instance", async () => {
    const store = new DirectConnectStore(":memory:");
    const sm = new SessionManager(store);

    await sm.whenReady(); // must resolve
    assert.equal(sm.getSession("peerUser", "chatX"), null, "empty snapshot at start");

    // Simulate a peer instance writing a session row into the shared DB after
    // this manager's snapshot was taken.
    await store.upsertChannelSession({
      id: "sess-peer",
      user_id: "peerUser",
      agent_type: "acp",
      conversation_id: "conv1",
      workspace: null,
      chat_id: "chatX",
      created_at: Date.now(),
      last_activity: Date.now(),
    });

    // Not visible until we reload (this is the failover gap the fix closes).
    assert.equal(sm.getSession("peerUser", "chatX"), null, "not in the pre-reload snapshot");

    await sm.reload();
    const s = sm.getSession("peerUser", "chatX");
    assert.ok(s, "reload picks up the peer-created row");
    assert.equal(s!.id, "sess-peer");

    store.db.close();
  });
});
