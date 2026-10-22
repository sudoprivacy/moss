/** Isolated real HTTP/auth/catalog server; only the vault transport uses test memory. */
import { readServerConfig, ensureServerDirectories } from "../config.js";
import { DirectConnectStore } from "../db.js";
import {
  ensureSqliteCompatibilityDomainSchemas,
  ensureCompatibilityCoreSchema,
} from "../db/compatibilitySchema.js";
import { createAuthService } from "../auth/service.js";
import { RuntimeService } from "../runtimeService.js";
import { startServer } from "../server.js";
import type { NexusClient } from "../nexus/nexusClient.js";
import { readFile } from "node:fs/promises";

if (process.env.MOSS_CATALOG_FIXTURE !== "1")
  throw new Error("Explicit Catalog test fixture selection required");
const { config } = await readServerConfig(process.env.MOSS_SERVER_CONFIG!);
await ensureServerDirectories(config);
const store = new DirectConnectStore(config.dbPath);
ensureSqliteCompatibilityDomainSchemas(store.requireSqliteDb());
ensureCompatibilityCoreSchema(store.requireSqliteDb());
const { service: auth } = await createAuthService({
  db: store.requireSqliteDb(),
  dbPath: config.dbPath,
  tokenTtlSec: config.tokenTtlSec,
  bootstrapAdmin: config.bootstrapAdmin,
});
const values = new Map<
  string,
  { value: string; version: number; status: string }
>();
// Synthetic fixture credentials only. Keep this private file outside evidence bundles.
if (process.env.MOSS_CATALOG_FIXTURE_SECRETS) {
  const seed = JSON.parse(
    await readFile(process.env.MOSS_CATALOG_FIXTURE_SECRETS, "utf8"),
  ) as Array<[string, { value: string; version: number; status: string }]>;
  for (const [ref, secret] of seed) values.set(ref, secret);
}
const secrets = {
  getSecret: async (namespace: string, key: string) =>
    values.get(namespace + "/" + key) ?? null,
  putSecret: async (namespace: string, key: string, value: string) => {
    const ref = namespace + "/" + key;
    values.set(ref, {
      value,
      version: (values.get(ref)?.version ?? 0) + 1,
      status: "enabled",
    });
  },
  deleteSecret: async (namespace: string, key: string) => {
    values.delete(namespace + "/" + key);
  },
  listSecrets: async () => [],
  listConfiguredNamespaces: async () => [],
} as unknown as NexusClient;
const instance = await store.registerServerInstance(
  "catalog-fixture",
  process.pid,
);
const heartbeat = setInterval(() => {
  void store.heartbeatServerInstance(instance.instanceId);
}, 5000);
const runtime = new RuntimeService({
  config,
  store,
  authService: auth,
  serverInstanceId: instance.instanceId,
});
const server = startServer(config, runtime, auth, undefined, secrets);
console.log(`CATALOG_TEST_READY:${await server.ready}`);
process.once("SIGTERM", () => {
  clearInterval(heartbeat);
  void server.stop().finally(() => process.exit(0));
});
