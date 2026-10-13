/** Shared by legacy Catalog consumers; hosted agents have no native artifact. */
export function isExternalHosted(binding: Record<string, unknown> | null | undefined): boolean {
  return binding?.executionMode === 'external_hosted'
}
