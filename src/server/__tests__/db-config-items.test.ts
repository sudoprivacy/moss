import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

describe('DirectConnectStore config_items bootstrap ordering', () => {
  it('creates config_items before running config item column migrations', async () => {
    const dbSource = await readFile(
      path.resolve(__dirname, '..', 'db.ts'),
      'utf8',
    )
    const firstCreate = dbSource.indexOf('CREATE TABLE IF NOT EXISTS config_items')
    const migration = dbSource.indexOf('Migration: config_items mint/auth columns')

    expect(firstCreate).toBeGreaterThan(-1)
    expect(migration).toBeGreaterThan(-1)
    expect(firstCreate).toBeLessThan(migration)
  })
})
