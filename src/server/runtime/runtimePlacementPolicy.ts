import { ResourceAccessError } from '../catalog/resourceError.js'

/** Enforce the configured native entrypoint and isolate shared cloud execution. */
export function assertRuntimePlacement(runtimeType: string, isOwnerPodConfigured: boolean, isMetered = false, isNativeOnly = false): void {
  if (isNativeOnly && runtimeType !== 'cohost') {
    throw new ResourceAccessError(403, 'New sessions must use the configured native runtime')
  }
  if (isOwnerPodConfigured && (runtimeType === 'host' || runtimeType === 'docker')) {
    throw new ResourceAccessError(403, 'Cloud sessions must use the isolated compute runtime')
  }
  if (isMetered && runtimeType === 'cohost' && !isOwnerPodConfigured) {
    throw new ResourceAccessError(503, 'Per-owner model billing requires an owner runtime')
  }
}
