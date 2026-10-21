/** Shared by legacy Catalog consumers; hosted agents have no native artifact. */
export function isExternalHosted(binding: Record<string, unknown> | null | undefined): boolean {
  return binding?.executionMode === 'external_hosted'
}

/** Hosted task runtimes have no downloadable/native template, regardless of their location. */
export function isManagedHosted(binding: Record<string, unknown> | null | undefined): boolean {
  return isExternalHosted(binding) || binding?.executionMode === 'internal_hosted'
}
