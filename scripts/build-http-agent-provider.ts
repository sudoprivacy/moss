import { mkdir } from 'node:fs/promises'
await mkdir('dist/http-agent-provider', { recursive: true })
const result = await Bun.build({
  entrypoints: ['src/server/agentFederation/provider/main.ts'],
  outdir: 'dist/http-agent-provider', naming: 'http-agent-provider.mjs', target: 'node',
  external: ['pg-native'], minify: false,
})
if (!result.success) { console.error(result.logs); process.exitCode = 1 }
