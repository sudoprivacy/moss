/** Copy in secure contexts and HTTP deployments, including inside Radix dialogs. */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // Some browsers expose Clipboard but deny it; try the selected-text fallback.
  }

  const previousFocus = document.activeElement as HTMLElement | null
  const container = previousFocus?.closest('[role="dialog"], [role="alertdialog"]') ?? document.body
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.style.cssText = 'position:fixed;left:0;top:0;opacity:0;pointer-events:none;'
  container.appendChild(textarea)
  try {
    textarea.focus({ preventScroll: true })
    textarea.select()
    if (!document.execCommand('copy')) throw new Error('Copy failed')
  } finally {
    textarea.remove()
    previousFocus?.focus({ preventScroll: true })
  }
}
