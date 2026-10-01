import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSkillAssets } from '../backends/skillAssets.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'moss-skill-assets-'))
  roots.push(root)
  await mkdir(join(root, 'scripts'))
  await writeFile(join(root, 'SKILL.md'), '# Media')
  return root
}

describe('remote skill assets', () => {
  test('copies nested scripts and binary data while leaving SKILL.md to its Secret', async () => {
    const root = await fixture()
    await writeFile(join(root, 'scripts', 'run.py'), 'print("ready")')
    await writeFile(join(root, 'scripts', 'icon.bin'), Buffer.from([0, 128, 255]))
    const files = await collectSkillAssets([{ name: 'media', sourcePath: root }])
    expect(files.map(file => file.path).sort()).toEqual(['.nexus/sudocode/skills/media/scripts/icon.bin', '.nexus/sudocode/skills/media/scripts/run.py'])
    expect(files.find(file => file.path.endsWith('icon.bin'))?.content).toEqual(Buffer.from([0, 128, 255]))
  })
  test('preserves executable scripts without granting group or world access', async () => {
    const root = await fixture()
    await writeFile(join(root, 'scripts', 'run.sh'), '#!/bin/sh\ntrue\n')
    await chmod(join(root, 'scripts', 'run.sh'), 0o755)
    const files = await collectSkillAssets([{ name: 'media', sourcePath: root }])
    expect(files[0]?.mode).toBe(process.platform === 'win32' ? 0o600 : 0o700)
  })
  test('rejects directory traversal in skill names', async () => {
    await expect(collectSkillAssets([{ name: '../outside', sourcePath: await fixture() }])).rejects.toThrow('Invalid skill')
  })
  test('rejects symlinked directories rather than copying outside the skill', async () => {
    const root = await fixture()
    await symlink(root, join(root, 'scripts', 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(collectSkillAssets([{ name: 'media', sourcePath: root }])).rejects.toThrow('symlinks')
  })
})
