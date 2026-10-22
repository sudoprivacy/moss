import type { AgentCatalogGovernance } from "./catalogGovernance.js";
import type { ExternalActor } from "../externalProviders/store.js";
import { ExternalProviderError } from "../externalProviders/policy.js";
import { ConfiguredAgentProviderAdapter } from "./catalogAdapter.js";

/** Mounted only behind the external-agent administrator role check. */
export async function dispatchCatalogGovernance(
  governance: AgentCatalogGovernance,
  actor: ExternalActor,
  method: string,
  url: URL,
  body: unknown,
) {
  const path = url.pathname.slice(
    "/api/v1/external-agents/admin/catalog/".length,
  );
  const { data } = governance;
  if (method === "GET" && path === "managed") {
    const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
    if (ids.length > 100 || ids.some((id) => !/^[\w-]{1,200}$/.test(id)))
      throw new ExternalProviderError(400, "INVALID_CATALOG_FILTER");
    await data.ready;
    if (!ids.length) return [];
    const rows = await data.db.all(
      `SELECT document FROM agent_catalog_sources WHERE org_id = ? AND catalog_id IN (${ids.map(() => "?").join(",")})`,
      [actor.orgId, ...ids],
    );
    return rows.map((row) => JSON.parse(String(row.document)).view);
  }
  if (
    method === "GET" &&
    ["sources", "candidates", "syncs", "audit"].includes(path)
  ) {
    return data.page(
      actor,
      path as "sources" | "candidates" | "syncs" | "audit",
      url.searchParams.get("after") ?? "",
      url.searchParams.get("filter") ?? "",
      Object.fromEntries(
        [
          "search",
          "protocol",
          "status",
          "owner",
          "warning",
          "capability",
          "observability",
        ].map((key) => [key, url.searchParams.get(key) ?? ""]),
      ),
    );
  }
  if (path === "sources" && method === "POST")
    return governance.attach(actor, body);
  const match =
    /^(sources|candidates|agents)\/([\w-]+)(?:\/(update|sync|test|decide|publish|reconcile|lifecycle|runs))?$/.exec(
      path,
    );
  if (!match) throw new ExternalProviderError(404, "NOT_FOUND");
  const [, kind, id, action] = match;
  if (method === "GET" && kind === "agents" && action === "runs")
    return governance.runs(actor, id, url.searchParams.get("after") ?? "");
  if (method === "GET" && !action) {
    if (kind === "sources") return (await data.source(actor, id)).view;
    if (kind === "candidates") return (await data.candidate(actor, id)).view;
    const binding = await governance.service.store.binding(actor, id);
    return {
      agent: governance.admin.describe(binding),
      source: (await data.managed(actor, id))?.view ?? null,
      versions: (
        await data.db.all(
          "SELECT document FROM agent_catalog_versions WHERE org_id = ? AND catalog_id = ? ORDER BY version",
          [actor.orgId, id],
        )
      ).map((row) => JSON.parse(String(row.document))),
    };
  }
  if (method === "POST" && kind === "sources") {
    if (action === "update") return governance.updateSource(actor, id, body);
    if (action === "sync") return governance.sync(actor, id, body);
    if (action === "test") {
      const source = await data.source(actor, id),
        binding = await governance.service.store.binding(
          actor,
          source.view.catalog_id,
        );
      try {
        const result = await new ConfiguredAgentProviderAdapter(
          governance.admin,
          actor,
          source,
          binding,
        ).fetchAgent(AbortSignal.timeout(10000));
        await data.audit(actor, "source.connection_test", binding.id, {
          source_id: id,
        });
        return {
          checked_at: Date.now(),
          protocol: result.snapshot.protocol,
          adapter_version: result.snapshot.adapter_version,
          capabilities: result.snapshot.capabilities,
        };
      } catch (error) {
        await data.audit(actor, "source.connection_test", binding.id, {
          source_id: id,
          result: "failed",
          reason:
            error instanceof ExternalProviderError
              ? error.code
              : "PROVIDER_PREFLIGHT_FAILED",
        });
        throw error;
      }
    }
  }
  if (method === "POST" && kind === "candidates") {
    if (action === "decide") return governance.decide(actor, id, body);
    if (action === "publish") return governance.publish(actor, id, body);
    if (action === "reconcile") return governance.reconcile(actor, id);
  }
  if (method === "POST" && kind === "agents" && action === "lifecycle")
    return governance.lifecycle(actor, id, body);
  throw new ExternalProviderError(404, "NOT_FOUND");
}
