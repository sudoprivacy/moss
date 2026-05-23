#!/usr/bin/env bun
/**
 * Cross-platform vendor copy script
 * Replaces Unix cp -r for Windows compatibility
 */
import { cpSync, mkdirSync, existsSync } from 'fs'
import { dirname, join } from 'path'

function copyDir(src, dest) {
  if (!existsSync(src)) {
    console.error(`Source does not exist: ${src}`)
    process.exit(1)
  }
  console.log(`Copying ${src} -> ${dest}`)
  cpSync(src, dest, { recursive: true })
}

function copyFile(src, dest) {
  const destDir = dirname(dest)
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true })
  }
  console.log(`Copying ${src} -> ${dest}`)
  cpSync(src, dest)
}

// Ensure parent directories exist
mkdirSync('node_modules/@ant', { recursive: true })
mkdirSync('node_modules/@anthropic-ai', { recursive: true })
mkdirSync('src/commands/memory', { recursive: true })

// Copy vendor directories
copyDir('vendor/@ant', 'node_modules/@ant')
copyDir('vendor/@anthropic-ai', 'node_modules/@anthropic-ai')
copyDir('vendor/modifiers-napi', 'node_modules/modifiers-napi')

// Copy single file
copyFile('vendor/commands-memory-stub/index.js', 'src/commands/memory/index.js')

console.log('Done copying vendor files')