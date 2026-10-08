import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MOSS_HOME } from '../utils/skills/localSkillDirectories.js'
import type { WorkspaceFileAccess } from './backends/podWorkspace.js'
import { normalizeWorkspaceRelativePath } from './sessionWorkspace.js'

/** Load the server's builtin instructions independently of the tenant catalog. */
export async function loadWikiBuilderPrompt(root = MOSS_HOME): Promise<string> {
  const instructions = await readFile(join(root, 'assistants', 'system', 'wiki-builder', 'wiki-builder.md'), 'utf8')
  if (!instructions.trim()) throw new Error('Wiki builder instructions are empty')
  return `${instructions.trim()}\n\nRead the staged documents in input/ and complete this unattended build. Write WIKI.md and the chunk files to the workspace root. Use only the source documents; do not ask the user questions.\n\n请开始构建 Wiki。`
}

/** Deliver parsed source files to the filesystem used by the running agent. */
export async function copyWikiInputsToRuntime(stageDir: string, workspace: Pick<WorkspaceFileAccess, 'writeFile'>): Promise<void> {
  const visit = async (relativePath: string): Promise<void> => {
    for (const entry of await readdir(join(stageDir, relativePath), { withFileTypes: true })) {
      const file = `${relativePath}/${entry.name}`
      if (entry.isSymbolicLink()) throw new Error('Wiki source files must not be symbolic links')
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) await workspace.writeFile(file, await readFile(join(stageDir, file)))
    }
  }
  await visit('input')
}

/** Collect generated pages and images without exporting runtime configuration. */
export async function copyWikiOutputsFromRuntime(stageDir: string, workspace: Pick<WorkspaceFileAccess, 'listTree' | 'readFile'>): Promise<void> {
  for (const entry of await workspace.listTree(12)) {
    if (entry.isDir) continue
    const relativePath = normalizeWorkspaceRelativePath(entry.relativePath)
    const isOutput = relativePath === 'WIKI.md' || relativePath === '_moss_images.md' ||
      (!relativePath.includes('/') && /^chunk-\d{3,}-.+\.md$/.test(relativePath)) || relativePath.startsWith('images/')
    if (!isOutput) continue
    if (entry.isSymbolicLink) throw new Error('Wiki output files must not be symbolic links')
    const destination = join(stageDir, relativePath)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, await workspace.readFile(relativePath))
  }
}
