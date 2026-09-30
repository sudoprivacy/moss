import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { VisibleTo } from '@/lib/api/agent-hub'
import { checkWikiScopes, type AgentKind, type WikiScopeCheck } from '@/lib/api/document-center'

/**
 * Warns when an agent reaches further than a wiki bound to it. Binding is
 * always allowed; what users outside the wiki's own scope get depends on the
 * agent (server-side agentDelegationPolicy):
 * - delegated (tenant wiki on an admin-managed agent) → they get it through the agent;
 * - not delegated (private wikis, custom agents, wikis a non-admin 专属 author
 *   can't widen) → they don't see it in the agent.
 */
export function WikiScopeWarnings({
  agentVisibleTo,
  agentKind,
  agentAuthorId,
  wikiIds,
  wikiNames,
}: {
  agentVisibleTo: VisibleTo | null | undefined
  agentKind: AgentKind
  agentAuthorId?: string | null
  wikiIds: string[]
  wikiNames: Map<string, string>
}) {
  const [results, setResults] = useState<WikiScopeCheck[]>([])
  const scopeKey = JSON.stringify([agentVisibleTo ?? null, agentKind, agentAuthorId ?? null])
  const idsKey = wikiIds.join(',')

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      checkWikiScopes({ visibleTo: agentVisibleTo, kind: agentKind, authorId: agentAuthorId }, wikiIds)
        .then(r => { if (!cancelled) setResults(r) })
        .catch(() => { if (!cancelled) setResults([]) })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, idsKey])

  const current = results.filter(r => wikiIds.includes(r.wiki_id))
  const wider = current.filter(r => !r.covered)
  const disabled = current.filter(r => !r.enabled)
  if (wider.length === 0 && disabled.length === 0) return null
  const name = (id: string) => wikiNames.get(id) ?? id

  return (
    <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      {wider.map(r => (
        <p key={`w-${r.wiki_id}`} className="flex items-start gap-1.5">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span>
            「{name(r.wiki_id)}」
            {r.delegated
              ? '的可用范围小于该智能体：超出范围的用户将通过该智能体访问此知识库。'
              : r.scope === 'private'
                ? '为私有知识库：可用该智能体、但不在其可用范围内的用户，在该智能体中看不到它。'
                : '的可用范围小于该智能体：超出范围的用户在该智能体中看不到它（仅管理员创建或管理的智能体可代为授权）。'}
          </span>
        </p>
      ))}
      {disabled.map(r => (
        <p key={`d-${r.wiki_id}`} className="flex items-start gap-1.5">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span>「{name(r.wiki_id)}」已停用，该智能体暂不会使用它。</span>
        </p>
      ))}
    </div>
  )
}
