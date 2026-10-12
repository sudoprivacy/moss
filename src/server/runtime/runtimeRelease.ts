import { readFileSync } from 'node:fs'
import { z } from 'zod'

const version = z.string().regex(/^\d+\.\d+\.\d+$/)
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const RuntimeReleaseSchema = z.object({
  schemaVersion: z.literal(1),
  releaseId: z.string().min(1),
  engine: z.object({ version, commit: z.string().regex(/^[a-f0-9]{7,40}$/) }).strict(),
  cohost: z.object({ version, nexusVersion: version, pluginAbi: z.number().int().positive(), binaryDigest: digest }).strict(),
  issuerVersion: version,
  image: z.object({ reference: z.string().min(1).refine(value => !/(^|:)latest$/.test(value)),
    digest, digestKind: z.enum(['oci-config', 'oci-manifest']) }).strict(),
  archive: z.object({ name: z.string().regex(/^[A-Za-z0-9._-]+$/), digest }).strict(),
}).strict()
export type RuntimeRelease = z.infer<typeof RuntimeReleaseSchema>

/** A deployment consumes the generated release evidence, never an independently typed version table. */
export function readRuntimeRelease(path: string): RuntimeRelease {
  return RuntimeReleaseSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
}

/** Read the binary's own provenance rather than infer the engine revision from a tag. */
export function parseCohostBuild(output: string) {
  const match = /nexusd-cohost v(\d+\.\d+\.\d+) \(sudocode ([a-f0-9]{7,40}), nexus-vfs v(\d+\.\d+\.\d+)\).*plugin-abi (\d+)/.exec(output)
  if (!match) throw new Error('Cohost build provenance is missing')
  return { version: match[1]!, commit: match[2]!, nexusVersion: match[3]!, pluginAbi: Number(match[4]) }
}

/** A matching CLI and embedded engine come from the same commit, even when their tag namespaces differ. */
export function requirePairedEngine(scodeOutput: string, cohostOutput: string) {
  const cohost = parseCohostBuild(cohostOutput)
  const versionMatch = /Version\s+(\d+\.\d+\.\d+)/.exec(scodeOutput)
  const commitMatch = /Git SHA\s+([a-f0-9]{7,40})/.exec(scodeOutput)
  if (!versionMatch || !commitMatch || commitMatch[1] !== cohost.commit) {
    throw new Error('The CLI and cohost must contain the same verified engine commit')
  }
  return { engine: { version: versionMatch[1]!, commit: cohost.commit }, cohost }
}
