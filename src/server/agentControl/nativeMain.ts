import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { installNativeControlPlugin, runNativeControlTool } from './nativePlugin.js'

async function stdinJson() {
  const parts: Buffer[] = []
  let size = 0
  for await (const part of process.stdin) {
    const bytes = Buffer.from(part)
    size += bytes.byteLength
    if (size > 40 * 1024) throw new Error('Control input exceeded limit')
    parts.push(bytes)
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown
}

try {
  const [mode, directory, origin] = process.argv.slice(2)
  let result: unknown
  if (mode === 'install' && directory && origin && process.argv.length === 5)
    result = await installNativeControlPlugin(directory, origin, await stdinJson(), fileURLToPath(import.meta.url))
  else if (mode === 'tool' && process.argv.length === 3)
    result = await runNativeControlTool(dirname(fileURLToPath(import.meta.url)), process.env.SUDOCODE_TOOL_NAME ?? '',
      await stdinJson(), process.env.SUDOCODE_TOOL_CALL_ID)
  else throw new Error('Invalid control entry')
  process.stdout.write(JSON.stringify(result) + '\n')
} catch {
  // Errors can originate in URLs, JSON and OS tools: do not print their raw
  // strings, which might contain a token supplied during private setup.
  process.stderr.write('Moss control entry refused or unavailable. No automatic retry; retain any original operation ID.\n')
  process.exitCode = 1
}
