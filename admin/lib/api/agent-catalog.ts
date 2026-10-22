import type { ExternalAgentAdmin } from "./external-agents";
import { dcClient } from "./client";
import type {
  CatalogSource,
  ImportCandidate,
  SourceSyncResult,
  CatalogAuditEvent,
  CatalogPage,
  CatalogVersionState,
  CatalogRun,
} from "../../../contracts/agent-catalog/v1alpha1/contract";
export type {
  CatalogSource,
  ImportCandidate,
  SourceSyncResult,
  CatalogAuditEvent,
  CatalogVersionState,
  CatalogRun,
} from "../../../contracts/agent-catalog/v1alpha1/contract";

export interface CatalogFilters {
  search?: string;
  protocol?: string;
  status?: string;
  owner?: string;
  warning?: string;
  capability?: string;
  observability?: string;
}
export function createAgentCatalogApi(signal?: () => AbortSignal) {
  const base = "/api/v1/external-agents/admin/catalog";
  async function request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const current = signal?.();
    const reply =
      method === "GET"
        ? await dcClient.get<{ success: boolean; data: T }>(base + path, {
            signal: current,
          })
        : await dcClient.post<{ success: boolean; data: T }>(
            base + path,
            body,
            { signal: current },
          );
    current?.throwIfAborted();
    if (!reply.success || reply.data === undefined)
      throw new Error("CATALOG_UNAVAILABLE");
    return reply.data;
  }
  const page = <T>(
    kind: string,
    after = "",
    filter = "",
    query: CatalogFilters = {},
  ) =>
    request<CatalogPage<T>>(
      "GET",
      `/${kind}?${new URLSearchParams({ after, filter, ...query })}`,
    );
  return {
    managed: async (ids: string[]) => {
      const chunks: string[][] = [];
      for (let start = 0; start < ids.length; start += 100)
        chunks.push(ids.slice(start, start + 100));
      const pages = await Promise.all(
        chunks.map((chunk) =>
          request<CatalogSource[]>(
            "GET",
            `/managed?ids=${encodeURIComponent(chunk.join(","))}`,
          ),
        ),
      );
      return pages.flat();
    },
    sources: (after = "", query: CatalogFilters = {}) =>
      page<CatalogSource>("sources", after, "", query),
    candidates: (after = "", source = "", query: CatalogFilters = {}) =>
      page<ImportCandidate>("candidates", after, source, query),
    audit: (after = "", agent = "", query: CatalogFilters = {}) =>
      page<CatalogAuditEvent>("audit", after, agent, query),
    syncs: (after = "", source = "") =>
      page<SourceSyncResult>("syncs", after, source),
    runs: (agent: string, after = "") =>
      request<CatalogPage<CatalogRun>>(
        "GET",
        `/agents/${encodeURIComponent(agent)}/runs?after=${encodeURIComponent(after)}`,
      ),
    attach: (catalog_id: string, revision: number) =>
      request<CatalogSource>("POST", "/sources", { catalog_id, revision }),
    source: (id: string) =>
      request<CatalogSource>("GET", `/sources/${encodeURIComponent(id)}`),
    agent: (id: string) =>
      request<{
        agent: ExternalAgentAdmin;
        source: CatalogSource | null;
        versions: CatalogVersionState[];
      }>("GET", `/agents/${encodeURIComponent(id)}`),
    update: (
      source: CatalogSource,
      change: {
        name?: string;
        endpoint?: string;
        enabled?: boolean;
        source_definition?: string;
        allowed_user_ids?: string[];
        review_note?: string;
      },
    ) =>
      request<CatalogSource>(
        "POST",
        `/sources/${encodeURIComponent(source.id)}/update`,
        { revision: source.revision, ...change },
      ),
    test: (id: string) =>
      request<{
        checked_at: number;
        protocol: string;
        adapter_version: string;
      }>("POST", `/sources/${encodeURIComponent(id)}/test`, {}),
    sync: (source: CatalogSource, renew = false, note = "") =>
      request<SourceSyncResult>(
        "POST",
        `/sources/${encodeURIComponent(source.id)}/sync`,
        { revision: source.revision, renew, note },
      ),
    decide: (
      candidate: ImportCandidate,
      action: string,
      note: string,
      review_days = 7,
    ) =>
      request<ImportCandidate>(
        "POST",
        `/candidates/${encodeURIComponent(candidate.id)}/decide`,
        { revision: candidate.revision, action, note, review_days },
      ),
    publish: (candidate: ImportCandidate) =>
      request<ImportCandidate>(
        "POST",
        `/candidates/${encodeURIComponent(candidate.id)}/publish`,
        { revision: candidate.revision },
      ),
    reconcile: (candidate: ImportCandidate) =>
      request<ImportCandidate>(
        "POST",
        `/candidates/${encodeURIComponent(candidate.id)}/reconcile`,
        {},
      ),
    lifecycle: (
      agent: string,
      version: string,
      lifecycle: "deprecated" | "archived",
      note: string,
    ) =>
      request<CatalogVersionState>(
        "POST",
        `/agents/${encodeURIComponent(agent)}/lifecycle`,
        { version, lifecycle, note },
      ),
  };
}
