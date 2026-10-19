import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

/** Run a bounded real subprocess without blocking other fixtures' local HTTP servers. */
export async function runFixtureProcess(command: string, args: string[], options: {
  cwd?: string
  env?: NodeJS.ProcessEnv
  shell?: boolean
  timeoutMs: number
}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: options.shell,
    detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  let isTimedOut = false
  let termination: Promise<unknown> | undefined
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
    isTimedOut = true
    termination = process.platform === 'win32'
      ? promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 })
      : Promise.resolve().then(() => process.kill(-child.pid!, 'SIGKILL'))
    void termination.catch(() => {})
  }, options.timeoutMs)
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    await termination
    if (isTimedOut) throw new Error(`Fixture subprocess exceeded ${options.timeoutMs}ms: ${command}\n${stdout}\n${stderr}`)
    return { status, stdout, stderr }
  } finally { clearTimeout(timer) }
}
