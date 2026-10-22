import type { AgentCatalogGovernance } from "./catalogGovernance.js";
import type { ExternalActor } from "../externalProviders/store.js";
import { ExternalProviderError } from "../externalProviders/policy.js";
import { ConfiguredAgentProviderAdapter } from "./catalogAdapter.js";
import { validateCatalogDocument } from "./catalogContract.js";
import { CatalogReadModel } from "./catalogReadModel.js";

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
  const read = new CatalogReadModel(governance);
  if (method === "GET" && path === "entries") {
    const filters = Object.fromEntries(
      [
        "search",
        "protocol",
        "status",
        "owner",
        "warning",
        "capability",
        "observability",
        "approval_status",
        "provider",
        "zone",
        "execution_mode",
        "source_state",
        "drift",
      ].map((k) => [k, url.searchParams.get(k) ?? ""]),
    );
    return read.page(actor, url.searchParams.get("after") ?? "", filters);
  }
  if (method === "GET" && path === "summaries") {
    const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
    if (ids.length > 100 || ids.some((id) => !/^[\w-]{1,200}$/.test(id)))
      throw new ExternalProviderError(400, "INVALID_CATALOG_FILTER");
    const result = [];
    for (let i = 0; i < ids.length; i += 4)
      result.push(
        ...(await Promise.all(
          ids
            .slice(i, i + 4)
            .map(async (id) => (await read.entry(actor, id)).entry),
        )),
      );
    return result;
  }
  const eventMatch = /^agents\/([\w-]+)\/runs\/([\w-]+)\/events$/.exec(path);
  if (method === "GET" && eventMatch) {
    await governance.service.store.binding(actor, eventMatch[1]);
    const row = await data.db.get(
      "SELECT t.user_id FROM external_tasks t JOIN external_session_bindings s ON s.id = t.session_id WHERE t.org_id = ? AND t.id = ? AND s.agent_id = ?",
      [actor.orgId, eventMatch[2], eventMatch[1]],
    );
    if (!row) throw new ExternalProviderError(404, "TASK_NOT_FOUND");
    const cursor = Number(url.searchParams.get("cursor") ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new ExternalProviderError(400, "INVALID_CURSOR");
    const task = await governance.service.store.task(
      { orgId: actor.orgId, userId: String(row.user_id) },
      eventMatch[2],
    );
    const rows = await data.db.all(
      "SELECT sequence, document FROM task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence LIMIT 101",
      [task.id, cursor],
    );
    const events = rows.slice(0, 100).map((row) => {
      const e = JSON.parse(String(row.document));
      return validateCatalogDocument("CatalogRunEvent", {
        sequence: Number(row.sequence),
        at: e.created_at,
        type: e.type,
        status: e.state?.status ?? e.status ?? null,
        error_code: e.state?.error_code ?? null,
      });
    });
    return {
      events,
      next_cursor: events.at(-1)?.sequence ?? cursor,
      has_more: rows.length > 100,
      compacted: events.length ? events[0].sequence > cursor + 1 : cursor === 0,
    };
  }
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
    const overview = await read.entry(actor, id);
    return {
      agent: governance.admin.describe(binding),
      entry: overview.entry,
      version_details: overview.versions,
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
