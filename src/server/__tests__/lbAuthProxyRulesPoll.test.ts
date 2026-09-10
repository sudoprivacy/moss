// Runs under Node: `tsx --test`. Covers the cross-instance auth-proxy rules
// poll (HA): `rules` is process-local memory; other instances' config-items
// changes must reach this instance via the always-on fingerprint poll.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AuthProxyServer } from "../authProxy/authProxyServer.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    // Yield to the event loop so the (unref'd) poll timer can fire.
    await sleep(10);
  }
}

describe("AuthProxyServer.startRulesChangePolling — cross-instance rules refresh (HA)", () => {
  const servers: AuthProxyServer[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await s.stop();
    }
  });

  it("reloads when the fingerprint changes, stays quiet when it does not", async () => {
    const server = new AuthProxyServer();
    servers.push(server);

    let fingerprint = "fp-1";
    let reloads = 0;
    server.startRulesChangePolling(
      () => fingerprint,
      () => {
        reloads += 1;
      },
      10,
    );

    // No change → no reload after several poll intervals.
    await sleep(80);
    assert.equal(reloads, 0);

    // A remote instance changed config items → fingerprint moves → reload.
    fingerprint = "fp-2";
    await waitFor(() => reloads >= 1);
    const afterFirst = reloads;

    // Stable again → no further reloads.
    await sleep(80);
    assert.equal(reloads, afterFirst);
  });

  it("a throwing fingerprint provider never breaks the poll loop", async () => {
    const server = new AuthProxyServer();
    servers.push(server);

    let fingerprint: string | null = "fp-1";
    let reloads = 0;
    server.startRulesChangePolling(
      () => {
        if (fingerprint === null) throw new Error("db unavailable");
        return fingerprint;
      },
      () => {
        reloads += 1;
      },
      10,
    );

    fingerprint = null; // provider starts failing
    await sleep(80);
    assert.equal(reloads, 0, "failing provider must not trigger reloads");

    fingerprint = "fp-2"; // provider recovers and the value differs
    await waitFor(() => reloads >= 1);
  });
});
