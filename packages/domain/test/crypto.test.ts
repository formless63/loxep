/**
 * Secret cipher unit tests: AES-256-GCM roundtrip, AAD binding, key
 * versioning/rotation, and the no-material-in-errors rule (ADR-0019).
 */
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  SecretCipherError,
  applicationSecretAad,
  connectionCredentialAad,
  createSecretCipher,
} from "../src/index.ts";
import { testKeyring } from "./helpers.ts";

const MARKER = "PLAINTEXT-MARKER-c9d41ab7";

function expectCipherError(fn: () => unknown): SecretCipherError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SecretCipherError);
  const error = caught as SecretCipherError;
  expect(error.message).not.toContain(MARKER);
  expect(String(error.stack)).not.toContain(MARKER);
  return error;
}

describe("AAD builders", () => {
  it("serialize exactly per ADR-0019", () => {
    expect(applicationSecretAad("abc-123", 4, 2)).toBe(
      "loxep:application_secret:abc-123:4:2",
    );
    expect(connectionCredentialAad("def-456", 1, 3)).toBe(
      "loxep:connection_credential:def-456:1:3",
    );
  });
});

describe("createSecretCipher", () => {
  const keyring = testKeyring(1, [1]);
  const cipher = createSecretCipher(keyring);
  const aad = applicationSecretAad("11111111-1111-1111-1111-111111111111", 1, 1);
  const plaintext = Buffer.from(JSON.stringify({ token: MARKER }), "utf8");

  it("roundtrips with the active key version, a 12-byte nonce, 16-byte tag", () => {
    const record = cipher.encrypt(plaintext, aad);
    expect(record.keyVersion).toBe(1);
    expect(record.nonce.byteLength).toBe(12);
    expect(record.authTag.byteLength).toBe(16);
    expect(record.ciphertext.equals(plaintext)).toBe(false);
    const decrypted = cipher.decrypt(record, aad);
    expect(Buffer.from(decrypted).equals(plaintext)).toBe(true);
  });

  it("fails with a clear error on wrong AAD", () => {
    const record = cipher.encrypt(plaintext, aad);
    const wrongAad = applicationSecretAad(
      "22222222-2222-2222-2222-222222222222",
      1,
      1,
    );
    const error = expectCipherError(() => cipher.decrypt(record, wrongAad));
    expect(error.message).toContain("did not authenticate");
  });

  it("fails on the same AAD with a different version component", () => {
    const record = cipher.encrypt(plaintext, aad);
    const bumpedVersionAad = applicationSecretAad(
      "11111111-1111-1111-1111-111111111111",
      2,
      1,
    );
    expectCipherError(() => cipher.decrypt(record, bumpedVersionAad));
  });

  it("fails with a clear error on an unknown key version", () => {
    const record = cipher.encrypt(plaintext, aad);
    const error = expectCipherError(() =>
      cipher.decrypt({ ...record, keyVersion: 99 }, aad),
    );
    expect(error.message).toContain("unknown key version 99");
  });

  it("fails on tampered ciphertext", () => {
    const record = cipher.encrypt(plaintext, aad);
    const tampered = Buffer.from(record.ciphertext);
    const first = tampered[0] ?? 0;
    tampered[0] = first ^ 0xff;
    expectCipherError(() =>
      cipher.decrypt({ ...record, ciphertext: tampered }, aad),
    );
  });

  it("fails on a tampered auth tag", () => {
    const record = cipher.encrypt(plaintext, aad);
    const tampered = Buffer.from(record.authTag);
    const first = tampered[0] ?? 0;
    tampered[0] = first ^ 0xff;
    expectCipherError(() =>
      cipher.decrypt({ ...record, authTag: tampered }, aad),
    );
  });

  it("fails when decrypting with a keyring whose key bytes differ", () => {
    const record = cipher.encrypt(plaintext, aad);
    // Same version number, different key material.
    const otherCipher = createSecretCipher(testKeyring(1, [1]));
    // Sanity: identical deterministic keyrings DO decrypt.
    expect(
      Buffer.from(otherCipher.decrypt(record, aad)).equals(plaintext),
    ).toBe(true);
    const mismatched = createSecretCipher({
      activeVersion: 1,
      keys: new Map([[1, new Uint8Array(32).fill(7)]]),
    });
    expectCipherError(() => mismatched.decrypt(record, aad));
  });
});

describe("keyring rotation", () => {
  it("encrypts with the new active version while old ciphertext stays decryptable", () => {
    const v1Keyring = testKeyring(1, [1]);
    const v1Cipher = createSecretCipher(v1Keyring);
    const aad = applicationSecretAad("rot-1", 1, 1);
    const plaintext = Buffer.from(MARKER, "utf8");
    const oldRecord = v1Cipher.encrypt(plaintext, aad);
    expect(oldRecord.keyVersion).toBe(1);

    const rotatedKeyring = testKeyring(2, [1, 2]);
    const rotatedCipher = createSecretCipher(rotatedKeyring);
    const newRecord = rotatedCipher.encrypt(
      plaintext,
      applicationSecretAad("rot-1", 2, 2),
    );
    expect(newRecord.keyVersion).toBe(2);

    // v1 ciphertext still decrypts through the rotated keyring.
    const decrypted = rotatedCipher.decrypt(oldRecord, aad);
    expect(Buffer.from(decrypted).equals(plaintext)).toBe(true);

    // A keyring that dropped v1 can no longer decrypt it, with a clear error.
    const droppedV1 = createSecretCipher(testKeyring(2, [2]));
    expectCipherError(() => droppedV1.decrypt(oldRecord, aad));
  });
});
