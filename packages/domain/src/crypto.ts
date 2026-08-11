/**
 * AES-256-GCM secret cipher with keyring versioning and context-binding AAD
 * (ADR-0019).
 *
 * The AAD serialization implemented here is part of the persistence format —
 * changing it requires re-encrypting every stored secret:
 *
 * ```text
 * loxep:application_secret:<secret_id>:<version>:<key_version>
 * loxep:connection_credential:<credential_id>:<version>:<key_version>
 * ```
 *
 * Errors reference key versions and structural facts only — never plaintext,
 * ciphertext, or key material.
 */
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Keyring } from "@loxep/config";
import { SecretCipherError } from "./errors.ts";

const NONCE_BYTE_LENGTH = 12;
const AUTH_TAG_BYTE_LENGTH = 16;

/** AAD for an application secret version (ADR-0019 exact serialization). */
export function applicationSecretAad(
  secretId: string,
  version: number,
  keyVersion: number,
): string {
  return `loxep:application_secret:${secretId}:${version}:${keyVersion}`;
}

/** AAD for a connection credential version (ADR-0019 exact serialization). */
export function connectionCredentialAad(
  credentialId: string,
  version: number,
  keyVersion: number,
): string {
  return `loxep:connection_credential:${credentialId}:${version}:${keyVersion}`;
}

/** One encrypted record as persisted on a version row. */
export interface EncryptedRecord {
  keyVersion: number;
  nonce: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

export interface SecretCipher {
  /** Encrypts with the keyring's active key version and a fresh nonce. */
  encrypt: (plaintext: Uint8Array, aad: string) => EncryptedRecord;
  /**
   * Decrypts one record; throws {@link SecretCipherError} on unknown key
   * version or authentication failure (wrong key, tampered ciphertext/tag,
   * or AAD mismatch).
   */
  decrypt: (record: EncryptedRecord, aad: string) => Uint8Array;
}

export function createSecretCipher(keyring: Keyring): SecretCipher {
  function keyFor(version: number): Uint8Array {
    const key = keyring.keys.get(version);
    if (key === undefined) {
      throw new SecretCipherError(
        `unknown key version ${version} (keyring holds versions ${[...keyring.keys.keys()].sort((a, b) => a - b).join(", ")})`,
      );
    }
    return key;
  }

  function encrypt(plaintext: Uint8Array, aad: string): EncryptedRecord {
    const keyVersion = keyring.activeVersion;
    const key = keyFor(keyVersion);
    const nonce = randomBytes(NONCE_BYTE_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, {
      authTagLength: AUTH_TAG_BYTE_LENGTH,
    });
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { keyVersion, nonce, authTag, ciphertext };
  }

  function decrypt(record: EncryptedRecord, aad: string): Uint8Array {
    const key = keyFor(record.keyVersion);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, record.nonce, {
        authTagLength: AUTH_TAG_BYTE_LENGTH,
      });
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(record.authTag);
      return Buffer.concat([
        decipher.update(record.ciphertext),
        decipher.final(),
      ]);
    } catch (error) {
      if (error instanceof SecretCipherError) throw error;
      throw new SecretCipherError(
        `decryption failed for key version ${record.keyVersion}: ciphertext, auth tag, or additional authenticated data did not authenticate`,
      );
    }
  }

  return { encrypt, decrypt };
}
