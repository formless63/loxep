/**
 * Redacted bootstrap-configuration summary, safe for startup logging.
 *
 * Includes only non-secret facts: mode, port, origin, which login paths are
 * configured, keyring active version and key count, media root, and the
 * database host/port/name with credentials stripped. Never include the
 * database URL, auth secret, keyring material, OIDC client secret, or SMTP
 * URL in log output.
 */

import type { BootstrapConfig } from './bootstrap.ts'

export interface DatabaseLogSummary {
  host: string | null
  port: number | null
  name: string | null
}

export interface BootstrapConfigLogSummary {
  mode: string
  port: number
  publicOrigin: string | null
  logLevel: string
  mediaRoot: string
  database: DatabaseLogSummary
  loginPaths: { oidc: boolean; smtp: boolean }
  keyring: { activeVersion: number; keyCount: number }
}

/** Returns a plain object safe to pass to a structured logger at startup. */
export function describeConfigForLog(config: BootstrapConfig): BootstrapConfigLogSummary {
  return {
    mode: config.mode,
    port: config.port,
    publicOrigin: config.publicOrigin ?? null,
    logLevel: config.logLevel,
    mediaRoot: config.mediaRoot,
    database: describeDatabase(config.databaseUrl),
    loginPaths: { oidc: config.oidc !== undefined, smtp: config.smtp !== undefined },
    keyring: {
      activeVersion: config.keyring.activeVersion,
      keyCount: config.keyring.keys.size,
    },
  }
}

function describeDatabase(databaseUrl: string): DatabaseLogSummary {
  try {
    const url = new URL(databaseUrl)
    const name = decodeURIComponent(url.pathname.replace(/^\//, ''))
    return {
      host: url.hostname === '' ? null : url.hostname,
      port: url.port === '' ? null : Number(url.port),
      name: name === '' ? null : name,
    }
  } catch {
    return { host: null, port: null, name: null }
  }
}
