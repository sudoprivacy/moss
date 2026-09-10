// Runs under Node (the store uses node:sqlite, which Bun lacks): `tsx --test`.
// Covers the LB HA config surface resolved by readServerConfig: MOSS_INSTANCE_ID,
// MOSS_ROUTE_COOKIE_NAME / MOSS_ROUTE_COOKIE_SECURE, MOSS_SHUTDOWN_GRACE_MS —
// env precedence over server.json, defaults, charset validation on BOTH
// sources, and the negative-grace clamp.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readServerConfig } from "../config.js";

const ENV_KEYS = [
  "MOSS_INSTANCE_ID",
  "MOSS_ROUTE_COOKIE_NAME",
  "MOSS_ROUTE_COOKIE_SECURE",
  "MOSS_SHUTDOWN_GRACE_MS",
  "MOSS_AUTH_PROXY_URL",
  "MOSS_DB_BACKEND",
  "MOSS_DATABASE_URL",
] as const;

let savedEnv: Record<string, string | undefined>;
let tempDir: string;

beforeEach(async () => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  tempDir = await mkdtemp(join(tmpdir(), "moss-lb-config-"));
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(tempDir, { recursive: true, force: true });
});

async function writeConfig(raw: Record<string, unknown>): Promise<string> {
  const path = join(tempDir, "server.json");
  await writeFile(path, JSON.stringify(raw), "utf8");
  return path;
}

describe("LB HA config resolution (readServerConfig)", () => {
  it("defaults: no instanceId, moss_route cookie, grace 0 (= drain disabled, current behavior)", async () => {
    const path = await writeConfig({});
    const { config } = await readServerConfig(path);
    assert.equal(config.instanceId, undefined);
    assert.equal(config.routeCookieName, "moss_route");
    assert.equal(config.routeCookieSecure, false);
    assert.equal(config.shutdownGraceMs, 0);
  });

  it("server.json values are honored", async () => {
    const path = await writeConfig({
      server: { instanceId: "a", routeCookieName: "lbroute", routeCookieSecure: true, shutdownGraceMs: 30000 },
    });
    const { config } = await readServerConfig(path);
    assert.equal(config.instanceId, "a");
    assert.equal(config.routeCookieName, "lbroute");
    assert.equal(config.routeCookieSecure, true);
    assert.equal(config.shutdownGraceMs, 30000);
  });

  it("env takes precedence over server.json", async () => {
    process.env.MOSS_INSTANCE_ID = "b";
    process.env.MOSS_ROUTE_COOKIE_NAME = "envroute";
    process.env.MOSS_ROUTE_COOKIE_SECURE = "true";
    process.env.MOSS_SHUTDOWN_GRACE_MS = "15000";
    const path = await writeConfig({
      server: { instanceId: "a", routeCookieName: "lbroute", shutdownGraceMs: 30000 },
    });
    const { config } = await readServerConfig(path);
    assert.equal(config.instanceId, "b");
    assert.equal(config.routeCookieName, "envroute");
    assert.equal(config.routeCookieSecure, true);
    assert.equal(config.shutdownGraceMs, 15000);
  });

  it("rejects an invalid instanceId from the FILE (zod schema regex)", async () => {
    const path = await writeConfig({ server: { instanceId: "a;b" } });
    await assert.rejects(() => readServerConfig(path), /Invalid server config/);
  });

  it("rejects an invalid instanceId from ENV (resolve-time check — env bypasses zod)", async () => {
    process.env.MOSS_INSTANCE_ID = "bad value";
    const path = await writeConfig({});
    await assert.rejects(() => readServerConfig(path), /server.instanceId/);
  });

  it("rejects an invalid routeCookieName from ENV (same Set-Cookie injection surface)", async () => {
    process.env.MOSS_ROUTE_COOKIE_NAME = "a=b";
    const path = await writeConfig({});
    await assert.rejects(() => readServerConfig(path), /routeCookieName/);
  });

  it("clamps a negative MOSS_SHUTDOWN_GRACE_MS to 0 (readIntEnv passes -5 through)", async () => {
    process.env.MOSS_SHUTDOWN_GRACE_MS = "-5";
    const path = await writeConfig({});
    const { config } = await readServerConfig(path);
    assert.equal(config.shutdownGraceMs, 0);
  });

  it("MOSS_ROUTE_COOKIE_SECURE accepts 1/true", async () => {
    process.env.MOSS_ROUTE_COOKIE_SECURE = "1";
    const path = await writeConfig({});
    const first = await readServerConfig(path);
    assert.equal(first.config.routeCookieSecure, true);
    process.env.MOSS_ROUTE_COOKIE_SECURE = "false";
    const second = await readServerConfig(path);
    assert.equal(second.config.routeCookieSecure, false);
  });

  // P1-2a: storage backend + auth-proxy URL resolution (HA PG groundwork).
  it("authProxyUrl defaults to http://localhost:12013 (unchanged behavior)", async () => {
    const path = await writeConfig({});
    const { config } = await readServerConfig(path);
    assert.equal(config.authProxyUrl, "http://localhost:12013");
  });

  it("authProxyUrl honors server.json, and ENV takes precedence", async () => {
    const path = await writeConfig({ server: { authProxyUrl: "http://moss-server-a:12013" } });
    const fromFile = await readServerConfig(path);
    assert.equal(fromFile.config.authProxyUrl, "http://moss-server-a:12013");
    process.env.MOSS_AUTH_PROXY_URL = "http://env-host:12013";
    const fromEnv = await readServerConfig(path);
    assert.equal(fromEnv.config.authProxyUrl, "http://env-host:12013");
  });

  it("dbBackend defaults to sqlite with no databaseUrl (single-host path)", async () => {
    const path = await writeConfig({});
    const { config } = await readServerConfig(path);
    assert.equal(config.dbBackend, "sqlite");
    assert.equal(config.databaseUrl, undefined);
  });

  it("MOSS_DATABASE_URL infers the postgres backend and is honored", async () => {
    process.env.MOSS_DATABASE_URL = "postgres://u:p@h:5432/moss";
    const path = await writeConfig({});
    const { config } = await readServerConfig(path);
    assert.equal(config.dbBackend, "postgres");
    assert.equal(config.databaseUrl, "postgres://u:p@h:5432/moss");
  });

  it("server.json storage.dbBackend=postgres is honored", async () => {
    const path = await writeConfig({ storage: { dbBackend: "postgres" } });
    const { config } = await readServerConfig(path);
    assert.equal(config.dbBackend, "postgres");
  });
});
