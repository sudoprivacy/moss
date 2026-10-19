import { spawn } from 'node:child_process'
import { verify } from 'node:crypto'
import { lstat, readFile, readdir, statfs } from 'node:fs/promises'
import { basename, isAbsolute, resolve, sep } from 'node:path'
import os from 'node:os'
import { HttpError } from '../httpRespond.js'

type HookName = 'backup' | 'restore' | 'upgrade' | 'rollback' | 'reindex' | 'modelCheck'

export interface BoxOperationOptions {
  rootDir: string
  backupDir?: string
  upgradeDir?: string
  publicKeyPath?: string
  hooks?: Partial<Record<HookName, string>>
  healthUrls?: string[]
  version?: string
  run?: (command: string, args: string[]) => Promise<string>
}

async function execute(command: string, args: string[]): Promise<string> {
  if (!isAbsolute(command)) throw new HttpError(503, 'Box operation executable must be an absolute path')
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => { child.kill(); reject(new HttpError(504, 'Box operation timed out')) }, 10 * 60_000)
    child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-20_000) })
    child.stderr.on('data', chunk => { output = (output + String(chunk)).slice(-20_000) })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) reject(new HttpError(502, `Box operation failed (${code}): ${output.slice(-500)}`))
      else resolvePromise(output)
    })
  })
}

export class BoxOperations {
  private readonly run: (command: string, args: string[]) => Promise<string>

  constructor(private readonly options: BoxOperationOptions) {
    this.run = options.run ?? execute
  }

  private hook(name: HookName): string {
    const path = this.options.hooks?.[name]
    if (!path || !isAbsolute(path)) throw new HttpError(503, `${name} operation is not configured`)
    return path
  }

  private directory(kind: 'backup' | 'upgrade'): string {
    const path = kind === 'backup' ? this.options.backupDir : this.options.upgradeDir
    if (!path || !isAbsolute(path)) throw new HttpError(503, `${kind} directory is not configured`)
    return resolve(path)
  }

  private async file(kind: 'backup' | 'upgrade', name: string): Promise<string> {
    const directory = this.directory(kind)
    if (!name || basename(name) !== name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new HttpError(400, 'Invalid file name')
    const target = resolve(directory, name)
    if (!target.startsWith(`${directory}${sep}`)) throw new HttpError(400, 'Invalid file path')
    const info = await lstat(target).catch(() => null)
    if (!info?.isFile()) throw new HttpError(404, 'File not found')
    return target
  }

  async status(): Promise<unknown> {
    const disk = await statfs(this.options.rootDir)
    const health = await Promise.all((this.options.healthUrls ?? []).map(async url => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
        return { url, healthy: response.ok, status: response.status }
      } catch { return { url, healthy: false, status: 0 } }
    }))
    let model: unknown = { configured: false }
    if (this.options.hooks?.modelCheck) {
      try { model = JSON.parse(await this.run(this.hook('modelCheck'), [])) }
      catch { model = { configured: true, healthy: false } }
    }
    const archives = await this.list('backup').catch(() => [])
    const upgrades = await this.list('upgrade').catch(() => [])
    return {
      version: this.options.version ?? null,
      platform: os.platform(),
      uptime_seconds: Math.floor(process.uptime()),
      memory: { total_bytes: os.totalmem(), free_bytes: os.freemem() },
      disk: { total_bytes: Number(disk.blocks) * Number(disk.bsize), free_bytes: Number(disk.bavail) * Number(disk.bsize) },
      health, model, archives, upgrades,
      available_actions: Object.fromEntries((['backup', 'restore', 'upgrade', 'rollback', 'reindex'] as HookName[]).map(name => [name, Boolean(this.options.hooks?.[name])])),
    }
  }

  async list(kind: 'backup' | 'upgrade'): Promise<string[]> {
    const directory = this.directory(kind)
    const entries = await readdir(directory, { withFileTypes: true })
    return entries.filter(entry => entry.isFile() && (kind === 'backup' ? /\.(?:sqlite|db|dump|tar|gz)$/i : /\.(?:tar|gz|zip)$/i).test(entry.name)).map(entry => entry.name).sort()
  }

  async backup(): Promise<string> {
    const command = this.hook('backup')
    return this.run(command, [this.directory('backup')])
  }

  async restore(name: string): Promise<string> {
    const archive = await this.file('backup', name)
    return this.run(this.hook('restore'), [archive])
  }

  async verifyUpgrade(name: string): Promise<boolean> {
    const archive = await this.file('upgrade', name)
    const signaturePath = await this.file('upgrade', `${name}.sig`)
    const keyPath = this.options.publicKeyPath
    if (!keyPath || !isAbsolute(keyPath)) throw new HttpError(503, 'Upgrade public key is not configured')
    const [content, signature, key] = await Promise.all([readFile(archive), readFile(signaturePath), readFile(keyPath)])
    return verify(null, content, key, signature)
  }

  async upgrade(name: string): Promise<string> {
    if (!(await this.verifyUpgrade(name))) throw new HttpError(400, 'Upgrade signature is invalid')
    const archive = await this.file('upgrade', name)
    try { return await this.run(this.hook('upgrade'), [archive]) }
    catch (error) {
      if (this.options.hooks?.rollback) await this.run(this.hook('rollback'), [])
      throw error
    }
  }

  async rollback(): Promise<string> { return this.run(this.hook('rollback'), []) }
  async reindex(): Promise<string> { return this.run(this.hook('reindex'), []) }
}

export function boxOperationsFromEnvironment(rootDir: string): BoxOperations {
  const list = (process.env.PARK_BOX_HEALTH_URLS ?? '').split(',').map(value => value.trim()).filter(Boolean)
  return new BoxOperations({
    rootDir,
    backupDir: process.env.PARK_BOX_BACKUP_DIR,
    upgradeDir: process.env.PARK_BOX_UPGRADE_DIR,
    publicKeyPath: process.env.PARK_BOX_UPGRADE_PUBLIC_KEY,
    version: process.env.PARK_BOX_VERSION,
    healthUrls: list,
    hooks: {
      backup: process.env.PARK_BOX_BACKUP_BIN,
      restore: process.env.PARK_BOX_RESTORE_BIN,
      upgrade: process.env.PARK_BOX_UPGRADE_BIN,
      rollback: process.env.PARK_BOX_ROLLBACK_BIN,
      reindex: process.env.PARK_BOX_REINDEX_BIN,
      modelCheck: process.env.PARK_BOX_MODEL_CHECK_BIN,
    },
  })
}
