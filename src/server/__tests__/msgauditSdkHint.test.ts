// The 会话存档 load error must say when the library is a Git LFS pointer: an
// image built without `git lfs pull` otherwise looks like "SDK not in image".
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sdkLoadHint } from '../corpapps/msgaudit/sdk.js'

describe('msgaudit SDK load hint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-hint-'))

  it('names a Git LFS pointer and the fix', () => {
    const p = join(dir, 'pointer.so')
    writeFileSync(p, 'version https://git-lfs.github.com/spec/v1\noid sha256:79ced4de\nsize 8907368\n')
    assert.match(sdkLoadHint(p), /Git LFS pointer.*git lfs pull/)
  })

  it('says the library is missing when there is no file', () => {
    assert.match(sdkLoadHint(join(dir, 'missing.so')), /not in this image/)
  })

  it('points at platform and source for any other file', () => {
    const p = join(dir, 'other.so')
    writeFileSync(p, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]))
    assert.match(sdkLoadHint(p), /linux\/amd64/)
  })
})
