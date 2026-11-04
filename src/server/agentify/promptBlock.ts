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
  lines.push('  agentctl recall "<question or keywords>"          # search your past work: summaries, notes, and the content of')
  lines.push('                                                     # input/output files (spreadsheet rows, documents, PDFs)')
  lines.push('  agentctl history list [--limit 20]                 # your most recent work')
  lines.push('  agentctl history show <id>                         # one summary in full')
  lines.push('  agentctl files get <path> [--out <file>]           # copy a saved output into this workspace')
  lines.push('  agentctl memory add "<fact>" [--private]           # remember a fact (--private: only for this employee)')
  lines.push('Search before you redo work or say you do not know. Save durable facts with `memory add`; never save secrets.')
  lines.push('A file hit shows where the file is kept. For its data, `agentctl files get <that path>.extract.json`: every sheet')
  lines.push('as JSON rows keyed by column name (dates as ISO strings), or a document/PDF as text — no spreadsheet library needed.')
  lines.push('Each hit\'s `from:` line says how that work came about: an employee\'s conversation, another agent\'s request, or a')
  lines.push('scheduled task run (job name and the run\'s start time). Scheduled runs are kept one per run.')

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
    }
    lines.push('')
    lines.push('Commands:')
    lines.push('  agentctl agents                                            # refresh the list above')
    lines.push('  agentctl ask --agent <name> --capability <id> "<question>" # wait for its answer')
    lines.push('  agentctl delegate --agent <name> --capability <id> "<task>" [--wait]')
    lines.push('  agentctl call <callId> [--save]                            # status / result of a call; --save fetches its files')
    lines.push('Give the other agent a complete, self-contained request: it does not see this conversation.')
    lines.push('You cannot search or open another agent\'s history yourself. Ask it; files it hands over come back with')
    lines.push('the answer, and `ask` / `call --wait` save them into ./from-<agent>/ in this workspace.')
  }

  if (input.servingCall) {
    lines.push('')
    lines.push(
      `This session serves a request from the agent "${input.servingCall.callerName}".` +
        (input.servingCall.readonly ? ' It is read-only: outbound actions will be refused.' : ''),
    )
    lines.push(
      `Recall, history and files show only what you share with "${input.servingCall.callerName}". To hand over a saved file:`,
    )
    lines.push('  agentctl handoff <path or file name>                       # it goes back with your answer')
    lines.push('Files you create in this workspace are handed over automatically.')
  }
  return lines.join('\n')
}
