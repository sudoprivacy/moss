import { existsSync } from 'node:fs'
import { basename, delimiter, dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

/** Deployment-script tests need native Bash/awk, not the Windows WSL alias. */
export function testShellEnvironment() {
  if (process.platform !== 'win32') return process.env
  const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true })
  if (git.error || git.status !== 0 || !git.stdout.trim()) {
    throw new Error('Windows server tests require Git for Windows with native Bash and awk')
  }
  const shellDirectory = resolve(git.stdout.trim(), '../../../usr/bin')
  if (!['bash.exe', 'awk.exe'].every(name => existsSync(resolve(shellDirectory, name)))) {
    throw new Error(`Native Git Bash and awk were not found in ${shellDirectory}`)
  }
  // npm installs a .cmd/.ps1 launcher, which Node's direct spawn cannot run.
  const bun = spawnSync('bun', ['-p', 'process.execPath'], { encoding: 'utf8', windowsHide: true, shell: true })
  const bunExecutable = bun.stdout?.trim()
  if (bun.error || bun.status !== 0 || !bunExecutable || basename(bunExecutable).toLowerCase() !== 'bun.exe' || !existsSync(bunExecutable)) {
    throw new Error('Windows server tests require the native Bun executable behind its launcher')
  }
  const inheritedPath = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'path')?.[1] || ''
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'path'))
  // Git's usr/bin also contains a POSIX whoami. Keep Windows system tools
  // ahead of it: the native control installer needs Windows whoami /user.
  const gitBin = resolve(shellDirectory, '../../bin')
  if (!['bash.exe', 'sh.exe'].every(name => existsSync(resolve(gitBin, name)))) {
    throw new Error(`Native Git shell launchers were not found in ${gitBin}`)
  }
  return { ...environment, PATH: [dirname(bunExecutable), gitBin, inheritedPath, shellDirectory].join(delimiter) }
}
