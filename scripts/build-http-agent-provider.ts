import { mkdir, rm } from 'node:fs/promises'
import { providerBuildSource, writeProviderManifest } from './http-agent-artifact.mjs'
const source = providerBuildSource(process.cwd())
await mkdir('dist/http-agent-provider', { recursive: true })
await rm('dist/http-agent-provider/artifact-manifest.json', { force: true })
const result = await Bun.build({
  entrypoints: ['src/server/agentFederation/provider/main.ts'],
  outdir: 'dist/http-agent-provider', naming: 'http-agent-provider.mjs', target: 'node',
  external: ['pg-native'], minify: false,
})
if (!result.success) { console.error(result.logs); process.exitCode = 1 }
else writeProviderManifest(process.cwd(), 'dist/http-agent-provider', source, { bun: Bun.version, platform: process.platform, arch: process.arch })
