import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, writeFile, rename, unlink, stat, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'

export const ARCHIVE_CHUNK_BYTES = 4 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 10 * 1024 ** 3
const SHA256 = /^[a-f0-9]{64}$/
const ID = /^user-[a-f0-9]{16}-[a-f0-9-]{36}$/
const Input = z.object({
  displayName: z.string().trim().min(1).max(120),
  engines: z.array(z.enum(['codex', 'claude-code', 'sudocode'])).min(1).max(3),
  size: z.number().int().positive().max(MAX_ARCHIVE_BYTES),
  sha256: z.string().regex(SHA256),
  sessionCount: z.number().int().min(0).max(1000000),
}).strict()

interface Owner { orgId: string; userId: string }
export interface PrivateAgentArchive extends z.infer<typeof Input> {
  agentName: string
  createdAt: string
  chunkBytes: number
  format: 'sudowork-agent-archive-v1'
  status: 'uploading' | 'ready'
  canSpawn: false
}

export class ArchiveError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

/** Private snapshots are independent of runtime placement and the template catalog. */
export class PrivateAgentArchives {
  constructor(private root: string) {}

  private ownerRoot(owner: Owner): string {
    if (!owner.orgId || !owner.userId) throw new ArchiveError(401, 'Unauthorized')
    const key = createHash('sha256').update(JSON.stringify([owner.orgId, owner.userId])).digest('hex')
    return join(this.root, key, 'agents')
  }

  private directory(owner: Owner, id: string): string {
    if (!ID.test(id)) throw new ArchiveError(404, 'Archive not found')
    return join(this.ownerRoot(owner), id)
  }

  async list(owner: Owner): Promise<PrivateAgentArchive[]> {
    let entries: string[]
    try { entries = await readdir(this.ownerRoot(owner)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const items = await Promise.all(entries.filter(name => ID.test(name)).map(name => this.get(owner, name)))
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async create(owner: Owner, input: unknown): Promise<PrivateAgentArchive> {
    const parsed = Input.safeParse(input)
    if (!parsed.success) throw new ArchiveError(400, 'Invalid archive manifest')
    const root = this.ownerRoot(owner)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const lockPath = join(root, '.reservation.lock')
    let lock
    try { lock = await open(lockPath, 'wx', 0o600) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ArchiveError(409, 'Another archive reservation is in progress; retry shortly')
      throw error
    }
    try {
    const existing = await this.list(owner)
    // Pending reservations also count: abandoning an upload must not bypass the limit.
    if (existing.length >= 200 || existing.reduce((sum, item) => sum + item.size, 0) + parsed.data.size > 50 * 1024 ** 3) {
      throw new ArchiveError(413, 'Private archive storage limit reached')
    }
    const ownerKey = createHash('sha256').update(JSON.stringify([owner.orgId, owner.userId])).digest('hex').slice(0, 16)
    const item: PrivateAgentArchive = {
      ...parsed.data, agentName: `user-${ownerKey}-${randomUUID()}`, createdAt: new Date().toISOString(),
      chunkBytes: ARCHIVE_CHUNK_BYTES, format: 'sudowork-agent-archive-v1', status: 'uploading', canSpawn: false,
    }
    const dir = join(root, `.staging-${randomUUID()}`)
    await mkdir(dir, { mode: 0o700 })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(item), { flag: 'wx', mode: 0o600 })
    await rename(dir, this.directory(owner, item.agentName))
    return item
    } finally { await lock.close(); await unlink(lockPath) }
  }

  async get(owner: Owner, id: string): Promise<PrivateAgentArchive> {
    try { return JSON.parse(await readFile(join(this.directory(owner, id), 'manifest.json'), 'utf8')) as PrivateAgentArchive } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ArchiveError(404, 'Archive not found')
      throw error
    }
  }

  private chunkLength(item: PrivateAgentArchive, index: number): number {
    if (!Number.isSafeInteger(index) || index < 0 || index >= Math.ceil(item.size / item.chunkBytes)) throw new ArchiveError(400, 'Invalid chunk index')
    return Math.min(item.chunkBytes, item.size - index * item.chunkBytes)
  }

  async put(owner: Owner, id: string, index: number, body: Buffer, sha256: string): Promise<void> {
    const item = await this.get(owner, id)
    const size = this.chunkLength(item, index)
    if (body.length !== size || !SHA256.test(sha256) || createHash('sha256').update(body).digest('hex') !== sha256) throw new ArchiveError(400, 'Chunk checksum or size mismatch')
    const file = join(this.directory(owner, id), `${index}.chunk`)
    try {
      const current = await readFile(file)
      if (current.equals(body)) return
      throw new ArchiveError(409, 'Chunk already exists with different content')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (item.status !== 'uploading') throw new ArchiveError(409, 'Archive is immutable')
    const temp = `${file}.${randomUUID()}.tmp`
    await writeFile(temp, body, { mode: 0o600, flag: 'wx' })
    // Hard-link creates the final chunk atomically and never overwrites another request.
    const { link } = await import('node:fs/promises')
    try { await link(temp, file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!(await readFile(file)).equals(body)) throw new ArchiveError(409, 'Conflicting chunk')
    } finally { await unlink(temp) }
  }

  async complete(owner: Owner, id: string): Promise<PrivateAgentArchive> {
    const item = await this.get(owner, id)
    if (item.status === 'ready') return item
    const dir = this.directory(owner, id)
    const hash = createHash('sha256')
    for (let i = 0; i < Math.ceil(item.size / item.chunkBytes); i++) {
      const file = join(dir, `${i}.chunk`)
      let size: number
      try { size = (await stat(file)).size } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ArchiveError(409, 'Upload incomplete')
        throw error
      }
      if (size !== this.chunkLength(item, i)) throw new ArchiveError(409, 'Chunk size mismatch')
      for await (const bytes of createReadStream(file)) hash.update(bytes)
    }
    if (hash.digest('hex') !== item.sha256) throw new ArchiveError(409, 'Archive checksum mismatch')
    item.status = 'ready'
    const temp = join(dir, `manifest-${randomUUID()}.tmp`)
    await writeFile(temp, JSON.stringify(item), { mode: 0o600, flag: 'wx' })
    await rename(temp, join(dir, 'manifest.json'))
    return item
  }

  async chunk(owner: Owner, id: string, index: number): Promise<{ path: string; size: number }> {
    const item = await this.get(owner, id)
    if (item.status !== 'ready') throw new ArchiveError(409, 'Upload incomplete')
    return { path: join(this.directory(owner, id), `${index}.chunk`), size: this.chunkLength(item, index) }
  }
}

async function boundedBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new ArchiveError(413, 'Request too large')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** Called only after Moss has authenticated the bearer token. Never accepts an owner in the body. */
export async function handlePrivateAgentArchives(req: IncomingMessage, res: ServerResponse, pathname: string, owner: Owner, store: PrivateAgentArchives): Promise<boolean> {
  const prefix = '/api/v1/agents/private-archives'
  if (pathname !== prefix && !pathname.startsWith(prefix + '/')) return false
  res.setHeader('Cache-Control', 'private, no-store')
  const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
  try {
    if (pathname === prefix && req.method === 'GET') { json(200, { agents: await store.list(owner) }); return true }
    if (pathname === prefix && req.method === 'POST') {
      let body: unknown
      try { body = JSON.parse((await boundedBody(req, 8192)).toString()) } catch (error) {
        if (error instanceof ArchiveError) throw error
        throw new ArchiveError(400, 'Invalid JSON')
      }
      json(201, await store.create(owner, body)); return true
    }
    const match = pathname.slice(prefix.length).match(/^\/([^/]+)(?:\/(complete|chunks)(?:\/(\d+))?)?$/)
    if (!match) throw new ArchiveError(404, 'Not found')
    const [, id, action, part] = match
    if (!action && req.method === 'GET') { json(200, await store.get(owner, id!)); return true }
    if (action === 'complete' && part === undefined && req.method === 'POST') { json(200, await store.complete(owner, id!)); return true }
    if (action === 'chunks' && part !== undefined) {
      if (req.method === 'PUT') {
        await store.get(owner, id!)
        await store.put(owner, id!, Number(part), await boundedBody(req, ARCHIVE_CHUNK_BYTES), String(req.headers['x-content-sha256'] || ''))
        json(200, { ok: true }); return true
      }
      if (req.method === 'GET') {
        const file = await store.chunk(owner, id!, Number(part))
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.size })
        await pipeline(createReadStream(file.path), res); return true
      }
    }
    throw new ArchiveError(405, 'Method not allowed')
  } catch (error) {
    if (res.headersSent) { res.destroy(); return true }
    if (error instanceof ArchiveError) json(error.status, { error: error.message })
    else json(500, { error: 'Archive operation failed' })
    return true
  }
}
