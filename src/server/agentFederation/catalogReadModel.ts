import type { AgentVersionsPage } from "../../../contracts/agent-federation/v1alpha1/contract.js";
import {
  AGENT_CATALOG_API,
  type CatalogEntry,
  type CatalogDisplayStatus,
  type CatalogPage,
  type CatalogSource,
  type ImportCandidate,
  type CatalogVersionDetail,
} from "../../../contracts/agent-catalog/v1alpha1/contract.js";
import type { AgentCatalogGovernance } from "./catalogGovernance.js";
import type { ExternalActor } from "../externalProviders/store.js";
import { ExternalProviderError } from "../externalProviders/policy.js";
import { describeCapabilities } from "./runtimeRegistry.js";
import { isStandardProtocol } from "./standardHttpAdapter.js";
import { validateCatalogDocument } from "./catalogContract.js";
import type { CatalogFilters } from "./catalogStore.js";

const code = (error: unknown) =>
  error instanceof ExternalProviderError
    ? error.code
    : "CATALOG_READ_UNAVAILABLE";
export function catalogProvider(protocol: string): CatalogEntry["provider"] {
  if (protocol.startsWith("dify/")) return "dify";
  if (protocol.startsWith("openai-")) return "openai_compatible";
  if (protocol.startsWith("mcp/")) return "mcp";
  if (protocol.startsWith("a2a/")) return "a2a";
  return "http";
}

/** Authoritative, read-only release projection. Availability is a hint; dispatch rechecks all gates. */
export class CatalogReadModel {
  constructor(readonly governance: AgentCatalogGovernance) {}
  async entry(
    actor: ExternalActor,
    id: string,
  ): Promise<{ entry: CatalogEntry; versions: CatalogVersionDetail[] }> {
    const g = this.governance,
      binding = await g.service.store.binding(actor, id);
    const source = (await g.data.managed(actor, id))?.view ?? null;
    const candidateRow = source
      ? await g.db.get(
          "SELECT document FROM agent_import_candidates WHERE org_id = ? AND source_id = ? ORDER BY " +
            (g.db.kind === "postgres"
              ? "CAST(CAST(document AS jsonb)#>>'{view,created_at}' AS BIGINT)"
              : "CAST(json_extract(document, '$.view.created_at') AS BIGINT)") +
            " DESC, id DESC LIMIT 1",
          [actor.orgId, source.id],
        )
      : undefined;
    const candidate: ImportCandidate | null = candidateRow
      ? JSON.parse(String(candidateRow.document)).view
      : null;
    const last = await g.db.get(
      "SELECT MAX(p.recorded_at) AS last_run_at FROM (SELECT " +
        (g.db.kind === "postgres"
          ? "CAST(CAST(p.document AS jsonb)->>'recorded_at' AS BIGINT)"
          : "CAST(json_extract(p.document, '$.recorded_at') AS BIGINT)") +
        ` AS recorded_at FROM agent_task_provenance p JOIN external_tasks t ON t.id = p.task_id JOIN external_session_bindings s ON s.id = t.session_id WHERE t.org_id = ? AND s.agent_id = ?) p`,
      [actor.orgId, id],
    );
    let admission: string | null = null,
      readError: string | null = null;
    try {
      await g.service.assertCatalogConfigured(actor, binding);
    } catch (e) {
      admission = code(e);
    }
    let releases: AgentVersionsPage | null = null;
    try {
      releases = await g.service.releases.list(actor, id);
      // Bounded full history prevents silently choosing the first lexicographic version.
      for (let i = 0; releases.next_cursor; i++) {
        if (i >= 19)
          throw new ExternalProviderError(503, "CATALOG_HISTORY_LIMIT");
        const next = await g.service.releases.list(
          actor,
          id,
          releases.next_cursor,
        );
        releases.items.push(...next.items);
        releases.channels = next.channels;
        releases.next_cursor = next.next_cursor;
      }
    } catch (e) {
      if (code(e) !== "AGENT_PRINCIPAL_NOT_FOUND") readError = code(e);
      releases = null;
    }
    const details: CatalogVersionDetail[] = [];
    for (const version of releases?.items ?? []) {
      const state = await g.data.version(actor, id, version.version);
      const recordedCandidate = state?.candidate_id
        ? (await g.data.candidate(actor, state.candidate_id)).view
        : null;
      const manifest = version.snapshot.sourceManifest;
      const revoked = version.decisions.find((d) => d.decision === "revoked");
      let block = admission;
      try {
        await g.assertVersion(actor, id, version.version);
        await g.service.releases.version(actor, id, version.version);
      } catch (e) {
        block = code(e);
      }
      const approval = revoked
        ? "revoked"
        : version.decisions[0]?.decision === "withdrawn"
          ? "withdrawn"
          : version.decisions.some(
                (d) => d.decision === "approved" && d.expires_at > Date.now(),
              )
            ? "approved"
            : version.decisions.some((d) => d.decision === "approved")
              ? "expired"
              : "unapproved";
      if (approval !== "approved") block ??= "AGENT_VERSION_NOT_APPROVED";
      const channels = releases!.channels
        .filter((c) => c.version === version.version)
        .map(({ name, enabled, revision }) => ({ name, enabled, revision }));
      const status: CatalogDisplayStatus = revoked
        ? "revoked"
        : state?.lifecycle === "archived"
          ? "archived"
          : state?.lifecycle === "deprecated"
            ? "deprecated"
            : block
              ? "unavailable"
              : channels.some((c) => c.enabled)
                ? "active"
                : "published";
      details.push({
        version: version.version,
        source_revision:
          recordedCandidate?.snapshot.source_revision ??
          (manifest && !isStandardProtocol(manifest)
            ? manifest.source_revision
            : null),
        source_digest: version.snapshot.source_digest,
        adapter_version: recordedCandidate?.snapshot.adapter_version ?? null,
        status,
        approval_status: approval,
        channels,
        revoke_reason: revoked?.note ?? null,
        can_promote: !block,
        promotion_block: block,
        evidence_level: manifest?.execution_revision
          ? "provider_revision_fenced"
          : "source_snapshot_only",
        source_identity: "unverified",
      });
    }
    const channels = releases?.channels ?? [];
    const stable = channels.find((c) => c.name === "stable" && c.enabled);
    const active = stable
      ? details.find((v) => v.version === stable.version && v.can_promote)
      : undefined;
    const recent = (releases ? [...releases.items] : []).sort(
      (a, b) =>
        b.created_at - a.created_at || b.version.localeCompare(a.version),
    )[0];
    const selected =
      active ?? details.find((v) => v.version === recent?.version);
    let status: CatalogDisplayStatus = active
      ? "active"
      : selected?.status === "active"
        ? "published"
        : (selected?.status ??
          (["pending_approval", "approved", "archived"].includes(
            candidate?.status ?? "",
          )
            ? (candidate!.status as CatalogDisplayStatus)
            : "draft"));
    if (binding.archived) status = "archived";
    else if (
      source?.enabled === false ||
      source?.availability === "unavailable" ||
      readError
    )
      status = "unavailable";
    const manifest = binding.sourceManifest,
      protocol = manifest?.protocol ?? "dify/chat-messages";
    const capabilities = describeCapabilities(binding);
    const isSelectable =
      status === "active" && binding.allowed_user_ids.length > 0;
    const entry: CatalogEntry = {
      catalog_id: id,
      name: binding.name,
      provider: catalogProvider(protocol),
      protocol,
      source,
      external_agent_id: binding.app_id,
      owner_id: source?.owner_id ?? null,
      org_id: actor.orgId,
      zone_id: source?.zone_id ?? null,
      execution_mode: "external_hosted",
      status,
      approval_status:
        selected?.approval_status ??
        (candidate?.status === "approved"
          ? "approved"
          : candidate?.status === "pending_approval"
            ? "pending_approval"
            : "unapproved"),
      admission_error:
        readError ??
        (isSelectable
          ? null
          : (admission ??
            selected?.promotion_block ??
            (stable ? null : "AGENT_CHANNEL_UNAVAILABLE"))),
      is_selectable: isSelectable,
      published_version: selected?.version ?? null,
      source_revision: selected ? selected.source_revision : candidate?.snapshot.source_revision ?? null,
      source_digest: selected?.source_digest ?? binding.source_digest,
      adapter_version: selected ? selected.adapter_version : candidate?.snapshot.adapter_version ?? null,
      capabilities: {
        ...capabilities,
        idempotency: capabilities.idempotency ?? "unknown",
        human_approval: capabilities.human_approval ?? "unknown",
        trace_export: capabilities.trace_export ?? "unknown",
      },
      observability: capabilities.trace_export ?? "unknown",
      last_run_at: last?.last_run_at == null ? null : Number(last.last_run_at),
      warning_count: source?.warning_count ?? 0,
      has_drift:
        ["PROVIDER_SOURCE_CHANGED", "SOURCE_REVISION_CONFLICT"].includes(
          source?.last_error ?? "",
        ) ||
        Boolean(
          candidate &&
          candidate.snapshot.source_digest !== binding.source_digest,
        ),
      channels: channels.map(({ name, version, enabled, revision }) => ({
        name,
        version,
        enabled,
        revision,
      })),
    };
    return {
      entry: validateCatalogDocument("CatalogEntry", entry),
      versions: details.map((v) =>
        validateCatalogDocument("CatalogVersionDetail", v),
      ),
    };
  }
  async page(
    actor: ExternalActor,
    after: string,
    filters: CatalogFilters,
  ): Promise<CatalogPage<CatalogEntry>> {
    const sourceFilters = {
      ...filters,
      status: filters.source_state ?? "",
      capability: "",
      observability: "",
      warning: "",
    };
    const page = await this.governance.data.page<CatalogSource>(
      actor,
      "sources",
      after,
      "",
      sourceFilters,
    );
    const entries: CatalogEntry[] = [];
    // Bound remote authority concurrency while still filtering every source page server-side.
    for (let offset = 0; offset < page.items.length; offset += 4)
      entries.push(
        ...(await Promise.all(
          page.items
            .slice(offset, offset + 4)
            .map(async (s) => (await this.entry(actor, s.catalog_id)).entry),
        )),
      );
    return {
      api_version: AGENT_CATALOG_API,
      items: entries.filter(
        (e) =>
          (!filters.status || e.status === filters.status) &&
          (!filters.approval_status ||
            e.approval_status === filters.approval_status) &&
          (!filters.provider || e.provider === filters.provider) &&
          (!filters.zone ||
            (filters.zone === "unassigned"
              ? e.zone_id === null
              : e.zone_id === filters.zone)) &&
          (!filters.execution_mode ||
            e.execution_mode === filters.execution_mode) &&
          (!filters.capability ||
            e.capabilities[
              filters.capability as keyof typeof e.capabilities
            ] === "supported") &&
          (!filters.observability ||
            e.observability === filters.observability) &&
          (filters.warning !== "true" || e.warning_count > 0) &&
          (filters.drift !== "true" || e.has_drift),
      ),
      next_cursor: page.next_cursor,
    };
  }
}
