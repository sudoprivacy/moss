import { describe, expect, it } from 'bun:test'
import { validateTenantAssistantAvatar } from './tenantAssistantAvatar.js'

const PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

describe('validateTenantAssistantAvatar', () => {
  it('accepts a PNG avatar and derives the PNG extension', () => {
    expect(validateTenantAssistantAvatar({
      filename: 'avatar.png',
      contentType: 'image/png',
      data: PNG_BUFFER,
    })).toEqual({ extension: '.png', contentType: 'image/png', data: PNG_BUFFER })
  })
})
