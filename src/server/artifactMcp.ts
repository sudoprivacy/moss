import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { artifactDeclarationsSchema } from './artifacts.js'

const server = new McpServer({ name: 'moss-artifacts-mcp-server', version: '1.0.0' })
server.registerTool('moss_declare_artifacts', {
  description: 'Declare generated final deliverables or temporary drafts. Files must exist in this workspace. JSON must be valid. Do not declare uploaded/existing input files. Set release=true only when no later step needs a draft at its current path. Moss validates provenance and archives released drafts after execution.',
  inputSchema: artifactDeclarationsSchema.shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ files }) => {
  try {
    const workspace = await realpath(process.cwd())
    for (const file of files) {
      const target = await realpath(path.resolve(workspace, file.path))
      const relative = path.relative(workspace, target)
      if (relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).some(p => ['.moss', '.nexus', '.git'].includes(p))) throw new Error('Only workspace artifact files may be declared')
      if (!(await stat(target)).isFile()) throw new Error('Artifact must be a regular file')
      if (file.intent === 'final' && path.extname(target).toLowerCase() === '.json') JSON.parse(await readFile(target, 'utf8'))
    }
    return { content: [{ type: 'text', text: 'Declaration received. Moss will verify generated-file provenance and publish validated deliverables when this turn finishes.' }] }
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: `Declaration failed: ${String(error)}. Correct the file and retry once.` }] }
  }
})
await server.connect(new StdioServerTransport())
