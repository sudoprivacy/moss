// Bun only (same constraint as runtimeServiceFencing.test.ts): the
// sessionRunnerDaemon / PluginManager import chains carry bun:-protocol
// transitive deps that Node's loader rejects (ERR_UNSUPPORTED_ESM_URL_SCHEME).
// Covers the 2026-09-15 daemon-side fixes:
//   A4  mayStampDaemonLifecycle guard (daemon must not revive a terminated
//       session whose status was raced to 'failed'/'lost')
//   A5  stopPluginLocally removes the map entry even when plugin.stop() throws
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mayStampDaemonLifecycle } from "../sessionRunnerDaemon.js";
import { PluginManager } from "../../channels/gateway/PluginManager.js";

describe("A4: mayStampDaemonLifecycle", () => {
  it("allows stamping a live active session", () => {
    assert.equal(mayStampDaemonLifecycle({ status: "active", desiredState: "active" }), true);
  });

  it("blocks terminal statuses", () => {
    assert.equal(mayStampDaemonLifecycle({ status: "terminated", desiredState: "active" }), false);
    assert.equal(mayStampDaemonLifecycle({ status: "ended", desiredState: "active" }), false);
  });

  it("blocks a user-terminated session whose status was raced to failed/lost (the A4 window)", () => {
    assert.equal(mayStampDaemonLifecycle({ status: "failed", desiredState: "terminated" }), false);
    assert.equal(mayStampDaemonLifecycle({ status: "lost", desiredState: "terminated" }), false);
  });

  it("still allows the daemon #fail chain's own (failed, active) write-back target", () => {
    assert.equal(mayStampDaemonLifecycle({ status: "failed", desiredState: "active" }), true);
  });

  it("handles null session lookups", () => {
    assert.equal(mayStampDaemonLifecycle(null), false);
  });
});

describe("A5: stopPluginLocally always removes the map entry", () => {
  it("deletes the entry when plugin.stop() throws instead of retrying forever", async () => {
    const pm = new PluginManager({} as never, {} as never, null, "test-instance");
    const failing = { stop: async () => { throw new Error("bot wedged") } };
    const plugins = (pm as unknown as { plugins: Map<string, { stop(): Promise<void> }> }).plugins;
    plugins.set("tg:u1", failing);
    await (pm as unknown as { stopPluginLocally(k: string): Promise<void> }).stopPluginLocally("tg:u1");
    assert.equal(plugins.has("tg:u1"), false, "entry must be removed even when stop() fails");
  });

  it("deletes the entry on the success path too", async () => {
    const pm = new PluginManager({} as never, {} as never, null, "test-instance");
    const plugins = (pm as unknown as { plugins: Map<string, { stop(): Promise<void> }> }).plugins;
    plugins.set("tg:u2", { stop: async () => {} });
    await (pm as unknown as { stopPluginLocally(k: string): Promise<void> }).stopPluginLocally("tg:u2");
    assert.equal(plugins.has("tg:u2"), false);
  });
});
