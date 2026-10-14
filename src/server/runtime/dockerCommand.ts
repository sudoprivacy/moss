import { spawn } from 'node:child_process'

export interface DockerExecResult { code: number; stdout: string; stderr: string }

/** Run structured Docker arguments without a shell or command logging. */
export function runDocker(args: string[], timeoutMs?: number): Promise<DockerExecResult> {
  return new Promise(resolve => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = timeoutMs ? setTimeout(() => child.kill(), timeoutMs) : undefined
    child.stdout?.on('data', data => { stdout += data.toString('utf8') })
    child.stderr?.on('data', data => { stderr += data.toString('utf8') })
    child.on('error', error => {
      if (timer) clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr || String(error) })
    })
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}
