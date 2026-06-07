/**
 * Resolve icon URL for backward compatibility.
 *
 * Handles three formats stored in the database:
 * - "data:..." → return as-is (old base64 data URL)
 * - "/uploads/..." → return as-is (new full path)
 * - "uuid.ext" → prepend "/uploads/{subDir}/" (bare filename)
 * - null → return null
 */
export function resolveIconUrl(icon: string | null, subDir: string): string | null {
  if (icon == null) return null
  // Old base64 data URL — return as-is
  if (icon.startsWith('data:')) return icon
  // Already a full path — return as-is
  if (icon.startsWith('/')) return icon
  // Bare filename (uuid.ext) — prepend path prefix
  return `/uploads/${subDir}/${icon}`
}
