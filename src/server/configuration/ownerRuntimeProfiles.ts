import { isAbsolute } from 'node:path'
import type { UserPodOptions } from '@sudo/user-runtime'
import { readRuntimeRelease } from '@sudo/user-runtime/release'
import type { OwnerRuntimeOverrides } from './ownerRuntimeProfileSchema.js'

/** Load trusted deployment profiles while lifecycle and verification stay in the shared SDK. */
export function readOwnerRuntimeOverrides(input: OwnerRuntimeOverrides | undefined): UserPodOptions['ownerRuntimeOverrides'] {
  if (!input) return undefined
  return Object.fromEntries(Object.entries(input).map(([ownerId, profile]) => {
    if (!isAbsolute(profile.runtimeManifestPath)) throw new Error('Owner runtime profiles require absolute release manifest paths')
    return [ownerId, { release: readRuntimeRelease(profile.runtimeManifestPath),
      ...(profile.analyzerImage ? { egressAnalyzer: { image: profile.analyzerImage } } : {}),
      ...(profile.analyzerRelay ? { egressAnalyzerRelay: profile.analyzerRelay } : {}) }]
  }))
}
