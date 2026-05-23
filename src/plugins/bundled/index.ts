import { registerBuiltinPlugin } from '../builtinPlugins.js'

/**
 * Initialize built-in plugins. Called during CLI startup.
 */
export function initBuiltinPlugins(): void {
  // Built-in LSP essentials removed to keep bundle small.
  // The system will use whatever LSP servers are available in the user's PATH or installed via plugins.
}
