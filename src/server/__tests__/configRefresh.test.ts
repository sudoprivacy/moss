// Runs under Node: `tsx --test`. Cross-instance ConfigStore refresh (E3/R20):
// a Nexus value edited by another instance is picked up by the fingerprint
// poll and hydrated into the live ServerConfig in place; a poll error keeps the
// old value. Uses a hand-rolled Nexus mock (the existing configStore.test.ts is
// bun-only).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ConfigStore } from "../configStore/configStore.js";
import type { NexusClient } from "../nexus/nexusClient.js";
import type { ServerConfig } from "../types.js";

class MockNexus {
  store = new Map<string, string>();
  throwOnGet = false;
  async putSecret(_ns: string, key: string, value: string) { this.store.set(key, value); }
  async getSecret(_ns: string, key: string) {
    if (this.throwOnGet) throw new Error("nexus down");
    const v = this.store.get(key);
    return v === undefined ? null : { value: v };
  }
  async deleteSecret(_ns: string, key: string) { this.store.delete(key); }
}

function makeConfig(): ServerConfig {
  return { cabin: {}, wikiIndex: {} } as unknown as ServerConfig;
}

// The cabin-token-secret field skips hydration when its env is set; clear it so
// the test's Nexus value is authoritative.
const ENV = "CABIN_TOKEN_SECRET";
let savedEnv: string | undefined;
before(() => { savedEnv = process.env[ENV]; delete process.env[ENV]; });
after(() => { if (savedEnv !== undefined) process.env[ENV] = savedEnv; });

describe("E3: ConfigStore fingerprint refresh", () => {
  it("computeFingerprint changes iff a value changes", async () => {
    const mock = new MockNexus();
    mock.store.set("server.cabin-token-secret", "v1");
    const store = new ConfigStore(mock as unknown as NexusClient);
    const fp1 = await store.computeFingerprint();
    const fp2 = await store.computeFingerprint();
    assert.equal(fp1, fp2, "stable when nothing changed");
    mock.store.set("server.cabin-token-secret", "v2");
    const fp3 = await store.computeFingerprint();
    assert.notEqual(fp1, fp3, "changes when a value changes");
  });

  it("polling hydrates a peer's edit into the live config in place", async () => {
    const mock = new MockNexus();
    mock.store.set("server.cabin-token-secret", "old-secret");
    const store = new ConfigStore(mock as unknown as NexusClient);
    const config = makeConfig();
    await store.loadAll();
    store.hydrateConfig(config);
    assert.equal((config as { cabin: { tokenSecret?: string } }).cabin.tokenSecret, "old-secret");

    store.startRefreshPolling(config, 20);
    try {
      // Let the baseline fingerprint settle (it is captured asynchronously)
      // before simulating a peer's edit, so the change is genuinely detected.
      await new Promise(r => setTimeout(r, 60));
      mock.store.set("server.cabin-token-secret", "new-secret");
      await new Promise(r => setTimeout(r, 150));
      assert.equal((config as { cabin: { tokenSecret?: string } }).cabin.tokenSecret, "new-secret");
    } finally {
      store.stopRefreshPolling();
    }
  });

  it("keeps the old value when a refresh poll errors", async () => {
    const mock = new MockNexus();
    mock.store.set("server.cabin-token-secret", "stable");
    const store = new ConfigStore(mock as unknown as NexusClient);
    const config = makeConfig();
    await store.loadAll();
    store.hydrateConfig(config);

    store.startRefreshPolling(config, 20);
    try {
      mock.throwOnGet = true; // nexus becomes unreachable
      await new Promise(r => setTimeout(r, 150));
      assert.equal((config as { cabin: { tokenSecret?: string } }).cabin.tokenSecret, "stable");
    } finally {
      store.stopRefreshPolling();
    }
  });
});
