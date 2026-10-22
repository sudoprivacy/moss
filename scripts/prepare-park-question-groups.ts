import { DatabaseSync } from 'node:sqlite'
import { SqliteDriver } from '../src/server/db/driver.js'
import { ParkStore } from '../src/server/park/store.js'
import { prepareQuestionGroups } from '../src/server/park/popularQuestions.js'

const [databasePath, orgId] = process.argv.slice(2)
if (!databasePath || !orgId) throw new Error('Usage: node --import tsx scripts/prepare-park-question-groups.ts <moss.db> <org-id>')
const store = new ParkStore(new SqliteDriver(new DatabaseSync(databasePath)))
try {
  await prepareQuestionGroups(store, orgId)
} finally { await store.db.close() }
