import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { z } from 'zod'
import { RuntimeReleaseSchema, requirePairedEngine } from '@sudo/user-runtime/release'
import pins from '../src/server/nexus/runtime-versions.json' with { type: 'json' }

const [releaseId, imageReference, imageDigest, imageIdentitiesPath, archivePath, scodeVersionPath, cohostVersionPath, binaryDigest, outputPath] = process.argv.slice(2)
if (![releaseId, imageReference, imageDigest, imageIdentitiesPath, archivePath, scodeVersionPath, cohostVersionPath, binaryDigest, outputPath].every(Boolean)) {
  throw new Error('release, image, config digest, inspected identities, archive, version reports, binary digest and output are required')
}
const digest = RuntimeReleaseSchema.shape.image.shape.digest
const identities = z.record(z.string(), z.object({ id: digest, manifestDigest: digest })).parse(JSON.parse(readFileSync(imageIdentitiesPath!, 'utf8')))
const identity = identities[imageReference!]
if (!identity || identity.id !== imageDigest) throw new Error('The saved archive does not match the built runtime image')
const paired = requirePairedEngine(readFileSync(scodeVersionPath!, 'utf8'), readFileSync(cohostVersionPath!, 'utf8'))
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
  image: { reference: imageReference, digest: identity.manifestDigest, digestKind: 'oci-manifest' },
  archive: { name: basename(archivePath!), digest: `sha256:${hash.digest('hex')}` },
})
writeFileSync(outputPath!, `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`Verified shared runtime ${manifest.releaseId}: engine ${manifest.engine.commit}\n`)
