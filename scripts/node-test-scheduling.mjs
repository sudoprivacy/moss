/** PostgreSQL fixtures use schemas in one database and share its migration lock. */
export function nodeTestConcurrencyArgs(environment = process.env) {
  const configured = environment.MOSS_NODE_TEST_CONCURRENCY
  if (configured !== undefined && (!/^[1-9][0-9]*$/.test(configured) || !Number.isSafeInteger(Number(configured)))) {
    throw new Error('MOSS_NODE_TEST_CONCURRENCY must be a positive integer')
  }
  if (environment.MOSS_PG_TEST_URL && configured !== undefined && configured !== '1') {
    throw new Error('PostgreSQL test fixtures share a migration lock; MOSS_NODE_TEST_CONCURRENCY must be 1 when MOSS_PG_TEST_URL is set')
  }
  const concurrency = configured ?? (environment.MOSS_PG_TEST_URL ? '1' : undefined)
  return concurrency ? [`--test-concurrency=${concurrency}`] : []
}
