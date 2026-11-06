import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modelPromptPath } from './modelPromptPath.js'

void test('model evidence reads the same prompt from bare and mount-qualified native listings', () => {
  const name = '6264e21e-a818-4373-9d08-0a1411e4075a.prompt'
  assert.equal(modelPromptPath('/model', name), `/model/${name}`)
  assert.equal(modelPromptPath('/model', `/model/${name}`), `/model/${name}`)
  assert.equal(modelPromptPath('/external/model', `/external/model/${name}`), `/external/model/${name}`)
})

void test('model evidence refuses entries outside the selected mount or below another directory', () => {
  for (const entry of ['/private/a.prompt', '/models/a.prompt', '/model/nested/a.prompt',
    '../a.prompt', '/model/../a.prompt', 'nested/a.prompt', 'nested\\a.prompt', 'a.response']) {
    assert.throws(() => modelPromptPath('/model', entry))
  }
  for (const mount of ['model', '/', '/model/', '/model/../private']) {
    assert.throws(() => modelPromptPath(mount, 'a.prompt'))
  }
})
