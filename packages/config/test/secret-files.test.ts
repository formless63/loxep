import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadBootstrapConfig } from '../src/index.ts'
import { baseEnv, keyringJson, loadError } from './helpers.ts'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'loxep-config-test-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function secretFile(name: string, content: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, content, 'utf8')
  return path
}

describe('mounted-secret (_FILE) loading', () => {
  it('loads the auth secret from a file and trims the trailing newline', async () => {
    const path = await secretFile('auth-secret', 'file-auth-secret-0123456789-0123456789\n')
    const config = loadBootstrapConfig(
      baseEnv({ LOXEP_AUTH_SECRET: undefined, LOXEP_AUTH_SECRET_FILE: path }),
    )
    expect(config.authSecret).toBe('file-auth-secret-0123456789-0123456789')
  })

  it('trims CRLF and repeated trailing newlines', async () => {
    const path = await secretFile('auth-secret-crlf', 'file-auth-secret-0123456789-0123456789\r\n\r\n')
    const config = loadBootstrapConfig(
      baseEnv({ LOXEP_AUTH_SECRET: undefined, LOXEP_AUTH_SECRET_FILE: path }),
    )
    expect(config.authSecret).toBe('file-auth-secret-0123456789-0123456789')
  })

  it('loads the keyring and database URL from files', async () => {
    const keyringPath = await secretFile('keyring.json', `${keyringJson()}\n`)
    const dbPath = await secretFile('db-url', 'postgres://loxep:pw@db:5432/loxep\n')
    const config = loadBootstrapConfig(
      baseEnv({
        LOXEP_KEYRING: undefined,
        LOXEP_KEYRING_FILE: keyringPath,
        LOXEP_DATABASE_URL: undefined,
        LOXEP_DATABASE_URL_FILE: dbPath,
      }),
    )
    expect(config.keyring.activeVersion).toBe(1)
    expect(config.databaseUrl).toBe('postgres://loxep:pw@db:5432/loxep')
  })

  it('loads OIDC client secret and SMTP URL from files', async () => {
    const oidcPath = await secretFile('oidc-secret', 'oidc-file-secret\n')
    const smtpPath = await secretFile('smtp-url', 'smtps://u:p@mail.example.com:465\n')
    const config = loadBootstrapConfig(
      baseEnv({
        LOXEP_SMTP_URL: undefined,
        LOXEP_SMTP_URL_FILE: smtpPath,
        LOXEP_OIDC_ISSUER: 'https://id.example.com',
        LOXEP_OIDC_CLIENT_ID: 'loxep',
        LOXEP_OIDC_CLIENT_SECRET_FILE: oidcPath,
      }),
    )
    expect(config.oidc?.clientSecret).toBe('oidc-file-secret')
    expect(config.smtp?.url).toBe('smtps://u:p@mail.example.com:465')
  })

  it('rejects setting both VAR and VAR_FILE', async () => {
    const path = await secretFile('auth-secret-both', 'file-auth-secret-0123456789-0123456789\n')
    const error = loadError(baseEnv({ LOXEP_AUTH_SECRET_FILE: path }))
    expect(error.issues).toContain(
      'LOXEP_AUTH_SECRET and LOXEP_AUTH_SECRET_FILE are both set; provide exactly one',
    )
    // No additional "required" noise for the same variable.
    expect(
      error.issues.filter((issue) => issue.includes('LOXEP_AUTH_SECRET')),
    ).toHaveLength(1)
  })

  it('rejects an unreadable file, naming the _FILE variable', () => {
    const missing = join(dir, 'does-not-exist')
    const error = loadError(
      baseEnv({ LOXEP_KEYRING: undefined, LOXEP_KEYRING_FILE: missing }),
    )
    expect(error.issues.some((issue) => issue.startsWith('LOXEP_KEYRING_FILE: cannot read file'))).toBe(
      true,
    )
    // The missing-required message must not also fire.
    expect(error.issues.some((issue) => issue.includes('LOXEP_KEYRING is required'))).toBe(false)
  })

  it('rejects an empty secret file', async () => {
    const path = await secretFile('empty-secret', '\n')
    const error = loadError(baseEnv({ LOXEP_AUTH_SECRET: undefined, LOXEP_AUTH_SECRET_FILE: path }))
    expect(error.issues.some((issue) => issue.includes('LOXEP_AUTH_SECRET_FILE') && issue.includes('empty'))).toBe(
      true,
    )
  })

  it('does not trim interior newlines from file contents', async () => {
    const path = await secretFile('keyring-pretty.json', `${JSON.stringify(JSON.parse(keyringJson()), null, 2)}\n`)
    const config = loadBootstrapConfig(baseEnv({ LOXEP_KEYRING: undefined, LOXEP_KEYRING_FILE: path }))
    expect(config.keyring.keys.size).toBe(1)
  })
})
