import { ResourceAccessError } from '../catalog/resourceError.js'

/** Keep shared cloud execution isolated and bind metered native inference to its owner box. */
export function assertRuntimePlacement(runtimeType: string, isOwnerPodConfigured: boolean, isMetered = false, isNativeOnly = false): void {
  if (isOwnerPodConfigured && isNativeOnly && runtimeType !== 'cohost') {
    throw new ResourceAccessError(403, 'New cloud sessions must use the shared native runtime')
  }
  if (isOwnerPodConfigured && (runtimeType === 'host' || runtimeType === 'docker')) {
    throw new ResourceAccessError(403, 'Cloud sessions must use the isolated compute runtime')
  }
  if (isMetered && runtimeType === 'cohost' && !isOwnerPodConfigured) {
    throw new ResourceAccessError(503, 'Per-owner model billing requires an owner runtime')
  }
}
