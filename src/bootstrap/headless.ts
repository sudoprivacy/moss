import { init } from '../entrypoints/init.js'
import { setProjectRoot, setOriginalCwd, setCwdState } from './state.js'
import { findGitRoot } from '../utils/git.js'
import { processSessionStartHooks } from '../utils/sessionStart.js'
import type { Message } from '../types/message.js'
import { setCwd } from '../utils/Shell.js'
import { getAllMcpConfigs } from '../services/mcp/config.js'
import { captureHooksConfigSnapshot } from '../utils/hooks/hooksConfigSnapshot.js'
import { prefetchAllMcpResources } from '../services/mcp/client.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import type { Tool } from '../Tool.js'
import type { Command } from '../commands.js'
import { getAgentDefinitionsWithOverrides, type AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { initializeLspServerManager } from '../services/lsp/manager.js'

let globalInitDone = false

export interface BootstrapResult {
  initialMessages: Message[]
  mcp: {
    clients: MCPServerConnection[]
    tools: Tool[]
    commands: Command[]
  }
  agents: AgentDefinition[]
}

/**
 * Performs a unified headless initialization, ensuring both the CLI and SDK
 * have full feature parity (Skills, Plugins, CLAUDE.md, MCP, etc.).
 *
 * @param cwd The working directory for the session
 * @returns Initialization results to pass to the QueryEngine and AppState
 */
export async function bootstrapHeadless(cwd: string): Promise<BootstrapResult> {
  // 1. Global one-time initialization
  if (!globalInitDone) {
    globalInitDone = true

    await init()
    // Note: initBundledSkills() and initBuiltinPlugins() are now called at
    // module initialization time in electron-direct.ts to ensure bundled
    // skills are registered before any memoized getCommands() call.
    // This matches the pattern in main.tsx:2004.

    // Initialize LSP manager (non-blocking)
    // This will use whatever plugins/servers are available in the user's environment
    initializeLspServerManager()
  }

  // 2. Set context for the current session
  setCwd(cwd)
  setOriginalCwd(cwd)
  setCwdState(cwd)

  const gitRoot = await findGitRoot(cwd)
  if (gitRoot) {
    setProjectRoot(gitRoot)
  } else {
    setProjectRoot(cwd)
  }

  // 3. Load MCP configurations and prefetch resources
  const { servers: mcpConfigs } = await getAllMcpConfigs()
  const mcpResources = await prefetchAllMcpResources(mcpConfigs)

  // 4. Load agent definitions (supports .claude/agents/*.md)
  const agentDefinitions = await getAgentDefinitionsWithOverrides(cwd)

  // 5. Load SessionStart hooks (includes CLAUDE.md and plugin hooks)
  // This must run after context is set and MCP is initialized.
  captureHooksConfigSnapshot()
  const hookMessages = await processSessionStartHooks('startup')

  return {
    initialMessages: hookMessages,
    mcp: mcpResources,
    agents: agentDefinitions.activeAgents,
  }
}
