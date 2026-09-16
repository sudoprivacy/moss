#!/usr/bin/env node

import { parseP5QmsMigrationArgs, runP5QmsMigrationCli } from '../src/server/migration/p5QmsMigrationCli.js'

try {
  const exitCode = await runP5QmsMigrationCli(parseP5QmsMigrationArgs(process.argv.slice(2)))
  process.exitCode = exitCode
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
