import { describe, expect, it } from 'vitest'
import { BootstrapConfigError, loadBootstrapConfig } from '../src/index.ts'
import { baseEnv, loadError } from './helpers.ts'

describe('loadBootstrapConfig — valid configurations', () => {
  it('loads a complete env and applies defaults', () => {
    const config = loadBootstrapConfig(baseEnv({ LOXEP_MODE: undefined }))
    expect(config.mode).toBe('all')
    expect(config.port).toBe(3020)
    expect(config.mediaRoot).toBe('./data/media')
    expect(config.logLevel).toBe('info')
    expect(config.databaseUrl).toBe('postgres://loxep:db-password-marker@db.internal:5432/loxep')
    expect(config.publicOrigin).toBe('https://loxep.example.com')
    expect(config.keyring.activeVersion).toBe(1)
    expect(config.smtp).toEqual({
      url: 'smtps://mailer:smtp-password-marker@smtp.example.com:465',
      from: 'loxep@example.com',
    })
    expect(config.oidc).toBeUndefined()
    expect(config.bootstrapAdminEmail).toBeUndefined()
  })

  it('honours explicit non-default values', () => {
    const config = loadBootstrapConfig(
      baseEnv({
        LOXEP_MODE: 'web',
        LOXEP_PORT: '8080',
        LOXEP_MEDIA_ROOT: '/srv/loxep/media',
        LOXEP_LOG_LEVEL: 'debug',
        LOXEP_BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
      }),
    )
    expect(config.mode).toBe('web')
    expect(config.port).toBe(8080)
    expect(config.mediaRoot).toBe('/srv/loxep/media')
    expect(config.logLevel).toBe('debug')
    expect(config.bootstrapAdminEmail).toBe('admin@example.com')
  })

  it('accepts postgresql:// database URLs', () => {
    const config = loadBootstrapConfig(
      baseEnv({ LOXEP_DATABASE_URL: 'postgresql://u:p@localhost/loxep' }),
    )
    expect(config.databaseUrl).toBe('postgresql://u:p@localhost/loxep')
  })

  it('accepts the OIDC group as the only login path', () => {
    const config = loadBootstrapConfig(
      baseEnv({
        LOXEP_SMTP_URL: undefined,
        LOXEP_SMTP_FROM: undefined,
        LOXEP_OIDC_ISSUER: 'https://id.example.com/realms/loxep',
        LOXEP_OIDC_CLIENT_ID: 'loxep',
        LOXEP_OIDC_CLIENT_SECRET: 'oidc-client-secret-marker',
      }),
    )
    expect(config.oidc).toEqual({
      issuer: 'https://id.example.com/realms/loxep',
      clientId: 'loxep',
      clientSecret: 'oidc-client-secret-marker',
    })
    expect(config.smtp).toBeUndefined()
  })

  it('accepts both login paths together', () => {
    const config = loadBootstrapConfig(
      baseEnv({
        LOXEP_OIDC_ISSUER: 'https://id.example.com',
        LOXEP_OIDC_CLIENT_ID: 'loxep',
        LOXEP_OIDC_CLIENT_SECRET: 'oidc-secret',
      }),
    )
    expect(config.oidc).toBeDefined()
    expect(config.smtp).toBeDefined()
  })

  it('accepts smtp:// as well as smtps://', () => {
    const config = loadBootstrapConfig(baseEnv({ LOXEP_SMTP_URL: 'smtp://mail.internal:587' }))
    expect(config.smtp?.url).toBe('smtp://mail.internal:587')
  })

  it('worker mode does not require origin, auth secret, or a login path', () => {
    const config = loadBootstrapConfig(
      baseEnv({
        LOXEP_MODE: 'worker',
        LOXEP_PUBLIC_ORIGIN: undefined,
        LOXEP_AUTH_SECRET: undefined,
        LOXEP_SMTP_URL: undefined,
        LOXEP_SMTP_FROM: undefined,
      }),
    )
    expect(config.mode).toBe('worker')
    expect(config.publicOrigin).toBeUndefined()
    expect(config.authSecret).toBeUndefined()
    expect(config.smtp).toBeUndefined()
    expect(config.oidc).toBeUndefined()
  })

  it('treats empty-string env values as unset', () => {
    const config = loadBootstrapConfig(baseEnv({ LOXEP_MODE: '', LOXEP_PORT: '  ' }))
    expect(config.mode).toBe('all')
    expect(config.port).toBe(3020)
  })
})

describe('loadBootstrapConfig — required values and formats', () => {
  it('requires the database URL in every mode', () => {
    const error = loadError(
      baseEnv({
        LOXEP_MODE: 'worker',
        LOXEP_DATABASE_URL: undefined,
        LOXEP_PUBLIC_ORIGIN: undefined,
        LOXEP_AUTH_SECRET: undefined,
      }),
    )
    expect(error.issues).toHaveLength(1)
    expect(error.issues[0]).toContain('LOXEP_DATABASE_URL is required')
  })

  it('rejects a non-postgres database URL without echoing it', () => {
    const error = loadError(
      baseEnv({ LOXEP_DATABASE_URL: 'mysql://user:db-password-marker@host/db' }),
    )
    expect(error.message).toContain('LOXEP_DATABASE_URL must be a postgres://')
    expect(error.message).not.toContain('db-password-marker')
  })

  it('requires the keyring in every mode', () => {
    const error = loadError(
      baseEnv({
        LOXEP_MODE: 'worker',
        LOXEP_KEYRING: undefined,
        LOXEP_PUBLIC_ORIGIN: undefined,
        LOXEP_AUTH_SECRET: undefined,
      }),
    )
    expect(error.issues.some((issue) => issue.includes('LOXEP_KEYRING is required'))).toBe(true)
  })

  it('prefixes keyring problems with LOXEP_KEYRING', () => {
    const error = loadError(baseEnv({ LOXEP_KEYRING: '{"active_version":1,"keys":{}}' }))
    expect(error.issues.some((issue) => issue.startsWith('LOXEP_KEYRING:'))).toBe(true)
  })

  it('requires origin and auth secret in web mode', () => {
    const error = loadError(
      baseEnv({ LOXEP_MODE: 'web', LOXEP_PUBLIC_ORIGIN: undefined, LOXEP_AUTH_SECRET: undefined }),
    )
    expect(error.issues.some((issue) => issue.includes("LOXEP_PUBLIC_ORIGIN is required when LOXEP_MODE is 'web'"))).toBe(true)
    expect(error.issues.some((issue) => issue.includes("LOXEP_AUTH_SECRET (or LOXEP_AUTH_SECRET_FILE) is required when LOXEP_MODE is 'web'"))).toBe(true)
  })

  it('rejects a short auth secret without echoing it', () => {
    const error = loadError(baseEnv({ LOXEP_AUTH_SECRET: 'short-secret-marker' }))
    expect(error.message).toContain('LOXEP_AUTH_SECRET must be at least 32 characters')
    expect(error.message).not.toContain('short-secret-marker')
  })

  it.each(['0', '65536', 'abc', '-1', '80.5'])('rejects invalid port %j', (port) => {
    const error = loadError(baseEnv({ LOXEP_PORT: port }))
    expect(error.message).toContain('LOXEP_PORT must be an integer between 1 and 65535')
  })

  it('rejects an invalid mode', () => {
    const error = loadError(baseEnv({ LOXEP_MODE: 'webworker' }))
    expect(error.message).toContain("LOXEP_MODE must be one of 'all', 'web', 'worker'")
  })

  it('rejects an invalid log level', () => {
    const error = loadError(baseEnv({ LOXEP_LOG_LEVEL: 'verbose' }))
    expect(error.message).toContain('LOXEP_LOG_LEVEL must be one of')
  })

  it('rejects a non-URL public origin', () => {
    const error = loadError(baseEnv({ LOXEP_PUBLIC_ORIGIN: 'loxep.example.com' }))
    expect(error.message).toContain('LOXEP_PUBLIC_ORIGIN must be an http:// or https:// URL')
  })

  it('rejects an invalid bootstrap admin email', () => {
    const error = loadError(baseEnv({ LOXEP_BOOTSTRAP_ADMIN_EMAIL: 'not-an-email' }))
    expect(error.message).toContain('LOXEP_BOOTSTRAP_ADMIN_EMAIL must be a valid email address')
  })

  it('rejects an SMTP URL with the wrong scheme without echoing it', () => {
    const error = loadError(
      baseEnv({ LOXEP_SMTP_URL: 'https://mailer:smtp-password-marker@smtp.example.com' }),
    )
    expect(error.message).toContain('LOXEP_SMTP_URL must be an smtp:// or smtps:// URL')
    expect(error.message).not.toContain('smtp-password-marker')
  })

  it('rejects an invalid SMTP from address', () => {
    const error = loadError(baseEnv({ LOXEP_SMTP_FROM: 'not-an-email' }))
    expect(error.message).toContain('LOXEP_SMTP_FROM must be a valid email address')
  })
})

describe('loadBootstrapConfig — login-path and group rules', () => {
  it('reports an incomplete OIDC group naming the missing variables', () => {
    const error = loadError(baseEnv({ LOXEP_OIDC_ISSUER: 'https://id.example.com' }))
    expect(error.message).toContain('OIDC bootstrap group is incomplete')
    expect(error.message).toContain('LOXEP_OIDC_CLIENT_ID')
    expect(error.message).toContain('LOXEP_OIDC_CLIENT_SECRET')
  })

  it('reports an incomplete SMTP group naming the missing variable', () => {
    const error = loadError(baseEnv({ LOXEP_SMTP_FROM: undefined }))
    expect(error.message).toContain('SMTP bootstrap group is incomplete')
    expect(error.message).toContain('LOXEP_SMTP_FROM')
  })

  it('requires at least one login path in all mode', () => {
    const error = loadError(baseEnv({ LOXEP_SMTP_URL: undefined, LOXEP_SMTP_FROM: undefined }))
    expect(error.issues).toHaveLength(1)
    expect(error.issues[0]).toContain('At least one login path must be configured')
    expect(error.issues[0]).toContain('LOXEP_OIDC_ISSUER')
    expect(error.issues[0]).toContain('LOXEP_SMTP_URL')
  })

  it('requires at least one login path in web mode', () => {
    const error = loadError(
      baseEnv({ LOXEP_MODE: 'web', LOXEP_SMTP_URL: undefined, LOXEP_SMTP_FROM: undefined }),
    )
    expect(error.issues.some((issue) => issue.includes('At least one login path'))).toBe(true)
  })

  it('does not double-report the login-path rule when a group is partially set', () => {
    const error = loadError(
      baseEnv({
        LOXEP_SMTP_URL: undefined,
        LOXEP_SMTP_FROM: undefined,
        LOXEP_OIDC_ISSUER: 'https://id.example.com',
      }),
    )
    expect(error.message).toContain('OIDC bootstrap group is incomplete')
    expect(error.message).not.toContain('At least one login path')
  })
})

describe('loadBootstrapConfig — error aggregation and redaction', () => {
  it('aggregates every problem into one error', () => {
    const error = loadError({
      LOXEP_MODE: 'bogus',
      LOXEP_PORT: 'not-a-port',
      LOXEP_LOG_LEVEL: 'loud',
      LOXEP_KEYRING: 'not json',
      LOXEP_BOOTSTRAP_ADMIN_EMAIL: 'nope',
    })
    expect(error.issues.length).toBeGreaterThanOrEqual(5)
    expect(error.message).toContain('LOXEP_MODE')
    expect(error.message).toContain('LOXEP_DATABASE_URL')
    expect(error.message).toContain('LOXEP_PORT')
    expect(error.message).toContain('LOXEP_LOG_LEVEL')
    expect(error.message).toContain('LOXEP_KEYRING')
    expect(error.message).toContain('LOXEP_BOOTSTRAP_ADMIN_EMAIL')
  })

  it('is an Error instance with a stable name', () => {
    const error = loadError(baseEnv({ LOXEP_DATABASE_URL: undefined }))
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(BootstrapConfigError)
    expect(error.name).toBe('BootstrapConfigError')
  })

  it('never echoes secret values in aggregate errors', () => {
    const error = loadError(
      baseEnv({
        LOXEP_DATABASE_URL: 'mysql://u:db-password-marker@h/db',
        LOXEP_AUTH_SECRET: 'short-auth-marker',
        LOXEP_SMTP_URL: 'ftp://u:smtp-password-marker@h',
        LOXEP_KEYRING: '{"active_version":1,"keys":{"1":"key-material-marker!!!"}}',
        LOXEP_OIDC_ISSUER: 'not a url',
        LOXEP_OIDC_CLIENT_ID: 'client',
        LOXEP_OIDC_CLIENT_SECRET: 'oidc-secret-marker',
      }),
    )
    for (const marker of [
      'db-password-marker',
      'short-auth-marker',
      'smtp-password-marker',
      'key-material-marker',
      'oidc-secret-marker',
    ]) {
      expect(error.message).not.toContain(marker)
    }
  })
})
