import { isDefaultAgentName } from './agentIdentity.js'

export const AGENTS_MD_HEADER = '# Moss Application Role'
export const PROJECT_AGENT_INSTRUCTIONS_PATH = '.nexus/sudocode/AGENTS.md'

export interface AgentInstructionsInput {
  assistantName: string
  assistantDisplayName?: string | null
  assistantRules?: string | null
  sharedMemory?: string | null
  userProfile?: string | null
}

/** Render the selected application role independently of its execution backend. */
export function buildAgentInstructions(params: AgentInstructionsInput): string | null {
  const isRoleDefined = !isDefaultAgentName(params.assistantName)
  if (!isRoleDefined && !params.assistantRules?.trim() && !params.sharedMemory?.trim() && !params.userProfile?.trim()) return null
  const identityName = params.assistantDisplayName?.trim() || params.assistantName
  const lines = [AGENTS_MD_HEADER, '']
  if (isRoleDefined) {
    lines.push(
      '## Application role',
      'Follow the role, identity, and response instructions defined in Assistant Rules below.',
      `If those rules do not specify an identity, use ${identityName} as your assistant name.`,
      'Explain this role and its responsibilities when asked about your role.',
      'Keep the application role distinct from the underlying model and runtime. Answer questions about model identity truthfully; do not invent or deny it.',
      '',
    )
  }
  if (params.userProfile?.trim()) {
    lines.push('## Current user profile', '', params.userProfile.trim(), '')
  }
  if (params.sharedMemory?.trim()) {
    lines.push('## Shared User Memory',
      'Use the following persisted cross-session user memory when the user asks who they are, what their name is, or asks you to recall known preferences. Prefer this memory over guessing from the local environment.',
      '', params.sharedMemory.trim(), '')
  }
  if (params.assistantRules?.trim()) lines.push('## Assistant Rules', '', params.assistantRules.trim(), '')
  return `${lines.join('\n').trimEnd()}\n`
}

/** Identify only application-owned instruction files before replacing their contents. */
export function isManagedAgentInstructions(contents: string): boolean {
  return contents.startsWith(AGENTS_MD_HEADER) || contents.startsWith('# Moss Assistant Override')
}
