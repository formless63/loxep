import { describe, expect, it } from 'vitest'
import { describeConfigForLog, loadBootstrapConfig } from '../src/index.ts'
import { baseEnv } from './helpers.ts'

describe('describeConfigForLog', () => {
  it('summarizes non-secret facts', () => {
    const config = loadBootstrapConfig(
      baseEnv({
        LOXEP_OIDC_ISSUER: 'https://id.example.com',
        LOXEP_OIDC_CLIENT_ID: 'loxep',
        LOXEP_OIDC_CLIENT_SECRET: 'oidc-secret-marker',
      }),
    )
    const summary = describeConfigForLog(config)
    expect(summary).toEqual({
      mode: 'all',
      port: 3020,
      publicOrigin: 'https://loxep.example.com',
      logLevel: 'info',
      mediaRoot: './data/media',
      database: { host: 'db.internal', port: 5432, name: 'loxep' },
      loginPaths: { oidc: true, smtp: true },
      keyring: { activeVersion: 1, keyCount: 1 },
    })
  })

  it('reports database host/name without credentials', () => {
    const config = loadBootstrapConfig(
      baseEnv({ LOXEP_DATABASE_URL: 'postgres://user:db-password-marker@localhost/appdb' }),
    )
    const summary = describeConfigForLog(config)
    expect(summary.database).toEqual({ host: 'localhost', port: null, name: 'appdb' })
  })

  it('reports absent origin and login paths in worker mode', () => {
    const config = loadBootstrapConfig(
      baseEnv({
        LOXEP_MODE: 'worker',
        LOXEP_PUBLIC_ORIGIN: undefined,
        LOXEP_AUTH_SECRET: undefined,
        LOXEP_SMTP_URL: undefined,
        LOXEP_SMTP_FROM: undefined,
      }),
    )
    const summary = describeConfigForLog(config)
    expect(summary.mode).toBe('worker')
    expect(summary.publicOrigin).toBeNull()
    expect(summary.loginPaths).toEqual({ oidc: false, smtp: false })
  })

  it('contains no secret material anywhere in its serialized form', () => {
    const config = loadBootstrapConfig(
      baseEnv({
        LOXEP_OIDC_ISSUER: 'https://id.example.com',
        LOXEP_OIDC_CLIENT_ID: 'loxep',
        LOXEP_OIDC_CLIENT_SECRET: 'oidc-secret-marker',
      }),
    )
    const serialized = JSON.stringify(describeConfigForLog(config))
    for (const marker of [
      'db-password-marker',
      'auth-secret-marker',
      'smtp-password-marker',
      'oidc-secret-marker',
      config.databaseUrl,
    ]) {
      expect(serialized).not.toContain(marker)
    }
    // No base64 keyring material either.
    for (const key of config.keyring.keys.values()) {
      expect(serialized).not.toContain(Buffer.from(key).toString('base64'))
    }
  })
})
