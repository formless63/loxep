/**
 * External root encryption keyring per ADR-0019.
 *
 * The keyring is a small JSON document, delivered preferably as a mounted
 * file/Docker secret:
 *
 * ```json
 * { "active_version": 2, "keys": { "1": "<base64 32 bytes>", "2": "<base64 32 bytes>" } }
 * ```
 *
 * Rules enforced here:
 * - `active_version` is an integer >= 1 and must be present in `keys`;
 * - every version label in `keys` is a positive integer;
 * - every key decodes from base64 to exactly 32 bytes (a 256-bit key).
 *
 * Error messages reference version numbers and structural facts only —
 * never key material.
 */

import { Buffer } from 'node:buffer'
import { KeyringError } from './errors.ts'

export interface Keyring {
  activeVersion: number
  keys: Map<number, Uint8Array>
}

const KEY_BYTE_LENGTH = 32
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const VERSION_LABEL_PATTERN = /^[1-9][0-9]*$/

/**
 * Parses and validates a raw keyring document. Throws {@link KeyringError}
 * listing every problem; the error never contains key material.
 */
export function parseKeyring(raw: string): Keyring {
  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch {
    throw new KeyringError(['keyring is not valid JSON'])
  }

  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new KeyringError(['keyring must be a JSON object with "active_version" and "keys"'])
  }

  const issues: string[] = []
  const { active_version: rawActiveVersion, keys: rawKeys } = document as {
    active_version?: unknown
    keys?: unknown
  }

  let activeVersion: number | undefined
  if (
    typeof rawActiveVersion === 'number' &&
    Number.isInteger(rawActiveVersion) &&
    rawActiveVersion >= 1
  ) {
    activeVersion = rawActiveVersion
  } else {
    issues.push('keyring "active_version" must be an integer >= 1')
  }

  const keys = new Map<number, Uint8Array>()
  const declaredVersions = new Set<number>()

  if (rawKeys === null || typeof rawKeys !== 'object' || Array.isArray(rawKeys)) {
    issues.push(
      'keyring "keys" must be an object mapping version numbers to base64-encoded 256-bit keys',
    )
  } else {
    const entries = Object.entries(rawKeys as Record<string, unknown>)
    if (entries.length === 0) {
      issues.push('keyring "keys" must contain at least one key')
    }
    for (const [label, value] of entries) {
      if (!VERSION_LABEL_PATTERN.test(label)) {
        issues.push(`keyring key version "${label}" must be a positive integer`)
        continue
      }
      const version = Number(label)
      declaredVersions.add(version)
      if (typeof value !== 'string' || value === '' || !BASE64_PATTERN.test(value)) {
        issues.push(`keyring key for version ${version} must be a base64-encoded 256-bit key`)
        continue
      }
      const bytes = Buffer.from(value, 'base64')
      if (bytes.byteLength !== KEY_BYTE_LENGTH) {
        issues.push(
          `keyring key for version ${version} must decode to exactly ${KEY_BYTE_LENGTH} bytes (decoded to ${bytes.byteLength})`,
        )
        continue
      }
      keys.set(version, new Uint8Array(bytes))
    }
  }

  const keysWereObject = rawKeys !== null && typeof rawKeys === 'object' && !Array.isArray(rawKeys)
  if (activeVersion !== undefined && keysWereObject && !declaredVersions.has(activeVersion)) {
    issues.push(`keyring "active_version" ${activeVersion} has no corresponding entry in "keys"`)
  }

  if (issues.length > 0) {
    throw new KeyringError(issues)
  }

  return { activeVersion: activeVersion as number, keys }
}
