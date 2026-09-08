// Runs under Node: `tsx --test`. Covers computeReadiness (probes fully
// stubbed — no live nexus listener / docker / kubectl needed, deterministic)
// and setRouteCookieHeader, both exported from server.ts for testability.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { computeReadiness, setRouteCookieHeader } from "../server.js";
import type { ServerConfig } from "../types.js";
import type { RuntimeService } from "../runtimeService.js";

// computeReadiness only touches `runtime` inside DEFAULT probe implementations
// (probeDb). Every test here injects all probes, so a bare fake is safe.
const fakeRuntime = {} as unknown as RuntimeService;

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    defaultRuntime: "host",
    instanceId: "a",
    routeCookieName: "moss_route",
    routeCookieSecure: false,
    shutdownGraceMs: 0,
    ...overrides,
  } as ServerConfig;
}

const allGreenProbes = {
  isDraining: () => false,
  probeDb: async () => true,
  probeNexus: async () => true,
  probeDocker: async () => true,
  probeK8s: async () => true,
};

describe("computeReadiness (probe-injected)", () => {
  it("all green + not draining → 200; host runtime → runtime/k8s null (not applicable)", async () => {
    const result = await computeReadiness(makeConfig(), fakeRuntime, allGreenProbes);
    assert.equal(result.ready, true);
    assert.equal(result.ok, true);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.instance_id, "a");
    assert.equal(result.checks.db, true);
    assert.equal(result.checks.nexus, true);
    assert.equal(result.checks.runtime, null, "host runtime has nothing to probe");
    assert.equal(result.checks.k8s, null);
    assert.equal(result.checks.draining, false);
  });

  it("draining=true → 503 with ok:false", async () => {
    const result = await computeReadiness(
      makeConfig(),
      fakeRuntime,
      { ...allGreenProbes, isDraining: () => true },
    );
    assert.equal(result.ready, false);
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 503);
    assert.equal(result.checks.draining, true);
  });

  it("probeDb failure → 503", async () => {
    const result = await computeReadiness(
      makeConfig(),
      fakeRuntime,
      { ...allGreenProbes, probeDb: async () => false },
    );
    assert.equal(result.httpStatus, 503);
    assert.equal(result.checks.db, false);
  });

  it("probeNexus failure → 503 (shared fault domain is by design, see plan §8.3a)", async () => {
    const result = await computeReadiness(
      makeConfig(),
      fakeRuntime,
      { ...allGreenProbes, probeNexus: async () => false },
    );
    assert.equal(result.httpStatus, 503);
    assert.equal(result.checks.nexus, false);
  });

  it("docker runtime: probeDocker result decides readiness", async () => {
    const config = makeConfig({ defaultRuntime: "docker" });
    const down = await computeReadiness(
      config, fakeRuntime, { ...allGreenProbes, probeDocker: async () => false },
    );
    assert.equal(down.httpStatus, 503);
    assert.equal(down.checks.runtime, false);
    assert.equal(down.checks.k8s, null, "k8s check stays null for docker runtime");

    const up = await computeReadiness(config, fakeRuntime, allGreenProbes);
    assert.equal(up.httpStatus, 200);
    assert.equal(up.checks.runtime, true);
  });

  it("k8s runtime: checks.runtime and checks.k8s share the same probe result", async () => {
    const config = makeConfig({ defaultRuntime: "k8s" });
    const down = await computeReadiness(
      config, fakeRuntime, { ...allGreenProbes, probeK8s: async () => false },
    );
    assert.equal(down.httpStatus, 503);
    assert.equal(down.checks.runtime, false);
    assert.equal(down.checks.k8s, false, "same source, not two independent probes");

    const up = await computeReadiness(config, fakeRuntime, allGreenProbes);
    assert.equal(up.httpStatus, 200);
    assert.equal(up.checks.runtime, true);
    assert.equal(up.checks.k8s, true);
  });

  it("unset instanceId → instance_id:null (reported honestly)", async () => {
    const result = await computeReadiness(
      makeConfig({ instanceId: undefined }),
      fakeRuntime,
      allGreenProbes,
    );
    assert.equal(result.instance_id, null);
  });
});

describe("setRouteCookieHeader", () => {
  function fakeRes(): { headers: Record<string, string>; setHeader(k: string, v: string): void } & http.ServerResponse {
    const headers: Record<string, string> = {}
    return {
      headers,
      setHeader(k: string, v: string) { headers[k] = v },
    } as unknown as http.ServerResponse & { headers: Record<string, string>; setHeader(k: string, v: string): void }
  }

  it("configured instanceId → moss_route cookie, HttpOnly + SameSite=Lax", () => {
    const res = fakeRes();
    setRouteCookieHeader(res, makeConfig());
    assert.equal(res.headers["Set-Cookie"], "moss_route=a; Path=/; HttpOnly; SameSite=Lax");
  });

  it("routeCookieSecure=true appends Secure", () => {
    const res = fakeRes();
    setRouteCookieHeader(res, makeConfig({ routeCookieSecure: true }));
    assert.equal(res.headers["Set-Cookie"], "moss_route=a; Path=/; HttpOnly; SameSite=Lax; Secure");
  });

  it("no instanceId configured → no Set-Cookie at all (single-instance behavior)", () => {
    const res = fakeRes();
    setRouteCookieHeader(res, makeConfig({ instanceId: undefined }));
    assert.equal(res.headers["Set-Cookie"], undefined);
  });

  it("custom routeCookieName is honored", () => {
    const res = fakeRes();
    setRouteCookieHeader(res, makeConfig({ routeCookieName: "lbroute" }));
    assert.equal(res.headers["Set-Cookie"], "lbroute=a; Path=/; HttpOnly; SameSite=Lax");
  });
});
