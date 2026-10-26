import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const sha = z.string().regex(/^[a-f0-9]{64}$/)
export const deviceDeployEffectSchema = z.object({
  deploymentId: id, ownerId: id, planId: id, planSha256: sha, operationId: id,
}).strict()
export type DeviceDeployEffect = z.infer<typeof deviceDeployEffectSchema>
export const deviceDeployReceiptSchema = deviceDeployEffectSchema.extend({
  schemaVersion: z.literal(1), action: z.literal('runtime.deploy'),
  status: z.enum(['unknown', 'completed']), outcome: z.enum(['unknown', 'completed']),
  domainJoinAccepted: z.literal(false), selectionAccepted: z.boolean().optional(), productQualificationAccepted: z.boolean().optional(),
  runnerSha256: sha, implementationSha256: sha, osUid: z.number().int().nonnegative(),
  unit: z.string().regex(/^sudo-deploy-[a-f0-9]{40}\.service$/),
  originalSessionId: id.optional(), modelTurnsCompleted: z.number().int().nonnegative().optional(),
  nativeBindingPreserved: z.object({ ownerId: id, agentId: z.string().min(1).max(256),
    durableSessionId: z.string().min(1).max(256), repositoryPath: z.string().min(1).max(8192) }).optional(),
})
export interface DeviceDeployPort {
  inspect(planId: string): Promise<{ deploymentId: string; ownerId: string; planId: string; planSha256: string; description: string }>
  submit(effect: DeviceDeployEffect): Promise<unknown>
  query(effect: DeviceDeployEffect): Promise<unknown>
}

const configSchema = z.object({ schemaVersion: z.literal(1), python: z.string(), entry: z.string(),
  entrySha256: sha, registry: z.string(), sudostackRoot: z.string() }).strict()
type Config = z.infer<typeof configSchema>
const run = promisify(execFile)

function trustedPath(path: string, privateFile = false) {
  if (!isAbsolute(path)) throw new Error('Device deployment configuration requires absolute installed paths')
  for (let current = path; ; current = dirname(current)) {
    const info = lstatSync(current)
    if (info.isSymbolicLink() || (info.uid !== 0 && info.uid !== process.getuid?.()) || (info.mode & 0o022))
      throw new Error('Device deployment installation is not operator controlled')
    if (current === path && privateFile && (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 262144))
      throw new Error('Device deployment configuration must be a bounded private owner file')
    if (dirname(current) === current) break
  }
}

/** Linux device placement only. Cloud retains its existing Kubernetes adapter.
 * OS authorization and the operator-installed Edge entry are the host boundary;
 * this is neither another issuer nor an OS confinement mechanism.
 */
export class DeviceDeployClient implements DeviceDeployPort {
  constructor(private readonly config: Config) {
    if (process.platform !== 'linux') throw new Error('Device deployment requires Linux user services')
    configSchema.parse(config)
    this.verify()
  }

  static configured(): DeviceDeployClient | undefined {
    const path = process.env.MOSS_DEVICE_DEPLOY_CONFIG
    if (!path) return undefined
    trustedPath(path, true)
    return new DeviceDeployClient(configSchema.parse(JSON.parse(readFileSync(path, 'utf8'))))
  }

  private verify() {
    const c = this.config
    trustedPath(c.python); trustedPath(c.entry); trustedPath(c.registry, true); trustedPath(c.sudostackRoot)
    if (createHash('sha256').update(readFileSync(c.entry)).digest('hex') !== c.entrySha256)
      throw new Error('Installed device deployment entry changed')
  }

  private async call(command: 'inspect' | 'submit' | 'query', planId?: string, operationId?: string): Promise<any> {
    this.verify()
    if (planId !== undefined) id.parse(planId)
    if (operationId !== undefined) id.parse(operationId)
    const c = this.config
    const args = [c.entry, 'operation', command, '--registry', c.registry,
      ...(planId === undefined ? [] : ['--plan-id', planId]), ...(operationId === undefined ? [] : ['--operation-id', operationId])]
    // No bearer, login credential or caller environment is sent to the worker.
    const env = { HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME,
      PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, SUDOSTACK_DEPLOY_ROOT: c.sudostackRoot }
    try {
      const { stdout } = await run(c.python, args, { env, timeout: 45000, maxBuffer: 262144, windowsHide: true })
      return JSON.parse(stdout)
    } catch { throw new Error('Device deployment result is unconfirmed; recover the original operation') }
  }

  async inspect(planId: string) {
    return z.object({ deploymentId: id, ownerId: id, planId: id, planSha256: sha, description: z.string().max(256) })
      .parse(await this.call('inspect', planId))
  }

  private receipt(effect: DeviceDeployEffect, value: any) {
    const observed = deviceDeployReceiptSchema.parse(value)
    for (const key of Object.keys(effect) as (keyof DeviceDeployEffect)[])
      if (effect[key] !== observed[key]) throw new Error('Device deployment receipt belongs to another effect')
    return observed
  }

  async submit(effect: DeviceDeployEffect) {
    const selected = await this.inspect(effect.planId)
    if (selected.deploymentId !== effect.deploymentId || selected.ownerId !== effect.ownerId || selected.planSha256 !== effect.planSha256)
      throw new Error('Operator approval changed before device deployment')
    return this.receipt(effect, await this.call('submit', effect.planId, effect.operationId))
  }

  async query(effect: DeviceDeployEffect) {
    return this.receipt(effect, await this.call('query', undefined, effect.operationId))
  }
}
