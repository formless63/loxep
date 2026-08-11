/**
 * @loxep/config — typed bootstrap configuration for Loxep.
 *
 * Bootstrap/deployment configuration per ADR-0016 (env vars + mounted secret
 * files only for pre-database facts), external keyring per ADR-0019, process
 * modes per ADR-0018.
 */

export {
  DEFAULT_MEDIA_ROOT,
  DEFAULT_PORT,
  LOXEP_LOG_LEVELS,
  LOXEP_MODES,
  loadBootstrapConfig,
} from './bootstrap.ts'
export type {
  BootstrapConfig,
  LoxepLogLevel,
  LoxepMode,
  OidcBootstrapConfig,
  SmtpBootstrapConfig,
} from './bootstrap.ts'

export { parseKeyring } from './keyring.ts'
export type { Keyring } from './keyring.ts'

export { describeConfigForLog } from './describe.ts'
export type { BootstrapConfigLogSummary, DatabaseLogSummary } from './describe.ts'

export { BootstrapConfigError, KeyringError } from './errors.ts'
