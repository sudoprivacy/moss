/** Runs only the database-copy journey, never a Moss controller or runtime. */
import assert from 'node:assert/strict'
import { inspectSqliteController, prepareControllerConfiguration, qualifySqliteUpgrade } from '../../src/server/storage/sqliteUpgradeQualification.js'

if (process.argv[2] === '--prepare-controller-config') {
  assert.equal(process.argv.length, 8, 'Usage: --prepare-controller-config <config> <db> <verified-pid> <expected-config-sha256> <new-private-output>')
  console.log(JSON.stringify(prepareControllerConfiguration(process.argv[3]!, process.argv[4]!, Number(process.argv[5]), process.argv[6]!, process.argv[7]!), null, 2))
} else if (process.argv[2] === '--inspect-controller') {
  assert.equal(process.argv.length, 6, 'Usage: --inspect-controller <absolute-db> <verified-service-pid> <heartbeat-timeout-ms>')
  console.log(JSON.stringify(inspectSqliteController(process.argv[3]!, Number(process.argv[4]), Number(process.argv[5])), null, 2))
} else {
  assert.equal(process.argv.length, 3, 'Usage: qualify-sqlite-upgrade <absolute-existing-database-path>')
  console.log(JSON.stringify(await qualifySqliteUpgrade(process.argv[2]!), null, 2))
}
