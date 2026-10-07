/**
 * The agents a person has, as the sidebar needs to show them.
 *
 * Three kinds exist and only one of them is stored:
 *
 *   - the implicit default, which exists because the user does;
 *   - ones the user made, rows in `user_agents`;
 *   - ones instantiated from a template, which have no row at all — they are
 *     implied by the sessions that used the template.
 *
 * Assembling that is the server's job, not the client's. The client has the
 * references on each conversation but no way to turn one into a name without
 * knowing which of the three kinds it is and where each kind's name lives,
 * which would put the whole template-is-not-an-agent distinction into the UI
 * layer — the one place it has so far been absent.
 */

import {
  defaultAgentName,
  isDefaultAgentName,
  isUserCreatedAgentName,
  userCreatedAgentName,
} from './agentIdentity.js'
import { listUserAgents } from './userAgentStore.js'

export type MyAgentKind = 'default' | 'own' | 'template'

export type MyAgent = {
  /** What a session stores in `assistantName`, and what the client sends back. */
  ref: string
  displayName: string
  kind: MyAgentKind
}

type SessionAssistantLister = (input: {
  orgId: string
  userId: string
}) => Promise<Array<{ assistantName: string | null }>>

type TemplateNameResolver = (ref: string) => Promise<string>

/**
 * Every agent this user has, oldest-anchored so the list does not reshuffle:
 * the default first, then the ones they made in the order they made them, then
 * the templates they have actually used.
 *
 * A template the user has never opened a session with is not one of their
 * agents — it is a template, and it belongs to the template library. Listing it
 * here would put every catalog entry in the sidebar and undo the distinction.
 */
export async function listMyAgents(input: {
  orgId: string
  userId: string
  defaultDisplayName: string
  listSessionAssistants: SessionAssistantLister
  resolveTemplateName: TemplateNameResolver
}): Promise<MyAgent[]> {
  const agents: MyAgent[] = [
    {
      ref: defaultAgentName(input.userId),
      displayName: input.defaultDisplayName,
      kind: 'default',
    },
  ]

  for (const own of await listUserAgents(input.orgId, input.userId)) {
    agents.push({
      ref: userCreatedAgentName(own.id),
      displayName: own.displayName,
      kind: 'own',
    })
  }

  const sessions = await input.listSessionAssistants({ orgId: input.orgId, userId: input.userId })
  const templateRefs: string[] = []
  for (const session of sessions) {
    const ref = session.assistantName
    if (!ref) continue
    if (isDefaultAgentName(ref) || isUserCreatedAgentName(ref)) continue
    if (!templateRefs.includes(ref)) templateRefs.push(ref)
  }

  for (const ref of templateRefs) {
    agents.push({
      ref,
      // A template whose catalog entry has gone — uninstalled, or renamed out
      // from under an old session — still has conversations hanging off it, so
      // it is listed under the reference rather than dropped. A conversation
      // the user can see must belong to something they can see.
      displayName: await input.resolveTemplateName(ref).catch(() => ref),
      kind: 'template',
    })
  }

  return agents
}
