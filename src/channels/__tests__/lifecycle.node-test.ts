import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { DirectConnectStore } from '../../server/db.js'
import { SessionManager } from '../core/SessionManager.js'
import { BasePlugin } from '../plugins/BasePlugin.js'
import { PluginManager, registerPlugin } from '../gateway/PluginManager.js'
import type { IChannelPluginConfig, IUnifiedIncomingMessage, IUnifiedOutgoingMessage } from '../types.js'

class LeaseTestPlugin extends BasePlugin {
  readonly type = 'lease-test'
  static starts = 0
  static stops = 0

  protected async onInitialize(_config: IChannelPluginConfig): Promise<void> {}

  protected async onStart(): Promise<void> {
    LeaseTestPlugin.starts += 1
  }

  protected async onStop(): Promise<void> {
    LeaseTestPlugin.stops += 1
  }

  async emitForTest(message: IUnifiedIncomingMessage): Promise<void> {
    await this.emitMessage(message)
  }

  async confirmForTest(): Promise<void> {
    await this.confirmHandler?.('platform-user', 'lease-test', 'call-1', 'allow')
  }

  async sendMessage(_chatId: string, _message: IUnifiedOutgoingMessage): Promise<string> {
    return 'message-1'
  }

  async editMessage(): Promise<void> {}
  getActiveUserCount(): number { return 0 }
  getBotInfo(): null { return null }
}

registerPlugin('lease-test', LeaseTestPlugin)

const databases: DirectConnectStore[] = []
const directories: string[] = []

afterEach(() => {
  LeaseTestPlugin.starts = 0
  LeaseTestPlugin.stops = 0
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'moss-channel-manager-'))
  const path = join(directory, 'moss.db')
  const firstDb = new DirectConnectStore(path)
  const secondDb = new DirectConnectStore(path)
  databases.push(firstDb, secondDb)
  directories.push(directory)
  firstDb.upsertChannelPlugin({
    id: 'lease-test_default',
    type: 'lease-test',
    name: 'lease test',
    enabled: 1,
    status: 'stopped',
    user_id: 'user-a',
    org_id: 'org-a',
  })
  const first = new PluginManager(new SessionManager(firstDb), firstDb, null, 'instance-a')
  const second = new PluginManager(new SessionManager(secondDb), secondDb, null, 'instance-b')
  return { firstDb, secondDb, first, second }
}

describe('PluginManager 多实例生命周期', () => {
  it('同一 Channel 连接只由一个实例启动，释放后备用实例可以接管', async () => {
    const { first, second } = setup()

    await first.startEnabledPlugins()
    await second.startEnabledPlugins()

    assert.equal(first.getAllPlugins().length, 1)
    assert.equal(second.getAllPlugins().length, 0)
    assert.equal(LeaseTestPlugin.starts, 1)

    await first.stopAll()
    await second.startEnabledPlugins()

    assert.equal(second.getAllPlugins().length, 1)
    assert.equal(LeaseTestPlugin.starts, 2)
    await second.stopAll()
  })

  it('租约被接管后旧实例的入站消息被 fencing 丢弃', async () => {
    const { firstDb, secondDb, first } = setup()
    let handled = 0
    first.setMessageHandler(async () => { handled += 1 })
    await first.startEnabledPlugins()
    const key = 'lease-test_default:user-a'
    const plugin = first.getPlugin(key) as LeaseTestPlugin
    assert.ok(plugin)

    const future = Date.now() + 120_000
    assert.equal(
      secondDb.acquireChannelPluginLease('lease-test_default', 'user-a', 'instance-b', future, future + 60_000),
      true,
    )
    await plugin.emitForTest({} as IUnifiedIncomingMessage)

    assert.equal(handled, 0)
    assert.equal(firstDb.ownsChannelPluginLease('lease-test_default', 'user-a', 'instance-a', future), false)
    await first.stopAll()
  })

  it('租约被接管后旧实例的工具确认回调也被 fencing 丢弃', async () => {
    const { firstDb, secondDb, first } = setup()
    let confirmed = 0
    first.setConfirmHandler(async () => { confirmed += 1 })
    await first.startEnabledPlugins()
    const key = 'lease-test_default:user-a'
    const plugin = first.getPlugin(key) as LeaseTestPlugin
    assert.ok(plugin)

    const future = Date.now() + 120_000
    assert.equal(
      secondDb.acquireChannelPluginLease('lease-test_default', 'user-a', 'instance-b', future, future + 60_000),
      true,
    )
    await plugin.confirmForTest()

    assert.equal(confirmed, 0)
    assert.equal(firstDb.ownsChannelPluginLease('lease-test_default', 'user-a', 'instance-a', future), false)
    await first.stopAll()
  })
})
