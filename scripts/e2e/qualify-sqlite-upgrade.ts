/** Runs only the database-copy journey, never a Moss controller or runtime. */
import assert from 'node:assert/strict'
import { qualifySqliteUpgrade } from '../../src/server/storage/sqliteUpgradeQualification.js'

assert(process.argv[2], 'Usage: qualify-sqlite-upgrade <absolute-existing-database-path>')
console.log(JSON.stringify(await qualifySqliteUpgrade(process.argv[2]), null, 2))
