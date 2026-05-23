import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const lockDir = path.join(os.homedir(), '.claude')
const lockPath = path.join(lockDir, 'direct-connect-server.json')

export type ServerLock = {
  pid: number
  port: number
  host: string
  httpUrl: string
  startedAt: number
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(lockDir, { recursive: true })
}

export async function writeServerLock(lock: ServerLock): Promise<void> {
  await ensureDir()
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2), 'utf8')
}

export async function removeServerLock(): Promise<void> {
  await fs.rm(lockPath, { force: true })
}

export async function probeRunningServer(): Promise<ServerLock | null> {
  try {
    const raw = await fs.readFile(lockPath, 'utf8')
    const parsed = JSON.parse(raw) as ServerLock
    process.kill(parsed.pid, 0)
    return parsed
  } catch {
    return null
  }
}
