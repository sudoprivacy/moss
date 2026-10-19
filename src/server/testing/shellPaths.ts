import { existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

/** Use Git for Windows tools when the Windows bash launcher resolves to WSL. */
export function shellTestCommand(command: 'bash' | 'awk'): string {
  if (process.platform !== 'win32') return command
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory || !existsSync(join(directory, 'git.exe'))) continue
    const gitRoot = resolve(directory, '..')
    const executable = join(gitRoot, command === 'bash' ? 'bin' : 'usr', ...(command === 'bash' ? [] : ['bin']), `${command}.exe`)
    if (existsSync(executable)) return executable
  }
  throw new Error(`Git for Windows ${command}.exe is required for shell script tests`)
}

/** Convert native Windows paths for Bash without changing POSIX filenames. */
export function toShellPath(path: string): string {
  return process.platform === 'win32' ? path.replaceAll('\\', '/') : path
}

/** Convert only the explicitly identified path variables, leaving other values intact. */
export function shellPathEnvironment(paths: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(paths).map(([name, path]) =>
    [name, toShellPath(path)]))
}
