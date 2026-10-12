import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { RuntimeReleaseSchema, requirePairedEngine } from '../src/server/runtime/runtimeRelease.js'

const [releaseId, imageReference, imageDigest, archivePath, scodeVersionPath, cohostVersionPath, binaryDigest, outputPath] = process.argv.slice(2)
if (![releaseId, imageReference, imageDigest, archivePath, scodeVersionPath, cohostVersionPath, binaryDigest, outputPath].every(Boolean)) {
  throw new Error('release, image, config digest, archive, version reports, binary digest and output are required')
}
const paired = requirePairedEngine(readFileSync(scodeVersionPath!, 'utf8'), readFileSync(cohostVersionPath!, 'utf8'))
const pins = JSON.parse(readFileSync(new URL('../src/server/nexus/runtime-versions.json', import.meta.url), 'utf8')) as Record<string, string>
if (paired.engine.version !== pins.scode?.replace(/^v/, '') || paired.cohost.version !== pins['nexusd-cohost']) {
  throw new Error('The observed runtime does not match the release pins')
}
const hash = createHash('sha256')
for await (const chunk of createReadStream(archivePath!)) hash.update(chunk)
const manifest = RuntimeReleaseSchema.parse({
  schemaVersion: 1, releaseId, engine: paired.engine,
  cohost: { version: paired.cohost.version, nexusVersion: paired.cohost.nexusVersion,
    pluginAbi: paired.cohost.pluginAbi, binaryDigest },
  issuerVersion: pins['nexusd-cluster'],
  image: { reference: imageReference, digest: imageDigest, digestKind: 'oci-config' },
  archive: { name: basename(archivePath!), digest: `sha256:${hash.digest('hex')}` },
})
writeFileSync(outputPath!, `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`Verified shared runtime ${manifest.releaseId}: engine ${manifest.engine.commit}\n`)
