/**
 * Whether a workspace file's bytes read as text.
 *
 * Its own module because both the direct-fs and the pod preview paths need it,
 * and because deciding this is testable on its own — importing it from the HTTP
 * module would drag in node:sqlite, which cannot load under bun.
 */

/**
 * The extension list alone used to decide this, which is wrong for the
 * extensionless files agents routinely write: they came back base64 and the
 * client rendered the encoding instead of the content. A NUL byte is the
 * conventional binary signal; a UTF-8 decode settles the rest. Only the head is
 * examined — enough to classify, cheap on a large file.
 */
export function bytesLookLikeText(buffer: Buffer): boolean {
  if (buffer.length === 0) return true
  const sample = buffer.subarray(0, 8192)
  if (sample.includes(0)) return false
  // A lossy decode substitutes U+FFFD wherever the bytes are not valid UTF-8.
  // Real U+FFFD in a source file is rare, and calling such a file binary is the
  // safer of the two mistakes.
  return !new TextDecoder('utf-8').decode(sample).includes('\uFFFD')
}
