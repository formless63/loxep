/**
 * Typed bootstrap configuration loader per ADR-0016.
 *
 * Bootstrap configuration is the small set of values that must exist before
 * Loxep can load PostgreSQL-backed settings or authenticate the first
 * administrator: database connectivity, process mode, canonical origin, the
 * Better Auth secret, the root encryption keyring, at least one initial login
 * path (OIDC and/or SMTP magic-link), first-admin bootstrap identity, and the
 * local media root.
 *
 * All validation failures are aggregated into one {@link BootstrapConfigError}
 * that names the offending environment variables. Error messages never echo
 * secret values.
 */

import { z } from 'zod'
import { BootstrapConfigError, KeyringError } from './errors.ts'
import { parseKeyring, type Keyring } from './keyring.ts'
import { normalizeEnvValue, resolveSecretInput } from './secret-files.ts'

export const LOXEP_MODES = ['all', 'web', 'worker'] as const
export type LoxepMode = (typeof LOXEP_MODES)[number]

export const LOXEP_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const
export type LoxepLogLevel = (typeof LOXEP_LOG_LEVELS)[number]

export interface OidcBootstrapConfig {
  issuer: string
  clientId: string
  clientSecret: string
  /**
   * Claim carrying the user's email address, read by `@loxep/auth`'s
   * `mapProfileToUser` hook when it differs from OIDC's standard `email`
   * claim (`LOXEP_OIDC_EMAIL_CLAIM`, default {@link DEFAULT_OIDC_EMAIL_CLAIM}).
   * A pre-DB bootstrap fact — like the rest of `OidcBootstrapConfig` it is
   * fixed for the life of the process, and it is what lets an operator whose
   * IdP names the claim something else (`acme_email`) still create accounts
   * with the right address. Claim-to-ROLE mapping (ADR-0024 §6) is unrelated
   * and untouched by this field.
   */
  emailClaim: string
}

export interface SmtpBootstrapConfig {
  url: string
  from: string
}

export interface BootstrapConfig {
  mode: LoxepMode
  /** PostgreSQL connection URL. Contains credentials — never log directly. */
  databaseUrl: string
  /** Canonical public origin; present when mode is `web` or `all`. */
  publicOrigin: string | undefined
  port: number
  /** Better Auth application/session secret; present when mode is `web` or `all`. */
  authSecret: string | undefined
  /** External root encryption keyring (ADR-0019). Required in every mode. */
  keyring: Keyring
  /** OIDC bootstrap login path, when configured. */
  oidc: OidcBootstrapConfig | undefined
  /** SMTP magic-link bootstrap login path, when configured. */
  smtp: SmtpBootstrapConfig | undefined
  /** First-admin bootstrap identity (ADR-0016 recovery path). */
  bootstrapAdminEmail: string | undefined
  /** Filesystem root for the `local` storage driver. */
  mediaRoot: string
  logLevel: LoxepLogLevel
}

export const DEFAULT_PORT = 3020
export const DEFAULT_MEDIA_ROOT = './data/media'
/** OIDC's standard email claim — the default for `LOXEP_OIDC_EMAIL_CLAIM`. */
export const DEFAULT_OIDC_EMAIL_CLAIM = 'email'

const modeSchema = z.enum(LOXEP_MODES)
const logLevelSchema = z.enum(LOXEP_LOG_LEVELS)
const postgresUrlSchema = z.url({ protocol: /^postgres(ql)?$/ })
const httpUrlSchema = z.url({ protocol: /^https?$/ })
const smtpUrlSchema = z.url({ protocol: /^smtps?$/ })
const emailSchema = z.email()
const authSecretSchema = z.string().min(32)
const portSchema = z
  .string()
  .regex(/^[0-9]+$/)
  .transform(Number)
  .pipe(z.int().min(1).max(65535))

/**
 * Validates `value` against `schema`; on failure appends the fixed `issue`
 * message (never zod's own message, so no input value can leak) and returns
 * `undefined`. An `undefined` input passes through silently — requiredness is
 * handled separately per mode.
 */
function check<Schema extends z.ZodType>(
  schema: Schema,
  value: string | undefined,
  issue: string,
  issues: string[],
): z.output<Schema> | undefined {
  if (value === undefined) return undefined
  const result = schema.safeParse(value)
  if (!result.success) {
    issues.push(issue)
    return undefined
  }
  return result.data
}

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('bootstrap config invariant violated: value missing without a recorded issue')
  }
  return value
}

/**
 * Loads and validates bootstrap configuration from `env` (default
 * `process.env`). Throws {@link BootstrapConfigError} listing every problem;
 * error messages name environment variables and never echo secret values.
 */
export function loadBootstrapConfig(
  env: Record<string, string | undefined> = process.env,
): BootstrapConfig {
  const issues: string[] = []

  // --- mode -----------------------------------------------------------------
  const modeRaw = normalizeEnvValue(env['LOXEP_MODE'])
  const mode: LoxepMode | undefined =
    modeRaw === undefined
      ? 'all'
      : check(modeSchema, modeRaw, "LOXEP_MODE must be one of 'all', 'web', 'worker'", issues)
  // When the mode itself is invalid we skip mode-conditional requiredness
  // checks; the mode issue is reported and format checks still run.
  const requiresWeb = mode === 'web' || mode === 'all'

  // --- database -------------------------------------------------------------
  const databaseInput = resolveSecretInput(env, 'LOXEP_DATABASE_URL', issues)
  let databaseUrl: string | undefined
  if (databaseInput.value !== undefined) {
    databaseUrl = check(
      postgresUrlSchema,
      databaseInput.value,
      'LOXEP_DATABASE_URL must be a postgres:// or postgresql:// URL',
      issues,
    )
  } else if (!databaseInput.errored) {
    issues.push('LOXEP_DATABASE_URL is required (set LOXEP_DATABASE_URL or LOXEP_DATABASE_URL_FILE)')
  }

  // --- public origin --------------------------------------------------------
  const publicOriginRaw = normalizeEnvValue(env['LOXEP_PUBLIC_ORIGIN'])
  const publicOrigin = check(
    httpUrlSchema,
    publicOriginRaw,
    'LOXEP_PUBLIC_ORIGIN must be an http:// or https:// URL',
    issues,
  )
  if (publicOriginRaw === undefined && requiresWeb) {
    issues.push(`LOXEP_PUBLIC_ORIGIN is required when LOXEP_MODE is '${mode}'`)
  }

  // --- port -----------------------------------------------------------------
  const portRaw = normalizeEnvValue(env['LOXEP_PORT'])
  const port =
    portRaw === undefined
      ? DEFAULT_PORT
      : check(portSchema, portRaw, 'LOXEP_PORT must be an integer between 1 and 65535', issues)

  // --- auth secret ----------------------------------------------------------
  const authInput = resolveSecretInput(env, 'LOXEP_AUTH_SECRET', issues)
  let authSecret: string | undefined
  if (authInput.value !== undefined) {
    authSecret = check(
      authSecretSchema,
      authInput.value,
      'LOXEP_AUTH_SECRET must be at least 32 characters long',
      issues,
    )
  } else if (!authInput.errored && requiresWeb) {
    issues.push(
      `LOXEP_AUTH_SECRET (or LOXEP_AUTH_SECRET_FILE) is required when LOXEP_MODE is '${mode}'`,
    )
  }

  // --- keyring --------------------------------------------------------------
  const keyringInput = resolveSecretInput(env, 'LOXEP_KEYRING', issues)
  let keyring: Keyring | undefined
  if (keyringInput.value !== undefined) {
    try {
      keyring = parseKeyring(keyringInput.value)
    } catch (error) {
      if (error instanceof KeyringError) {
        issues.push(...error.issues.map((issue) => `LOXEP_KEYRING: ${issue}`))
      } else {
        throw error
      }
    }
  } else if (!keyringInput.errored) {
    issues.push(
      'LOXEP_KEYRING is required in every mode (set LOXEP_KEYRING or LOXEP_KEYRING_FILE)',
    )
  }

  // --- OIDC bootstrap group (all-or-none) -----------------------------------
  const oidcIssuerRaw = normalizeEnvValue(env['LOXEP_OIDC_ISSUER'])
  const oidcClientIdRaw = normalizeEnvValue(env['LOXEP_OIDC_CLIENT_ID'])
  const oidcSecretInput = resolveSecretInput(env, 'LOXEP_OIDC_CLIENT_SECRET', issues)
  const oidcSecretSupplied = oidcSecretInput.value !== undefined || oidcSecretInput.errored
  const oidcPresence: ReadonlyArray<readonly [string, boolean]> = [
    ['LOXEP_OIDC_ISSUER', oidcIssuerRaw !== undefined],
    ['LOXEP_OIDC_CLIENT_ID', oidcClientIdRaw !== undefined],
    ['LOXEP_OIDC_CLIENT_SECRET (or LOXEP_OIDC_CLIENT_SECRET_FILE)', oidcSecretSupplied],
  ]
  const oidcAttempted = oidcPresence.some(([, present]) => present)
  const oidcComplete = oidcPresence.every(([, present]) => present)
  if (oidcAttempted && !oidcComplete) {
    const missing = oidcPresence
      .filter(([, present]) => !present)
      .map(([name]) => name)
      .join(', ')
    issues.push(
      `OIDC bootstrap group is incomplete: missing ${missing} — LOXEP_OIDC_ISSUER, ` +
        'LOXEP_OIDC_CLIENT_ID, and LOXEP_OIDC_CLIENT_SECRET must be set together',
    )
  }
  // --- OIDC email claim override (independent of the group above: it is a
  // deployment-wide default validated regardless of whether OIDC itself is
  // configured, matching LOXEP_MEDIA_ROOT/LOXEP_LOG_LEVEL's always-checked
  // shape) -------------------------------------------------------------------
  const oidcEmailClaimRaw = normalizeEnvValue(env['LOXEP_OIDC_EMAIL_CLAIM'])
  const oidcEmailClaimSchema = z.string().trim().min(1)
  const oidcEmailClaim: string | undefined =
    oidcEmailClaimRaw === undefined
      ? DEFAULT_OIDC_EMAIL_CLAIM
      : check(
          oidcEmailClaimSchema,
          oidcEmailClaimRaw,
          'LOXEP_OIDC_EMAIL_CLAIM must be a non-empty string',
          issues,
        )

  let oidc: OidcBootstrapConfig | undefined
  if (oidcComplete) {
    const issuer = check(
      httpUrlSchema,
      oidcIssuerRaw,
      'LOXEP_OIDC_ISSUER must be an http:// or https:// URL',
      issues,
    )
    if (issuer !== undefined && oidcClientIdRaw !== undefined && oidcSecretInput.value !== undefined) {
      oidc = {
        issuer,
        clientId: oidcClientIdRaw,
        clientSecret: oidcSecretInput.value,
        // `issues.length > 0` throws below before this value is ever read, so
        // the fallback here only satisfies the type when validation already
        // failed — never a silently-wrong default in a returned config.
        emailClaim: oidcEmailClaim ?? DEFAULT_OIDC_EMAIL_CLAIM,
      }
    }
  }

  // --- SMTP bootstrap group (all-or-none) -----------------------------------
  const smtpUrlInput = resolveSecretInput(env, 'LOXEP_SMTP_URL', issues)
  const smtpFromRaw = normalizeEnvValue(env['LOXEP_SMTP_FROM'])
  const smtpUrlSupplied = smtpUrlInput.value !== undefined || smtpUrlInput.errored
  const smtpPresence: ReadonlyArray<readonly [string, boolean]> = [
    ['LOXEP_SMTP_URL (or LOXEP_SMTP_URL_FILE)', smtpUrlSupplied],
    ['LOXEP_SMTP_FROM', smtpFromRaw !== undefined],
  ]
  const smtpAttempted = smtpPresence.some(([, present]) => present)
  const smtpComplete = smtpPresence.every(([, present]) => present)
  if (smtpAttempted && !smtpComplete) {
    const missing = smtpPresence
      .filter(([, present]) => !present)
      .map(([name]) => name)
      .join(', ')
    issues.push(
      `SMTP bootstrap group is incomplete: missing ${missing} — LOXEP_SMTP_URL and ` +
        'LOXEP_SMTP_FROM must be set together',
    )
  }
  let smtp: SmtpBootstrapConfig | undefined
  if (smtpComplete) {
    const smtpUrl = check(
      smtpUrlSchema,
      smtpUrlInput.value,
      'LOXEP_SMTP_URL must be an smtp:// or smtps:// URL',
      issues,
    )
    const smtpFrom = check(
      emailSchema,
      smtpFromRaw,
      'LOXEP_SMTP_FROM must be a valid email address',
      issues,
    )
    if (smtpUrl !== undefined && smtpFrom !== undefined) {
      smtp = { url: smtpUrl, from: smtpFrom }
    }
  }

  // --- login-path rule ------------------------------------------------------
  // Phase-0 rule: a web-serving deployment must configure at least one
  // complete login path before the first administrator can authenticate.
  if (requiresWeb && !oidcAttempted && !smtpAttempted) {
    issues.push(
      `At least one login path must be configured when LOXEP_MODE is '${mode}': set the OIDC ` +
        'group (LOXEP_OIDC_ISSUER, LOXEP_OIDC_CLIENT_ID, LOXEP_OIDC_CLIENT_SECRET) and/or the ' +
        'SMTP group (LOXEP_SMTP_URL, LOXEP_SMTP_FROM)',
    )
  }

  // --- first-admin bootstrap ------------------------------------------------
  const bootstrapAdminEmail = check(
    emailSchema,
    normalizeEnvValue(env['LOXEP_BOOTSTRAP_ADMIN_EMAIL']),
    'LOXEP_BOOTSTRAP_ADMIN_EMAIL must be a valid email address',
    issues,
  )

  // --- media root -----------------------------------------------------------
  const mediaRoot = normalizeEnvValue(env['LOXEP_MEDIA_ROOT']) ?? DEFAULT_MEDIA_ROOT

  // --- log level ------------------------------------------------------------
  const logLevelRaw = normalizeEnvValue(env['LOXEP_LOG_LEVEL'])
  const logLevel: LoxepLogLevel | undefined =
    logLevelRaw === undefined
      ? 'info'
      : check(
          logLevelSchema,
          logLevelRaw,
          "LOXEP_LOG_LEVEL must be one of 'fatal', 'error', 'warn', 'info', 'debug', 'trace'",
          issues,
        )

  if (issues.length > 0) {
    throw new BootstrapConfigError(issues)
  }

  return {
    mode: required(mode),
    databaseUrl: required(databaseUrl),
    publicOrigin,
    port: required(port),
    authSecret,
    keyring: required(keyring),
    oidc,
    smtp,
    bootstrapAdminEmail,
    mediaRoot,
    logLevel: required(logLevel),
  }
}
