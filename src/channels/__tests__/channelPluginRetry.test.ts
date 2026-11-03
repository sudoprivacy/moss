// A connection whose automatic start keeps failing is retried with backoff,
// not on every lease tick, and only a start that ran reloads the sessions.
// Uses the real Lark plugin, whose start fails without an App ID.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PluginManager } from "../gateway/PluginManager.js";

type Row = Record<string, unknown>;

function harness(rows: Row[]) {
  const statuses: string[] = [];
  let reloads = 0;
  const db = {
    listChannelPluginsWithOwnerStatus: async () => rows,
    claimChannelPluginLease: async () => true,
    updateChannelPluginStatus: async (_id: string, status: string) => { statuses.push(status); },
  };
  const sessions = { reload: async () => { reloads += 1; } };
  const manager = new PluginManager(sessions as never, db as never, null, "instance-a");
  const pass = () => (manager as unknown as { runLeasePass(): Promise<void> }).runLeasePass();
  return { pass, attempts: () => statuses.filter(status => status === "error").length, reloads: () => reloads };
}

function larkRow(credentials: string, ownerStatus = "active"): Row {
  return { id: "lark_default", type: "lark", name: "Lark", enabled: 1, status: "error", user_id: "u1",
    owner_status: ownerStatus, credentials_json: credentials, config_json: "{}", created_at: 1, updated_at: 1 };
}

describe("channel plugin start retries", () => {
  it("backs off while the stored settings stay the same, and retries at once when they change", async () => {
    const row = larkRow('{"configuredSecretFields":[]}');
    const { pass, attempts, reloads } = harness([row]);
    await pass();
    assert.equal(attempts(), 1, "the first pass tries the connection");
    await pass();
    await pass();
    assert.equal(attempts(), 1, "later ticks wait out the backoff");
    row.credentials_json = '{"configuredSecretFields":[],"appId":"cli_changed"}';
    await pass();
    assert.equal(attempts(), 2, "changed settings are tried on the next tick");
    assert.equal(reloads(), 0, "a failed start does not reload sessions");
  });

  it("does not start a disabled owner's connection", async () => {
    const { pass, attempts } = harness([larkRow('{"configuredSecretFields":[]}', "disabled")]);
    await pass();
    assert.equal(attempts(), 0);
  });
});
