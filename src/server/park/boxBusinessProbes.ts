import { createHash } from 'node:crypto'
import type { AuthService } from '../auth/service.js'
import type { DocumentStore } from '../documentStore.js'
import { getModelProviderApiKey } from '../modelListCache.js'
import { resolveModelSelection } from '../modelProviders.js'
import { HttpError } from '../httpError.js'
import { readPolicySources } from './policySources.js'
import { searchParkPolicySources } from './policySearch.js'
import type { ParkStore } from './store.js'

const modelResults = new Map<string, { version: string; result: Record<string, unknown> }>()

/** Uses the selected organization provider; status preserves the last real inference. */
export async function probeBoxModel(auth: AuthService, orgId: string, inference: boolean) {
  const settings = await auth.getOrganizationSystemSettings(orgId)
  const selected = resolveModelSelection(settings.modelProviders, settings.defaultModelProviderId, settings.model, settings.model)
  const key = getModelProviderApiKey(selected.provider.id, settings.apiKey, orgId)
  const configuration = { provider: selected.provider.id, protocol: selected.provider.protocol, base_url: selected.provider.baseUrl, model: selected.modelId }
  const version = createHash('sha256').update(JSON.stringify(configuration)).digest('hex')
  const previous = modelResults.get(orgId)
  const model: Record<string, unknown> = { configured: Boolean(key), ...configuration, configuration_version: version,
    ...(previous?.version === version ? previous.result : { healthy: null, checked_at: null }) }
  if (!key) throw new HttpError(503, 'The organization model credential is missing')
  if (selected.provider.protocol !== 'openai-completions') throw new HttpError(503, 'Park consultation requires openai-completions')
  if (inference) {
    const started = Date.now()
    modelResults.delete(orgId)
    const response = await fetch(`${selected.provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: selected.modelId, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 16, stream: false }),
    })
    if (!response.ok) {
      modelResults.set(orgId, { version, result: { healthy: false, checked_at: Date.now(), reason: `HTTP ${response.status}` } })
      throw new HttpError(502, `Organization model inference failed (HTTP ${response.status})`)
    }
    const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
    if (typeof body.choices?.[0]?.message?.content !== 'string' || !body.choices[0].message.content.trim()) throw new HttpError(502, 'Organization model returned no text')
    Object.assign(model, { healthy: true, latency_ms: Date.now() - started, checked_at: Date.now() })
    modelResults.set(orgId, { version, result: { healthy: true, latency_ms: model.latency_ms, checked_at: model.checked_at } })
  }
  return model
}

/** Checks the same built corpus used by consultation, including its verified sources. */
export async function probeBoxBusiness(store: ParkStore, documents: DocumentStore, auth: AuthService, orgId: string, inference: boolean) {
  const model = await probeBoxModel(auth, orgId, inference)
  const config = await store.config(orgId)
  const wikiId = (JSON.parse(config?.assistant_config ?? '{}') as { policy_wiki_id?: string }).policy_wiki_id
  if (!wikiId) throw new HttpError(503, 'The public Assistant has no policy Wiki')
  const wiki = await documents.getWiki(wikiId, orgId)
  if (!wiki || wiki.buildStatus !== 'succeeded') throw new HttpError(503, 'The policy Wiki is not built')
  const sources = await readPolicySources(wiki.storagePath, wikiId)
  if (!sources.length) throw new HttpError(503, 'The policy Wiki has no verified source documents')
  const query = sources[0]!.source.fileName.replace(/\.[^.]+$/, '')
  const matches = await searchParkPolicySources(wiki.storagePath, wikiId, query)
  if (!matches.length) throw new HttpError(503, 'The policy retrieval verification returned no sources')
  return { model, policy: { healthy: true, wiki_id: wikiId, built_at: wiki.lastBuiltAt, source_count: sources.length, match_count: matches.length }, assistant: { healthy: config?.assistant_status === 'published' } }
}
