/**
 * Rehearse the embedded Nexus upgrade with real binaries on a COPY of a real
 * data directory. Never point it at live data: it works on a temporary copy.
 *
 *   npx tsx scripts/nexus-upgrade-rehearsal.ts \
 *     --data ~/sudoprivacy/ruigu_prod/moss/.moss/nexus/data \
 *     --new  <dir with nexusd (0.8.x) and plugins/> \
 *     --legacy <dir with nexusd (0.1.5) and plugins/>
 *
 * Scenarios, each on its own copy:
 *   upgrade   old data → new daemon, every secret verified against the old daemon
 *   restart   the upgraded data starts directly on the new daemon
 *   hold      MOSS_NEXUS_UPGRADE=hold keeps the old daemon on old data
 *
 * Prints counts and outcomes only; secret values never leave the daemons.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { NexusManager } from '../src/server/nexus/nexusManager.js'
import { NexusClient } from '../src/server/nexus/nexusClient.js'

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const v = i >= 0 ? process.argv[i + 1] : undefined
  if (!v) throw new Error(`--${name} is required`)
  return resolve(v.replace(/^~/, process.env.HOME ?? '~'))
}

const source = arg('data')
const newDir = arg('new')
const legacyDir = arg('legacy')
const port = 23300 + Math.floor(Math.random() * 500)

function layout(root: string): { app: string; nexusDir: string } {
  const app = join(root, 'app')
  mkdirSync(join(app, 'bin', 'nexus', 'legacy'), { recursive: true })
  symlinkSync(join(newDir, 'nexusd'), join(app, 'bin', 'nexus', 'nexusd'))
  symlinkSync(join(newDir, 'plugins'), join(app, 'bin', 'nexus', 'plugins'))
  symlinkSync(join(legacyDir, 'nexusd'), join(app, 'bin', 'nexus', 'legacy', 'nexusd'))
  symlinkSync(join(legacyDir, 'plugins'), join(app, 'bin', 'nexus', 'legacy', 'plugins'))
  const nexusDir = join(root, 'nexus')
  mkdirSync(nexusDir, { recursive: true })
  cpSync(source, join(nexusDir, 'data'), { recursive: true })
  return { app, nexusDir }
}

async function countSecrets(): Promise<number> {
  const c = new NexusClient(`127.0.0.1:${port}`)
  try {
    return (await c.listSecrets()).length
  } finally {
    c.vfs().close()
  }
}

async function scenario(name: string, run: (ctx: { app: string; nexusDir: string; start: () => Promise<NexusManager> }) => Promise<string>): Promise<boolean> {
  const root = mkdtempSync(join(tmpdir(), `nexus-rehearsal-${name}-`))
  const prevCwd = process.cwd()
  const prevHome = process.env.HOME
  const managers: NexusManager[] = []
  try {
    const ctx = layout(root)
    process.chdir(ctx.app)
    // nexusd keeps a node identity under $HOME; keep it inside the sandbox.
    process.env.HOME = join(root, 'home')
    mkdirSync(process.env.HOME, { recursive: true })
    const outcome = await run({
      ...ctx,
      start: async () => {
        const m = new NexusManager({ nexusDir: ctx.nexusDir, config: { mode: 'embedded', grpcPort: port } })
        managers.push(m)
        await m.start()
        return m
      },
    })
    console.log(`PASS ${name}: ${outcome}`)
    return true
  } catch (err) {
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`)
    return false
  } finally {
    for (const m of managers) await m.stop().catch(() => undefined)
    process.chdir(prevCwd)
    process.env.HOME = prevHome
    rmSync(root, { recursive: true, force: true })
  }
}

const results: boolean[] = []

results.push(await scenario('upgrade', async ({ start }) => {
  const m = await start()
  const r = m.upgradeReport
  if (r?.status !== 'upgraded' || !r.verified) throw new Error(`unexpected report ${JSON.stringify(r)}`)
  const n = await countSecrets()
  if (n !== r.secrets) throw new Error(`report says ${r.secrets} secrets, daemon serves ${n}`)
  return `${r.from} → ${r.to}, ${n} secrets verified, backup kept`
}))

results.push(await scenario('restart', async ({ start }) => {
  const first = await start()
  await first.stop()
  const second = await start()
  if (second.runningVersion !== first.runningVersion) throw new Error('version changed between restarts')
  return `restarted on upgraded data with ${second.runningVersion}, ${await countSecrets()} secrets`
}))

results.push(await scenario('hold', async ({ start }) => {
  process.env.MOSS_NEXUS_UPGRADE = 'hold'
  try {
    const m = await start()
    if (m.upgradeReport?.status !== 'held') throw new Error(`expected held, got ${m.upgradeReport?.status}`)
    return `kept ${m.runningVersion} on old data, ${await countSecrets()} secrets`
  } finally {
    delete process.env.MOSS_NEXUS_UPGRADE
  }
}))

process.exit(results.every(Boolean) ? 0 : 1)
