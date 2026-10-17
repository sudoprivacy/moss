import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { UserRuntimeConnectionConfig } from '@sudo/user-runtime'
import type { RuntimeAgentNamespace } from '../agentManager.js'
import { DirectConnectStore } from '../db.js'
import { CohostOwnerRuntime } from './cohostOwnerRuntime.js'

void test('execution, native Agent adoption and discovery retain the same SQL home across controller restarts', async t => {
  const store = new DirectConnectStore(':memory:')
  t.after(() => store.close())
  const configurations = new Map<string, UserRuntimeConnectionConfig>()
  const namespaces = new Map<string, RuntimeAgentNamespace>()
  const drift = new Set<string>()
  let created = 0
  type Pods = ConstructorParameters<typeof CohostOwnerRuntime>[0]
  const pods: Pods = {
    forAllocation(allocationId) {
      const key = (ownerId: string) => `${ownerId}/${allocationId}`
      const resolve = async (ownerId: string): Promise<UserRuntimeConnectionConfig> => {
        let config = configurations.get(key(ownerId))
        if (!config) {
          created++
          config = { endpoint: `https://runtime.invalid/${key(ownerId)}`, authToken: '',
            tls: { ca: '/ca', cert: `/owner-${ownerId}`, key: '/key' }, runtimeEndpoint: `http://runtime.invalid/${key(ownerId)}` }
          configurations.set(key(ownerId), config)
        }
        return config
      }
      return { resolve,
        find: async ownerId => configurations.get(key(ownerId)),
        inspect: async ownerId => ({ ownerId, allocationId, isPresent: configurations.has(key(ownerId)),
          isDrifted: drift.has(key(ownerId)), phase: 'Running', expectedImage: 'runtime:verified',
          observedImageDigest: null, releaseId: 'verified-release' }),
        upgrade: async (ownerId, drain) => { await drain(configurations.get(key(ownerId))); return resolve(ownerId) },
      }
    },
  }
  const reader = async (config: UserRuntimeConnectionConfig, ownerId: string) => {
    assert.equal(config.tls.cert, `/owner-${ownerId}`)
    return structuredClone(namespaces.get(config.runtimeEndpoint) ?? { isOwnerConfined: true, names: [], managedNames: [], executions: [] })
  }
  const controller = () => new CohostOwnerRuntime(pods, store.cohostAgentHomes, 2, reader)
  let runtime = controller()
  const first = await runtime.connection('alice', 'agent-a')
  assert.equal((await runtime.connection('alice', 'agent-b')).runtimeEndpoint, first.runtimeEndpoint)
  const third = await runtime.connection('alice', 'agent-c')
  assert.notEqual(third.runtimeEndpoint, first.runtimeEndpoint)
  assert.equal(created, 2)
  const thirdHome = await runtime.resolveHome('alice', 'agent-c')
  const snapshot = (ownerId: string, names: string[]): RuntimeAgentNamespace => ({
    isOwnerConfined: true, names, managedNames: names,
    executions: names.map(name => ({ name, ownerId, kind: 'managed', state: 'ready', processId: '1.1' })),
  })
  namespaces.set(first.runtimeEndpoint!, snapshot('alice', ['agent-a', 'agent-b']))
  namespaces.set(third.runtimeEndpoint!, snapshot('alice', ['agent-c', 'native-imported']))
  runtime = controller()
  assert.equal((await runtime.connection('alice', 'agent-c')).runtimeEndpoint, third.runtimeEndpoint)
  assert.equal(created, 2, 'a new controller must not choose another storage allocation')
  const merged = await runtime.namespace('alice')
  assert.deepEqual(new Set(merged!.names), new Set(['agent-a', 'agent-b', 'agent-c', 'native-imported']))
  assert.equal(merged!.agentAllocations!['agent-c'], thirdHome.allocationId)
  assert.equal(new Set(merged!.executions.map(execution => execution.allocationId)).size, 2,
    'the same native process ID in two Pods must retain its allocation')
  await runtime.adopt('alice', 'native-imported', thirdHome.allocationId)
  assert.equal((await runtime.connection('alice', 'native-imported')).runtimeEndpoint, third.runtimeEndpoint)
  await assert.rejects(runtime.adopt('alice', 'agent-c', 'primary'), /conflicts/)
  assert.equal((await runtime.resolveHome('alice', 'agent-c')).allocationId, thirdHome.allocationId)
  const competingAdoptions = await Promise.allSettled([
    runtime.adopt('alice', 'native-concurrent', 'primary'),
    controller().adopt('alice', 'native-concurrent', thirdHome.allocationId),
  ])
  assert.equal(competingAdoptions.filter(result => result.status === 'fulfilled').length, 1,
    'a concurrent adoption must reject a different committed home')
  const conflicting = competingAdoptions.find(result => result.status === 'rejected')
  assert(conflicting?.status === 'rejected' && /conflicts/.test(String(conflicting.reason)))
  const bob = await runtime.connection('bob', 'agent-a')
  assert.notEqual(bob.runtimeEndpoint, first.runtimeEndpoint)
  namespaces.set(bob.runtimeEndpoint!, snapshot('bob', ['agent-a']))
  assert.deepEqual((await runtime.namespace('bob'))!.names, ['agent-a'])
  assert.equal(await runtime.namespace('carol'), undefined)
  assert.equal(created, 3, 'listing an absent owner must not provision a Pod')
  drift.add(`alice/${thirdHome.allocationId}`)
  const inspected = await runtime.inspect('alice')
  assert.equal(inspected.allocations.length, 2)
  assert.equal(inspected.isDrifted, true, 'a secondary allocation must be included in rollout inspection')
  namespaces.set(third.runtimeEndpoint!, snapshot('alice', ['agent-a']))
  await assert.rejects(runtime.namespace('alice'), /multiple runtime allocations/)
  namespaces.set(third.runtimeEndpoint!, snapshot('bob', ['agent-c']))
  await assert.rejects(runtime.namespace('alice'), /another owner/)
})
