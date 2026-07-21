import { describe, it, expect } from 'bun:test'
import {
  parseBodyAuthCheck,
  bodyIndicatesUnauthorized,
} from '../authProxy/bodyAuthCheck.js'

// The auth proxy re-mints + retries once when a cached login token is rejected.
// PR #139 only detected an HTTP 401; these tests cover the opt-in body-level
// detection (HTTP 200 + {"code":401,...}) configured per config item.

describe('parseBodyAuthCheck', () => {
  it('returns null for empty / null / whitespace (feature off)', () => {
    expect(parseBodyAuthCheck(null)).toBeNull()
    expect(parseBodyAuthCheck(undefined)).toBeNull()
    expect(parseBodyAuthCheck('')).toBeNull()
    expect(parseBodyAuthCheck('   ')).toBeNull()
  })

  it('returns null for malformed JSON or non-object', () => {
    expect(parseBodyAuthCheck('{bad json')).toBeNull()
    expect(parseBodyAuthCheck('[1,2,3]')).toBeNull()
    expect(parseBodyAuthCheck('"code"')).toBeNull()
    expect(parseBodyAuthCheck('42')).toBeNull()
  })

  it('parses a full recipe', () => {
    expect(parseBodyAuthCheck('{"field":"code","unauthorizedValues":[401,"401"]}')).toEqual({
      field: 'code',
      unauthorizedValues: [401, '401'],
    })
  })

  it('accepts a minimal recipe ({} → defaults applied at detection time)', () => {
    expect(parseBodyAuthCheck('{}')).toEqual({})
  })

  it('drops unknown keys and invalid value entries', () => {
    expect(
      parseBodyAuthCheck('{"field":"errCode","unauthorizedValues":[10,{"x":1}],"extra":true}'),
    ).toEqual({ field: 'errCode', unauthorizedValues: [10] })
  })

  it('ignores a blank field and an empty unauthorizedValues array', () => {
    expect(parseBodyAuthCheck('{"field":"   ","unauthorizedValues":[]}')).toEqual({})
  })
})

describe('bodyIndicatesUnauthorized', () => {
  const recipe = parseBodyAuthCheck('{"field":"code","unauthorizedValues":[401,"401"]}')

  it('never fires when detection is disabled (null recipe)', () => {
    expect(bodyIndicatesUnauthorized(null, '{"code":401}')).toBe(false)
  })

  it('detects a numeric code:401 in an HTTP-200 envelope', () => {
    expect(bodyIndicatesUnauthorized(recipe, '{"code":401,"message":"登录失效"}')).toBe(true)
  })

  it('detects a string "401" too (loose comparison)', () => {
    expect(bodyIndicatesUnauthorized(recipe, '{"code":"401"}')).toBe(true)
  })

  it('does not fire on a success envelope (code:200)', () => {
    expect(bodyIndicatesUnauthorized(recipe, '{"code":200,"data":[]}')).toBe(false)
  })

  it('does not fire when the field is absent', () => {
    expect(bodyIndicatesUnauthorized(recipe, '{"result":true}')).toBe(false)
  })

  it('does not fire on a non-JSON body', () => {
    expect(bodyIndicatesUnauthorized(recipe, '<html>401 Unauthorized</html>')).toBe(false)
    expect(bodyIndicatesUnauthorized(recipe, '')).toBe(false)
  })

  it('accepts a Buffer body', () => {
    expect(bodyIndicatesUnauthorized(recipe, Buffer.from('{"code":401}'))).toBe(true)
  })

  it('supports a dotted path (data.code)', () => {
    const nested = parseBodyAuthCheck('{"field":"data.code","unauthorizedValues":[401]}')
    expect(bodyIndicatesUnauthorized(nested, '{"data":{"code":401}}')).toBe(true)
    expect(bodyIndicatesUnauthorized(nested, '{"code":401}')).toBe(false)
  })

  it('applies defaults (field "code", values [401,"401"]) for a {} recipe', () => {
    const empty = parseBodyAuthCheck('{}')
    expect(bodyIndicatesUnauthorized(empty, '{"code":401}')).toBe(true)
    expect(bodyIndicatesUnauthorized(empty, '{"code":"401"}')).toBe(true)
    expect(bodyIndicatesUnauthorized(empty, '{"code":0}')).toBe(false)
  })

  it('honors a custom field name (errCode) and custom values', () => {
    const custom = parseBodyAuthCheck('{"field":"errCode","unauthorizedValues":["TOKEN_EXPIRED"]}')
    expect(bodyIndicatesUnauthorized(custom, '{"errCode":"TOKEN_EXPIRED"}')).toBe(true)
    expect(bodyIndicatesUnauthorized(custom, '{"errCode":"OK"}')).toBe(false)
  })
})
