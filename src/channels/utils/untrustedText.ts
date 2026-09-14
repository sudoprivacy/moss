/**
 * Neutralises markup that would let inbound channel text impersonate the system.
 *
 * Everything arriving on a channel is written by whoever is on the other end of
 * an IM account. It reaches the agent as a plain user turn, and the system
 * prompt tells the model that `<system-reminder>` tags "contain useful
 * information and reminders … automatically added by the system". A message
 * that simply contains those tags therefore inherits the trust the prompt
 * confers on the system — no exploit needed, just the literal characters.
 *
 * So the tag markers are defanged rather than the text being dropped: the
 * message still reads the same to a human, and a legitimate sender has no
 * reason to emit these tags. Content is left otherwise untouched, because
 * rewriting what a user said is its own kind of wrong.
 *
 * This is the inbound half of a pair. The outbound half — an agent's own
 * reminders riding along in a message it sends out — is sudocode#623.
 */

/**
 * Tags the model has been told are system-authored. Matching is deliberately
 * loose about whitespace and case, since the point is what a model reads, not
 * what a parser accepts.
 */
const IMPERSONATING_TAG = /<(\/?)(\s*)(system-reminder|system|important-instructions)(\s*)>/gi

export function neutralizeUntrustedMarkup(text: string): string {
  return text.replace(IMPERSONATING_TAG, (_m, slash: string, _s1, name: string) => `(${slash}${name})`)
}
