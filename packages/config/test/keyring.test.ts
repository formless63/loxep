import { describe, expect, it } from 'vitest'
import { KeyringError, parseKeyring } from '../src/index.ts'
import { keyBase64 } from './helpers.ts'

function keyringError(raw: string): KeyringError {
  try {
    parseKeyring(raw)
  } catch (error) {
    if (error instanceof KeyringError) return error
    throw error
  }
  throw new Error('expected parseKeyring to throw KeyringError')
}

describe('parseKeyring', () => {
  it('parses a single-key keyring', () => {
    const keyring = parseKeyring(JSON.stringify({ active_version: 1, keys: { '1': keyBase64(7) } }))
    expect(keyring.activeVersion).toBe(1)
    expect(keyring.keys.size).toBe(1)
    expect(keyring.keys.get(1)).toEqual(new Uint8Array(32).fill(7))
  })

  it('parses a multi-key keyring with a non-initial active version', () => {
    const keyring = parseKeyring(
      JSON.stringify({ active_version: 3, keys: { '1': keyBase64(1), '3': keyBase64(3) } }),
    )
    expect(keyring.activeVersion).toBe(3)
    expect(keyring.keys.size).toBe(2)
    expect(keyring.keys.get(3)).toEqual(new Uint8Array(32).fill(3))
  })

  it('rejects non-JSON input without echoing it', () => {
    const error = keyringError('secret-marker-not-json{')
    expect(error.message).toContain('not valid JSON')
    expect(error.message).not.toContain('secret-marker')
  })

  it('rejects non-object documents', () => {
    expect(() => parseKeyring('[1,2,3]')).toThrow(KeyringError)
    expect(() => parseKeyring('"key-material"')).toThrow(KeyringError)
    expect(() => parseKeyring('null')).toThrow(KeyringError)
  })

  it('rejects a missing active_version', () => {
    const error = keyringError(JSON.stringify({ keys: { '1': keyBase64() } }))
    expect(error.message).toContain('active_version')
  })

  it.each([0, -1, 1.5, '1'])('rejects invalid active_version %j', (activeVersion) => {
    const error = keyringError(
      JSON.stringify({ active_version: activeVersion, keys: { '1': keyBase64() } }),
    )
    expect(error.message).toContain('"active_version" must be an integer >= 1')
  })

  it('rejects an active_version with no corresponding key', () => {
    const error = keyringError(JSON.stringify({ active_version: 2, keys: { '1': keyBase64() } }))
    expect(error.message).toContain('"active_version" 2 has no corresponding entry')
  })

  it('rejects a missing keys object', () => {
    const error = keyringError(JSON.stringify({ active_version: 1 }))
    expect(error.message).toContain('"keys"')
  })

  it('rejects an empty keys object', () => {
    const error = keyringError(JSON.stringify({ active_version: 1, keys: {} }))
    expect(error.message).toContain('at least one key')
  })

  it.each(['0', '-1', '1.5', 'abc', '01'])('rejects non-positive-integer version label %j', (label) => {
    const error = keyringError(
      JSON.stringify({ active_version: 1, keys: { '1': keyBase64(), [label]: keyBase64() } }),
    )
    expect(error.message).toContain(`key version "${label}" must be a positive integer`)
  })

  it('rejects keys that are not valid base64', () => {
    const error = keyringError(
      JSON.stringify({ active_version: 1, keys: { '1': 'not-base64-!!!-secretish' } }),
    )
    expect(error.message).toContain('base64-encoded 256-bit key')
    expect(error.message).not.toContain('secretish')
  })

  it('rejects non-string key values', () => {
    const error = keyringError(JSON.stringify({ active_version: 1, keys: { '1': 12345 } }))
    expect(error.message).toContain('base64-encoded 256-bit key')
  })

  it.each([31, 33, 16])('rejects keys that decode to %i bytes', (length) => {
    const material = keyBase64(9, length)
    const error = keyringError(JSON.stringify({ active_version: 1, keys: { '1': material } }))
    expect(error.message).toContain('exactly 32 bytes')
    expect(error.message).not.toContain(material)
  })

  it('aggregates multiple problems into one error', () => {
    const error = keyringError(
      JSON.stringify({ active_version: 0, keys: { bad: keyBase64(), '2': keyBase64(1, 8) } }),
    )
    expect(error.issues.length).toBeGreaterThanOrEqual(3)
  })

  it('never includes key material in any error message', () => {
    const material = keyBase64(42, 31)
    const validMaterial = keyBase64(5)
    const error = keyringError(
      JSON.stringify({ active_version: 9, keys: { '1': material, '2': validMaterial } }),
    )
    expect(error.message).not.toContain(material)
    expect(error.message).not.toContain(validMaterial)
    for (const issue of error.issues) {
      expect(issue).not.toContain(material)
      expect(issue).not.toContain(validMaterial)
    }
  })
})
