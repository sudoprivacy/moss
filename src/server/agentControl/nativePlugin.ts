import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile, copyFile, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AGENT_CONTROL_PROTOCOL, agentControlCatalog, agentControlTools } from './contract.js'
import { NativeControlClient, nativeControlConfigSchema } from './nativeClient.js'

interface NativePluginTool {
  name: string; description: string; inputSchema: unknown
  command: string; args: string[]; required_permission: string
}

/** Explicit operator setup only. stdin holds the just-issued delegation; the
 * human login token is never saved, passed in argv or exposed as a model tool.
 */
export async function installNativeControlPlugin(directory: string, origin: string, issued: any, runtimeFile: string) {
  const config = nativeControlConfigSchema.parse({ protocol: AGENT_CONTROL_PROTOCOL, origin,
    accessToken: issued?.credential?.accessToken, delegationId: issued?.delegation?.id,
    deploymentId: issued?.delegation?.target?.deploymentId, expiresAt: issued?.delegation?.expiresAt,
    actions: issued?.delegation?.actions })
  const client = new NativeControlClient(config)
  const actions = await client.capabilities()
  if (actions.length === 0) throw new Error('No currently authorized control tools')
  const root = resolve(directory)
  // Exclusive creation: no overwrite, reuse of an unrelated directory or
  // in-place credential rotation while an old operation is unresolved.
  await mkdir(root, { mode: 0o700 })
  if (process.platform === 'win32') {
    const run = promisify(execFile)
    const { stdout } = await run('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true })
    const sid = /\bS-1-\d+(?:-\d+)+\b/.exec(stdout)?.[0]
    if (!sid) throw new Error('Cannot determine private install owner')
    await run('icacls', [root, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true })
  }
  await mkdir(join(root, '.sudocode-plugin'), { mode: 0o700 })
  await copyFile(runtimeFile, join(root, 'control.mjs'), constants.COPYFILE_EXCL)
  await writeFile(join(root, 'control.json'), JSON.stringify(config) + '\n', { flag: 'wx', mode: 0o600 })
  const tools = agentControlTools(actions).map<NativePluginTool>(tool => ({ name: tool.name, description: tool.description,
    inputSchema: tool.inputSchema, command: 'node', args: ['./control.mjs', 'tool'],
    required_permission: tool.mutating ? 'workspace-write' : 'read-only' }))
  // Querying a receipt never repeats the effect; this is the recovery path
  // shown by an Unknown result, including a fresh tool call from the model.
  tools.push({ name: 'moss_control_operation', description: 'Read an existing control receipt after an unknown result; never execute or resend the command.',
    inputSchema: { type: 'object', properties: { operationId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } },
      required: ['operationId'], additionalProperties: false }, command: 'node', args: ['./control.mjs', 'tool'], required_permission: 'read-only' })
  await writeFile(join(root, '.sudocode-plugin', 'plugin.json'), JSON.stringify({ name: 'moss-agent-control', version: '0.1.0',
    description: 'Bounded Moss control delegation. Nexus chat identity and device deployment authorization remain separate.', tools }, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 })
  return { protocol: AGENT_CONTROL_PROTOCOL, pluginDirectory: root, expiresAt: config.expiresAt, tools: tools.map(tool => tool.name) }
}

export async function runNativeControlTool(directory: string, name: string, input: unknown, callId?: string) {
  const filename = join(directory, 'control.json'), info = await lstat(filename)
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
    throw new Error('Control configuration must be a private regular file')
  if (info.size > 16_384) throw new Error('Control configuration exceeded limit')
  const client = new NativeControlClient(nativeControlConfigSchema.parse(JSON.parse(await readFile(filename, 'utf8'))))
  if (name === 'moss_control_operation') {
    if (!input || typeof input !== 'object' || Object.keys(input).length !== 1 || !('operationId' in input) || typeof input.operationId !== 'string')
      throw new Error('An existing operation ID is required')
    return client.operation(input.operationId)
  }
  const action = (Object.keys(agentControlCatalog) as Array<keyof typeof agentControlCatalog>).find(action => agentControlCatalog[action].name === name)
  if (!action || !callId) throw new Error('A supported native tool and host invocation context are required')
  return client.invoke(action, input, callId)
}
