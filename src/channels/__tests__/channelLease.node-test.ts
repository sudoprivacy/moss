import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { DirectConnectStore } from '../../server/db.js'

const databases: DirectConnectStore[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createSharedDatabases(): [DirectConnectStore, DirectConnectStore] {
  const directory = mkdtempSync(join(tmpdir(), 'moss-channel-lease-'))
  const path = join(directory, 'moss.db')
  const first = new DirectConnectStore(path)
  const second = new DirectConnectStore(path)
  databases.push(first, second)
  directories.push(directory)
  return [first, second]
}

describe('Channel 插件跨实例租约', () => {
  it('同一连接只有一个实例能持有有效租约', () => {
    const [first, second] = createSharedDatabases()

    const acquired = [
      first.acquireChannelPluginLease('telegram_default', 'user-a', 'instance-a', 1_000, 31_000),
      second.acquireChannelPluginLease('telegram_default', 'user-a', 'instance-b', 1_000, 31_000),
    ]

    assert.equal(acquired.filter(Boolean).length, 1)
    assert.equal(first.ownsChannelPluginLease('telegram_default', 'user-a', 'instance-a', 2_000), true)
    assert.equal(second.ownsChannelPluginLease('telegram_default', 'user-a', 'instance-b', 2_000), false)
  })

  it('只允许持有者续租和释放，过期后允许另一个实例接管', () => {
    const [first, second] = createSharedDatabases()
    assert.equal(first.acquireChannelPluginLease('lark_default', 'user-a', 'instance-a', 1_000, 2_000), true)

    assert.equal(second.renewChannelPluginLease('lark_default', 'user-a', 'instance-b', 1_500, 3_000), false)
    assert.equal(second.releaseChannelPluginLease('lark_default', 'user-a', 'instance-b'), false)
    assert.equal(second.acquireChannelPluginLease('lark_default', 'user-a', 'instance-b', 2_001, 32_001), true)
    assert.equal(first.ownsChannelPluginLease('lark_default', 'user-a', 'instance-a', 2_001), false)
    assert.equal(second.releaseChannelPluginLease('lark_default', 'user-a', 'instance-b'), true)
  })
})
