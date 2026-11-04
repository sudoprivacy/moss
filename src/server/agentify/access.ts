/**
 * Who may see what an agent keeps.
 *
 * Everything in an agent home belongs to that agent. Its own employees see it
 * according to each data type's level and lists (see SharingConfig). Another
 * agent never reads it directly: it asks, and the session answering it runs
 * with an `agent` viewer, so it can find and hand over only what is shared
 * with that agent. Administrators see everything.
 */
import {
  type AccessList,
  type AgentIdentity,
  type AgentifyConfig,
  type ShareType,
  listAdmits,
  listAdmitsAgent,
} from './config.js'
import type { DocRow } from './store.js'

export type Viewer =
  | { kind: 'admin' }
  /** An employee using this agent directly. */
  | { kind: 'user'; userId: string; userName?: string | null }
  /** Another agent, through a session that answers its call. */
  | { kind: 'agent'; agent: AgentIdentity }

export type DocLike = Pick<DocRow, 'kind' | 'userId' | 'docKey' | 'meta'>

/** Which sharing rule applies to a document; `personal` = an employee's own memory notes. */
export function docShareType(doc: DocLike): ShareType | 'personal' {
  switch (doc.kind) {
    case 'summary':
    case 'a2a':
      return 'summary'
    case 'conversation':
      return 'conversation'
    case 'input':
      return 'input'
    case 'memory':
      return doc.docKey.startsWith('memory:user:') ? 'personal' : 'sharedMemory'
    case 'artifact':
      // The session's file list follows the outputs it describes.
      if (doc.docKey.startsWith('artifacts:')) return 'output'
      return doc.meta.role === 'intermediate' ? 'intermediate' : doc.meta.role === 'input' ? 'input' : 'output'
  }
  return 'personal'
}

/** The employee list in effect for one type. */
export function usersListFor(config: AgentifyConfig, type: ShareType): AccessList {
  return config.sharing[type].users ?? config.sharing.users
}

/** The agent list in effect for one type: the type's own, the sharing default, else the callers list. */
export function agentsListFor(config: AgentifyConfig, type: ShareType): AccessList {
  return config.sharing[type].agents ?? config.sharing.agents ?? config.a2a.callers
}

/** May this viewer see data of this type owned by `ownerUserId`? */
export function canAccessType(type: ShareType | 'personal', ownerUserId: string | null, viewer: Viewer, config: AgentifyConfig): boolean {
  if (viewer.kind === 'admin') return true
  if (type === 'personal') return viewer.kind === 'user' && ownerUserId !== null && ownerUserId === viewer.userId
  const rule = config.sharing[type]
  if (viewer.kind === 'user') {
    if (ownerUserId !== null && ownerUserId === viewer.userId) return true
    if (rule.level === 'private') return false
    return listAdmits(usersListFor(config, type), [viewer.userId, viewer.userName])
  }
  // Another agent: only data opened to agents, never anyone's private data,
  // even when the employee behind the call owns it (the answer lands in the
  // calling agent's history, which other employees may see).
  if (rule.level !== 'agents') return false
  return listAdmitsAgent(agentsListFor(config, type), viewer.agent)
}

export function canAccessDoc(doc: DocLike, viewer: Viewer, config: AgentifyConfig): boolean {
  return canAccessType(docShareType(doc), doc.userId, viewer, config)
}

/** Short description of a viewer for error messages and logs. */
export function viewerLabel(viewer: Viewer): string {
  if (viewer.kind === 'admin') return 'an administrator'
  if (viewer.kind === 'user') return viewer.userName ?? viewer.userId
  return viewer.agent.displayName
}
