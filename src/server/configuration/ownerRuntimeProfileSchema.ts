import { z } from 'zod/v4'

export const analyzerRelaySchema = z.object({
  image: z.string().min(1),
  secretName: z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
})

export const ownerRuntimeOverridesSchema = z.record(z.string().uuid(), z.object({
  runtimeManifestPath: z.string().min(1),
  analyzerImage: z.string().min(1).optional(),
  analyzerRelay: analyzerRelaySchema.strict().optional(),
}).strict().refine(value => !(value.analyzerImage && value.analyzerRelay),
  { message: 'Choose a dedicated analyzer or an analyzer relay for the selected owner' }))

export type OwnerRuntimeOverrides = z.infer<typeof ownerRuntimeOverridesSchema>
