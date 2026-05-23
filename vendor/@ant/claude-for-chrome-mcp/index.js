// Stub for internal Anthropic package @ant/claude-for-chrome-mcp

const BROWSER_TOOLS = []

function createClaudeForChromeMcpServer(context) {
  return {
    connect: async () => {
      context?.logger?.info('ClaudeForChromeMcpServer stub')
    },
  }
}

module.exports = {
  BROWSER_TOOLS,
  createClaudeForChromeMcpServer,
}
