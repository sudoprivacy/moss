/**
 * Stub for color-diff-napi (npm package is a placeholder)
 *
 * The real native module provides syntax highlighting and color diff capabilities.
 * This stub returns null/disabled to indicate the feature is unavailable.
 */

// Return null for all color functions - feature unavailable
const ColorDiff = null
const ColorFile = null

function getSyntaxTheme(themeName) {
  return null
}

module.exports = {
  ColorDiff,
  ColorFile,
  getSyntaxTheme,
}