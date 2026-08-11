/**
 * Application secrets service over `application_secrets` +
 * `application_secret_versions` (ADR-0016, ADR-0019).
 *
 * The logical secret is the stable identity consumers reference; ciphertext
 * lives in immutable version rows with `current_version` as the explicit
 * active pointer. Reads decrypt the CURRENT version only. Plaintext never
 * appears in logs, errors, audit events, or list output.
 *
 * Queries go through the Drizzle relational query API and primary-key
 * upserts so `@loxep/domain` needs no direct `drizzle-orm` dependency.
 * Concurrent writers are serialized by the table constraints: a racing
 * first write violates `unique(secret_key)` and a racing rotation violates
 * `primary key(secret_id, version)` — the transaction rolls back instead of
 * silently double-writing.
 */
import {
  applicationSecretVersions,
  applicationSecrets,
} from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import type { Keyring } from "@loxep/config";
import { createAuditService } from "./audit.ts";
import {
  isSecretPurpose,
  secretPurposes,
  validateBundle,
} from "./bundles.ts";
import type { SecretBundle, SecretPayload, SecretPurpose } from "./bundles.ts";
import { applicationSecretAad, createSecretCipher } from "./crypto.ts";
import {
  SecretNotFoundError,
  SecretsServiceError,
  UnknownPurposeError,
} from "./errors.ts";

export interface SecretWriteResult {
  id: string;
  secretKey: string;
  purpose: SecretPurpose;
  currentVersion: number;
  keyVersion: number;
}

/** Metadata only — NEVER payload or ciphertext material. */
export interface SecretMetadata {
  id: string;
  secretKey: string;
  purpose: string;
  currentVersion: number;
  keyVersion: number;
  createdAt: Date;
  updatedAt: Date;
  currentVersionCreatedAt: Date;
}

export interface SecretsService {
  setSecret: <P extends SecretPurpose>(input: {
    secretKey: string;
    purpose: P;
    payload: SecretBundle<P>;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<SecretWriteResult>;
  getSecretPayload: {
    (secretKey: string): Promise<SecretPayload>;
    <P extends SecretPurpose>(
      secretKey: string,
      expectedPurpose: P,
    ): Promise<{ purpose: P; payload: SecretBundle<P> }>;
  };
  rotateSecret: (
    secretKey: string,
    newPayload: unknown,
    options: { actorUserId?: string | null; requestId?: string | null },
  ) => Promise<SecretWriteResult>;
  listSecrets: () => Promise<SecretMetadata[]>;
}

export function createSecretsService(options: {
  db: LoxepDb;
  keyring: Keyring;
}): SecretsService {
  const { db, keyring } = options;
  const cipher = createSecretCipher(keyring);

  async function setSecret<P extends SecretPurpose>(input: {
    secretKey: string;
    purpose: P;
    payload: SecretBundle<P>;
    actorUserId?: string | null;
    requestId?: string | null;
  }): Promise<SecretWriteResult> {
    // Validate the typed bundle BEFORE any persistence or encryption.
    const payload = validateBundle(input.purpose, input.payload);
    const actorUserId = input.actorUserId ?? null;

    return db.transaction(async (tx) => {
      const existing = await tx.query.applicationSecrets.findFirst({
        where: (table, { eq }) => eq(table.secretKey, input.secretKey),
      });
      const isNew = existing === undefined;

      if (existing !== undefined && existing.purpose !== input.purpose) {
        throw new SecretsServiceError(
          `secret "${input.secretKey}" already exists with purpose "${existing.purpose}"; refusing write with purpose "${input.purpose}"`,
        );
      }

      let secretId: string;
      if (existing === undefined) {
        const inserted = await tx
          .insert(applicationSecrets)
          .values({
            secretKey: input.secretKey,
            purpose: input.purpose,
            // Placeholder until the first version row exists below; the
            // pointer moves inside this same transaction.
            currentVersion: 0,
            createdByUserId: actorUserId,
          })
          .returning({ id: applicationSecrets.id });
        const row = inserted[0];
        if (row === undefined) {
          throw new SecretsServiceError(
            `failed to create logical secret "${input.secretKey}"`,
          );
        }
        secretId = row.id;
      } else {
        secretId = existing.id;
      }

      const versionRows = await tx.query.applicationSecretVersions.findMany({
        where: (table, { eq }) => eq(table.secretId, secretId),
        columns: { version: true },
      });
      const version =
        versionRows.reduce((max, row) => Math.max(max, row.version), 0) + 1;

      const aad = applicationSecretAad(
        secretId,
        version,
        keyring.activeVersion,
      );
      const encrypted = cipher.encrypt(
        Buffer.from(JSON.stringify(payload), "utf8"),
        aad,
      );

      await tx.insert(applicationSecretVersions).values({
        secretId,
        version,
        keyVersion: encrypted.keyVersion,
        nonce: encrypted.nonce,
        authTag: encrypted.authTag,
        ciphertext: encrypted.ciphertext,
      });
      // Pointer move via primary-key upsert (row is known to exist).
      await tx
        .insert(applicationSecrets)
        .values({
          id: secretId,
          secretKey: input.secretKey,
          purpose: input.purpose,
          currentVersion: version,
        })
        .onConflictDoUpdate({
          target: applicationSecrets.id,
          set: { currentVersion: version, updatedAt: new Date() },
        });

      // Metadata-only audit snapshot — never payload material (the audit
      // service's redaction is defense in depth, not the primary control).
      const audit = createAuditService({ db: tx });
      await audit.append({
        actorUserId,
        action: isNew ? "secret.create" : "secret.rotate",
        resourceType: "application_secret",
        resourceId: secretId,
        before: isNew ? null : { currentVersion: existing.currentVersion },
        after: {
          currentVersion: version,
          keyVersion: encrypted.keyVersion,
        },
        requestId: input.requestId ?? null,
        metadata: {
          secretKey: input.secretKey,
          purpose: input.purpose,
          version,
        },
      });

      return {
        id: secretId,
        secretKey: input.secretKey,
        purpose: input.purpose,
        currentVersion: version,
        keyVersion: encrypted.keyVersion,
      };
    });
  }

  async function getSecretPayload(
    secretKey: string,
    expectedPurpose?: SecretPurpose,
  ): Promise<SecretPayload> {
    const secret = await db.query.applicationSecrets.findFirst({
      where: (table, { eq }) => eq(table.secretKey, secretKey),
    });
    if (secret === undefined) {
      throw new SecretNotFoundError(
        `unknown application secret "${secretKey}"`,
      );
    }
    if (!isSecretPurpose(secret.purpose)) {
      throw new UnknownPurposeError(
        `secret "${secretKey}" has unregistered purpose "${secret.purpose}" (registered: ${secretPurposes.join(", ")})`,
      );
    }
    if (expectedPurpose !== undefined && secret.purpose !== expectedPurpose) {
      throw new SecretsServiceError(
        `secret "${secretKey}" has purpose "${secret.purpose}", expected "${expectedPurpose}"`,
      );
    }

    // CURRENT version only — historical versions stay readable for
    // controlled re-encryption jobs, never through this accessor.
    const version = await db.query.applicationSecretVersions.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.secretId, secret.id),
          eq(table.version, secret.currentVersion),
        ),
    });
    if (version === undefined) {
      throw new SecretsServiceError(
        `secret "${secretKey}" current version ${secret.currentVersion} has no version row`,
      );
    }

    const aad = applicationSecretAad(
      secret.id,
      version.version,
      version.keyVersion,
    );
    const plaintext = cipher.decrypt(
      {
        keyVersion: version.keyVersion,
        nonce: version.nonce,
        authTag: version.authTag,
        ciphertext: version.ciphertext,
      },
      aad,
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(plaintext).toString("utf8"));
    } catch {
      throw new SecretsServiceError(
        `decrypted payload for secret "${secretKey}" is not valid JSON`,
      );
    }
    const payload = validateBundle(secret.purpose, parsed);
    return { purpose: secret.purpose, payload } as SecretPayload;
  }

  async function rotateSecret(
    secretKey: string,
    newPayload: unknown,
    rotateOptions: { actorUserId?: string | null; requestId?: string | null },
  ): Promise<SecretWriteResult> {
    const existing = await db.query.applicationSecrets.findFirst({
      where: (table, { eq }) => eq(table.secretKey, secretKey),
      columns: { purpose: true },
    });
    if (existing === undefined) {
      throw new SecretNotFoundError(
        `cannot rotate unknown application secret "${secretKey}"`,
      );
    }
    if (!isSecretPurpose(existing.purpose)) {
      throw new UnknownPurposeError(
        `secret "${secretKey}" has unregistered purpose "${existing.purpose}"`,
      );
    }
    return setSecret({
      secretKey,
      purpose: existing.purpose,
      payload: validateBundle(existing.purpose, newPayload),
      actorUserId: rotateOptions.actorUserId ?? null,
      requestId: rotateOptions.requestId ?? null,
    });
  }

  async function listSecrets(): Promise<SecretMetadata[]> {
    const secrets = await db.query.applicationSecrets.findMany({
      orderBy: (table, { asc }) => [asc(table.secretKey)],
    });
    return Promise.all(
      secrets.map(async (secret) => {
        const version = await db.query.applicationSecretVersions.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.secretId, secret.id),
              eq(table.version, secret.currentVersion),
            ),
          columns: { keyVersion: true, createdAt: true },
        });
        if (version === undefined) {
          throw new SecretsServiceError(
            `secret "${secret.secretKey}" current version ${secret.currentVersion} has no version row`,
          );
        }
        return {
          id: secret.id,
          secretKey: secret.secretKey,
          purpose: secret.purpose,
          currentVersion: secret.currentVersion,
          keyVersion: version.keyVersion,
          createdAt: secret.createdAt,
          updatedAt: secret.updatedAt,
          currentVersionCreatedAt: version.createdAt,
        };
      }),
    );
  }

  return {
    setSecret,
    getSecretPayload: getSecretPayload as SecretsService["getSecretPayload"],
    rotateSecret,
    listSecrets,
  };
}
