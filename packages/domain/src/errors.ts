/**
 * Domain-service error types.
 *
 * Every error message here is written under one rule: it may reference keys,
 * purposes, versions, and structural facts — never plaintext secret material,
 * ciphertext, or key bytes.
 */

/** Base class for all @loxep/domain errors. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A setting definition was not created through the registry. */
export class SettingNotRegisteredError extends DomainError {}

/** A stored/incoming setting value failed its registered Zod schema. */
export class SettingValidationError extends DomainError {}

/**
 * Encryption/decryption failure: unknown key version, or ciphertext / auth
 * tag / AAD that fails authentication. Never carries material.
 */
export class SecretCipherError extends DomainError {}

/** A secret/credential payload failed its purpose bundle schema. */
export class BundleValidationError extends DomainError {}

/** Purpose/credential type with no registered bundle schema. */
export class UnknownPurposeError extends DomainError {}

/** Logical secret/credential does not exist. */
export class SecretNotFoundError extends DomainError {}

/** Misuse of the secrets/credentials service (purpose mismatch, etc.). */
export class SecretsServiceError extends DomainError {}

/** Entity/connection input failed its Zod schema (kind, status, config…). */
export class DomainValidationError extends DomainError {}

/** Referenced economic entity does not exist. */
export class EntityNotFoundError extends DomainError {}

/** Economic-entity parent relationship is invalid: self-parent, cycle, or depth cap. */
export class EntityHierarchyError extends DomainError {}

/** Operation requires an active economic entity but the entity is deactivated. */
export class EntityInactiveError extends DomainError {}

/** Referenced connection does not exist. */
export class ConnectionNotFoundError extends DomainError {}
