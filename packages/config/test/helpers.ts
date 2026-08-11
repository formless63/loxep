import { Buffer } from 'node:buffer'
import { BootstrapConfigError, loadBootstrapConfig } from '../src/index.ts'

/** Base64 of `length` bytes, each set to `fill`. Default: a valid 256-bit key. */
export function keyBase64(fill = 1, length = 32): string {
  return Buffer.alloc(length, fill).toString('base64')
}

/** A minimal valid keyring JSON document. */
export function keyringJson(): string {
  return JSON.stringify({ active_version: 1, keys: { '1': keyBase64() } })
}

/**
 * A complete valid environment (mode `all`, SMTP login path). Override or
 * unset (with `undefined`) individual variables per test.
 */
export function baseEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    LOXEP_MODE: 'all',
    LOXEP_DATABASE_URL: 'postgres://loxep:db-password-marker@db.internal:5432/loxep',
    LOXEP_PUBLIC_ORIGIN: 'https://loxep.example.com',
    LOXEP_AUTH_SECRET: 'auth-secret-marker-0123456789-0123456789',
    LOXEP_KEYRING: keyringJson(),
    LOXEP_SMTP_URL: 'smtps://mailer:smtp-password-marker@smtp.example.com:465',
    LOXEP_SMTP_FROM: 'loxep@example.com',
    ...overrides,
  }
}

/** Loads config expecting failure; returns the aggregate error. */
export function loadError(env: Record<string, string | undefined>): BootstrapConfigError {
  try {
    loadBootstrapConfig(env)
  } catch (error) {
    if (error instanceof BootstrapConfigError) return error
    throw error
  }
  throw new Error('expected loadBootstrapConfig to throw BootstrapConfigError')
}
