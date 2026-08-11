/**
 * @loxep/domain — settings, secrets, credentials, and audit domain services
 * (ADR-0016, ADR-0019, ADR-0020).
 */

export {
  DomainError,
  SettingNotRegisteredError,
  SettingValidationError,
  SecretCipherError,
  BundleValidationError,
  UnknownPurposeError,
  SecretNotFoundError,
  SecretsServiceError,
} from "./errors.ts";

export { REDACTED, redactJson } from "./redact.ts";
export type { RedactOptions } from "./redact.ts";

export { createAuditService } from "./audit.ts";
export type {
  AuditAppendInput,
  AuditExecutor,
  AuditService,
} from "./audit.ts";

export {
  defineSetting,
  createSettingsService,
  registeredSettingKeys,
} from "./settings.ts";
export type {
  SettingDefinition,
  SettingListEntry,
  SettingsService,
} from "./settings.ts";

export {
  applicationSecretAad,
  connectionCredentialAad,
  createSecretCipher,
} from "./crypto.ts";
export type { EncryptedRecord, SecretCipher } from "./crypto.ts";

export {
  isSecretPurpose,
  secretBundleSchemas,
  secretPurposes,
  validateBundle,
} from "./bundles.ts";
export type {
  SecretBundle,
  SecretPayload,
  SecretPurpose,
} from "./bundles.ts";

export { createSecretsService } from "./secrets.ts";
export type {
  SecretMetadata,
  SecretWriteResult,
  SecretsService,
} from "./secrets.ts";

export { createConnectionCredentialsService } from "./connection-credentials.ts";
export type {
  ConnectionCredentialsService,
  CredentialMetadata,
  CredentialWriteResult,
} from "./connection-credentials.ts";
