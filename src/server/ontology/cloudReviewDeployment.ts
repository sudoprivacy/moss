import { ShareoneReviewAssets } from '@sudowork/sudograph-runtime'
import { ResourceAccessError } from '../catalog/resourceError.js'
import type { BrowserEpochs } from '../browser/browserGateway.js'
import { createCloudModelReviewService } from './cloudReviewService.js'

/** A caller chooses only the observed browser generation, never a source or credential. */
export function reviewBrowserEpochs(input: unknown): BrowserEpochs {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ResourceAccessError(400, 'Invalid review browser generation')
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !['controlEpoch', 'targetEpoch'].includes(key))
    || !Number.isSafeInteger(value.controlEpoch) || Number(value.controlEpoch) < 0
    || !Number.isSafeInteger(value.targetEpoch) || Number(value.targetEpoch) < 0) {
    throw new ResourceAccessError(400, 'Invalid review browser generation')
  }
  return { controlEpoch: value.controlEpoch as number, targetEpoch: value.targetEpoch as number }
}

/** Deployment configuration is trusted; request headers cannot select an origin or asset directory. */
export async function createDeployedCloudReview(options: Omit<Parameters<typeof createCloudModelReviewService>[0], 'assets' | 'secrets'> & {
  secrets: Parameters<typeof createCloudModelReviewService>[0]['secrets'] | null
  assetsDirectory?: string
}) {
  if (!options.assetsDirectory) return null
  if (!options.secrets) throw new Error('Cloud model review requires the configured Nexus personal Secrets API')
  const assets = new ShareoneReviewAssets()
  await assets.load(options.assetsDirectory)
  return createCloudModelReviewService({ ...options, secrets: options.secrets, assets })
}
