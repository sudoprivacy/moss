/**
 * The `[Agent Home & Collaboration]` block added to the first message of an
 * agentified agent's session: what it remembers, how to search its own past
 * work, and which colleagues (other agents) it can ask or hand work to.
 *
 * Like the wiki and corp-app blocks, it lists capabilities, not identity: the
 * agent's identity stays in AGENTS.md.
 */
import type { CallableAgent } from './a2aService.js'

export interface AgentifyBlockInput {
  displayName: string
  memory: string
  collaborators: CallableAgent[]
  /** Set when this session itself serves another agent. */
  servingCall: { callerName: string; readonly: boolean } | null
}

export function buildAgentifyBlock(input: AgentifyBlockInput): string {
  const lines: string[] = []
  lines.push('[Agent Home & Collaboration]')
  lines.push(
    `You are the durable agent "${input.displayName}". Your work is kept across sessions and employees: every finished session is summarized into your agent home together with the files it produced. Use the \`agentctl\` CLI in your shell to use that memory and to work with other agents.`,
  )
  if (input.memory.trim()) {
    lines.push('')
    lines.push(input.memory.trim())
  }
  lines.push('')
  lines.push('Your memory and history:')
  lines.push('  agentctl recall "<question or keywords>"          # search your past work (summaries, outputs, notes)')
  lines.push('  agentctl history list [--limit 20]                 # your most recent work')
  lines.push('  agentctl history show <id>                         # one summary in full')
  lines.push('  agentctl files get <path> [--out <file>]           # copy a saved output into this workspace')
  lines.push('  agentctl memory add "<fact>" [--private]           # remember a fact (--private: only for this employee)')
  lines.push('Search before you redo work or say you do not know. Save durable facts with `memory add`; never save secrets.')

  if (input.collaborators.length > 0) {
    lines.push('')
    lines.push('Colleague agents you can work with:')
    for (const c of input.collaborators) {
      const desc = c.description.trim() ? ` — ${c.description.trim().slice(0, 120)}` : ''
      lines.push(`- ${c.displayName}${desc}`)
      for (const cap of c.capabilities) {
        const verb = cap.kind === 'ask' ? 'ask' : 'delegate'
        const confirm = cap.kind === 'task' && cap.requiresConfirmation ? '; needs human confirmation' : ''
        lines.push(`    ${verb} ${cap.id}: ${cap.description}${cap.input ? ` (input: ${cap.input})` : ''}${confirm}`)
      }
      if (c.canReadHistory) lines.push('    can read its shared history and outputs directly (--agent)')
    }
    lines.push('')
    lines.push('Commands:')
    lines.push('  agentctl agents                                            # refresh the list above')
    lines.push('  agentctl ask --agent <name> --capability <id> "<question>" # wait for its answer')
    lines.push('  agentctl delegate --agent <name> --capability <id> "<task>" [--wait]')
    lines.push('  agentctl call <callId>                                     # status / result of a call')
    lines.push('  agentctl recall --agent <name> "<keywords>"                # search its shared history')
    lines.push('  agentctl files get --agent <name> <path>                   # fetch one of its outputs')
    lines.push('Give the other agent a complete, self-contained request: it does not see this conversation.')
  }

  if (input.servingCall) {
    lines.push('')
    lines.push(
      `This session serves a request from the agent "${input.servingCall.callerName}".` +
        (input.servingCall.readonly ? ' It is read-only: outbound actions will be refused.' : ''),
    )
  }
  return lines.join('\n')
}
