/**
 * Mounted-secret (`*_FILE`) input resolution.
 *
 * Per the configuration & secrets architecture doc, bootstrap secret inputs
 * support mounted-file/Docker-secret delivery: for any variable `VAR` with a
 * `VAR_FILE` variant, setting `VAR_FILE` reads the value from that file
 * (trailing newlines trimmed). Setting both `VAR` and `VAR_FILE` is an error.
 */

import { readFileSync } from 'node:fs'

/**
 * Normalizes a raw environment value: trims surrounding whitespace and treats
 * empty/whitespace-only values as unset (Compose commonly materializes unset
 * interpolations as empty strings).
 */
export function normalizeEnvValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

export interface ResolvedSecretInput {
  /** The resolved value, or `undefined` when unset or when resolution failed. */
  value: string | undefined
  /**
   * True when the input was supplied but could not be resolved (both variants
   * set, unreadable file, empty file). Callers must not add a "required"
   * issue on top of an already-recorded resolution failure.
   */
  errored: boolean
}

/**
 * Resolves `name` / `name_FILE` from `env`, appending any resolution problem
 * to `issues`. File contents have trailing newlines (LF or CRLF) trimmed.
 */
export function resolveSecretInput(
  env: Record<string, string | undefined>,
  name: string,
  issues: string[],
): ResolvedSecretInput {
  const fileName = `${name}_FILE`
  const direct = normalizeEnvValue(env[name])
  const filePath = normalizeEnvValue(env[fileName])

  if (direct !== undefined && filePath !== undefined) {
    issues.push(`${name} and ${fileName} are both set; provide exactly one`)
    return { value: undefined, errored: true }
  }

  if (filePath !== undefined) {
    let content: string
    try {
      content = readFileSync(filePath, 'utf8')
    } catch {
      issues.push(`${fileName}: cannot read file at path ${filePath}`)
      return { value: undefined, errored: true }
    }
    const value = content.replace(/(?:\r?\n)+$/, '')
    if (value === '') {
      issues.push(`${fileName}: file at path ${filePath} is empty`)
      return { value: undefined, errored: true }
    }
    return { value, errored: false }
  }

  return { value: direct, errored: false }
}
