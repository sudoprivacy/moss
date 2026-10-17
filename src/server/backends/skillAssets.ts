import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { MAX_RESOURCE_BYTES, MAX_RESOURCE_ENTRIES, MAX_RESOURCE_FILE_BYTES, ownerFileMode } from '@sudo/resource-files'
import { WORKSPACE_SKILLS_DIRECTORY } from '../../utils/skills/localSkillDirectories.js'

interface SkillLink {
  name: string
  sourcePath: string
}

interface SkillAsset {
  path: string
  content: Buffer
  mode: number
}

/** Read the authorized skill payload before creating a remote runtime. */
export async function collectSkillAssets(
  links: SkillLink[],
  options: { includeInstructions?: boolean } = {},
): Promise<SkillAsset[]> {
  const assets: SkillAsset[] = []
  let bytes = 0
  let entries = 0
  for (const link of links) {
    if (!link.name || /[\\/]/.test(link.name) || ['.', '..'].includes(link.name)) {
      throw new Error('Invalid skill directory name')
    }
    if (++entries > MAX_RESOURCE_ENTRIES) throw new Error('Skill files exceed entry limit')
    const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
      if (depth > 32) throw new Error('Skill directory nesting exceeds limit')
      for (const name of await readdir(directory)) {
        if (name === '.git' || name === '__pycache__') continue
        if (++entries > MAX_RESOURCE_ENTRIES) throw new Error('Skill files exceed entry limit')
        const source = join(directory, name)
        const stat = await lstat(source)
        if (stat.isSymbolicLink()) throw new Error('Skill assets must not contain symlinks')
        const path = posix.join(prefix, name)
        if (stat.isDirectory()) {
          await visit(source, path, depth + 1)
        } else if (stat.isFile()) {
          // Legacy container backends deliver SKILL.md through a Secret mount.
          if (!options.includeInstructions && depth === 0 && name === 'SKILL.md') continue
          bytes += stat.size
          if (stat.size > MAX_RESOURCE_FILE_BYTES || bytes > MAX_RESOURCE_BYTES) {
            throw new Error('Skill assets exceed size limit')
          }
          const content = await readFile(source)
          if (content.length !== stat.size) throw new Error('Skill asset changed during preparation')
          assets.push({ path, content, mode: ownerFileMode(stat.mode) })
        } else {
          throw new Error('Skill assets must be regular files')
        }
      }
    }
    await visit(link.sourcePath, posix.join(WORKSPACE_SKILLS_DIRECTORY, link.name), 0)
  }
  return assets
}
