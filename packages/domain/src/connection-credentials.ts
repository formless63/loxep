/**
 * Connection credentials service over `connection_credentials` +
 * `connection_credential_versions` (ADR-0019).
 *
 * Same logical-record/immutable-version/current-pointer model as application
 * secrets, keyed by (connection_id, credential_type). Expiry/refresh
 * metadata lives on the version row because it describes one issued token,
 * not the logical credential slot.
 *
 * Queries go through the Drizzle relational query API and primary-key
 * upserts so `@loxep/domain` needs no direct `drizzle-orm` dependency;
 * racing writers are serialized by the unique/primary-key constraints.
 */
import {
  connectionCredentialVersions,
  connectionCredentials,
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
import { connectionCredentialAad, createSecretCipher } from "./crypto.ts";
import {
  SecretNotFoundError,
  SecretsServiceError,
  UnknownPurposeError,
} from "./errors.ts";

export interface CredentialWriteResult {
  id: string;
  connectionId: string;
  credentialType: SecretPurpose;
  currentVersion: number;
  keyVersion: number;
}

/** Metadata only — NEVER payload or ciphertext material. */
export interface CredentialMetadata {
  id: string;
  connectionId: string;
  credentialType: string;
  currentVersion: number;
  keyVersion: number;
  expiresAt: Date | null;
  refreshAfter: Date | null;
  createdAt: Date;
  updatedAt: Date;
  currentVersionCreatedAt: Date;
}

export interface ConnectionCredentialsService {
  setCredential: <P extends SecretPurpose>(input: {
    connectionId: string;
    credentialType: P;
    payload: SecretBundle<P>;
    expiresAt?: Date | null;
    refreshAfter?: Date | null;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<CredentialWriteResult>;
  getCredentialPayload: {
    <P extends SecretPurpose>(
      connectionId: string,
      credentialType: P,
    ): Promise<{ purpose: P; payload: SecretBundle<P> }>;
    (connectionId: string, credentialType: string): Promise<SecretPayload>;
  };
  rotateCredential: (
    connectionId: string,
    credentialType: string,
    newPayload: unknown,
    options: {
      expiresAt?: Date | null;
      refreshAfter?: Date | null;
      actorUserId?: string | null;
      requestId?: string | null;
    },
  ) => Promise<CredentialWriteResult>;
  listCredentials: (connectionId?: string) => Promise<CredentialMetadata[]>;
}

export function createConnectionCredentialsService(options: {
  db: LoxepDb;
  keyring: Keyring;
}): ConnectionCredentialsService {
  const { db, keyring } = options;
  const cipher = createSecretCipher(keyring);

  async function setCredential<P extends SecretPurpose>(input: {
    connectionId: string;
    credentialType: P;
    payload: SecretBundle<P>;
    expiresAt?: Date | null;
    refreshAfter?: Date | null;
    actorUserId?: string | null;
    requestId?: string | null;
  }): Promise<CredentialWriteResult> {
    // Validate the typed bundle BEFORE any persistence or encryption.
    const payload = validateBundle(input.credentialType, input.payload);
    const actorUserId = input.actorUserId ?? null;

    return db.transaction(async (tx) => {
      const existing = await tx.query.connectionCredentials.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.connectionId, input.connectionId),
            eq(table.credentialType, input.credentialType),
          ),
      });
      const isNew = existing === undefined;

      let credentialId: string;
      if (existing === undefined) {
        const inserted = await tx
          .insert(connectionCredentials)
          .values({
            connectionId: input.connectionId,
            credentialType: input.credentialType,
            // Placeholder until the first version row exists below.
            currentVersion: 0,
          })
          .returning({ id: connectionCredentials.id });
        const row = inserted[0];
        if (row === undefined) {
          throw new SecretsServiceError(
            `failed to create logical credential ${input.credentialType} for connection ${input.connectionId}`,
          );
        }
        credentialId = row.id;
      } else {
        credentialId = existing.id;
      }

      const versionRows = await tx.query.connectionCredentialVersions.findMany(
        {
          where: (table, { eq }) => eq(table.credentialId, credentialId),
          columns: { version: true },
        },
      );
      const version =
        versionRows.reduce((max, row) => Math.max(max, row.version), 0) + 1;

      const aad = connectionCredentialAad(
        credentialId,
        version,
        keyring.activeVersion,
      );
      const encrypted = cipher.encrypt(
        Buffer.from(JSON.stringify(payload), "utf8"),
        aad,
      );

      await tx.insert(connectionCredentialVersions).values({
        credentialId,
        version,
        keyVersion: encrypted.keyVersion,
        nonce: encrypted.nonce,
        authTag: encrypted.authTag,
        ciphertext: encrypted.ciphertext,
        expiresAt: input.expiresAt ?? null,
        refreshAfter: input.refreshAfter ?? null,
      });
      // Pointer move via primary-key upsert (row is known to exist).
      await tx
        .insert(connectionCredentials)
        .values({
          id: credentialId,
          connectionId: input.connectionId,
          credentialType: input.credentialType,
          currentVersion: version,
        })
        .onConflictDoUpdate({
          target: connectionCredentials.id,
          set: { currentVersion: version, updatedAt: new Date() },
        });

      // Metadata-only audit snapshot — never payload material.
      const audit = createAuditService({ db: tx });
      await audit.append({
        actorUserId,
        action: isNew
          ? "connection_credential.create"
          : "connection_credential.rotate",
        resourceType: "connection_credential",
        resourceId: credentialId,
        before: isNew ? null : { currentVersion: existing.currentVersion },
        after: {
          currentVersion: version,
          keyVersion: encrypted.keyVersion,
          expiresAt: input.expiresAt?.toISOString() ?? null,
          refreshAfter: input.refreshAfter?.toISOString() ?? null,
        },
        requestId: input.requestId ?? null,
        metadata: {
          connectionId: input.connectionId,
          credentialType: input.credentialType,
          version,
        },
      });

      return {
        id: credentialId,
        connectionId: input.connectionId,
        credentialType: input.credentialType,
        currentVersion: version,
        keyVersion: encrypted.keyVersion,
      };
    });
  }

  async function getCredentialPayload(
    connectionId: string,
    credentialType: string,
  ): Promise<SecretPayload> {
    const credential = await db.query.connectionCredentials.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.connectionId, connectionId),
          eq(table.credentialType, credentialType),
        ),
    });
    if (credential === undefined) {
      throw new SecretNotFoundError(
        `unknown credential ${credentialType} for connection ${connectionId}`,
      );
    }
    if (!isSecretPurpose(credential.credentialType)) {
      throw new UnknownPurposeError(
        `credential type "${credential.credentialType}" is not registered (registered: ${secretPurposes.join(", ")})`,
      );
    }

    // CURRENT version only.
    const version = await db.query.connectionCredentialVersions.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.credentialId, credential.id),
          eq(table.version, credential.currentVersion),
        ),
    });
    if (version === undefined) {
      throw new SecretsServiceError(
        `credential ${credentialType} for connection ${connectionId} current version ${credential.currentVersion} has no version row`,
      );
    }

    const aad = connectionCredentialAad(
      credential.id,
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
        `decrypted payload for credential ${credentialType} on connection ${connectionId} is not valid JSON`,
      );
    }
    const payload = validateBundle(credential.credentialType, parsed);
    return { purpose: credential.credentialType, payload } as SecretPayload;
  }

  async function rotateCredential(
    connectionId: string,
    credentialType: string,
    newPayload: unknown,
    rotateOptions: {
      expiresAt?: Date | null;
      refreshAfter?: Date | null;
      actorUserId?: string | null;
      requestId?: string | null;
    },
  ): Promise<CredentialWriteResult> {
    if (!isSecretPurpose(credentialType)) {
      throw new UnknownPurposeError(
        `credential type "${credentialType}" is not registered (registered: ${secretPurposes.join(", ")})`,
      );
    }
    const existing = await db.query.connectionCredentials.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.connectionId, connectionId),
          eq(table.credentialType, credentialType),
        ),
      columns: { id: true },
    });
    if (existing === undefined) {
      throw new SecretNotFoundError(
        `cannot rotate unknown credential ${credentialType} for connection ${connectionId}`,
      );
    }
    return setCredential({
      connectionId,
      credentialType,
      payload: validateBundle(credentialType, newPayload),
      expiresAt: rotateOptions.expiresAt ?? null,
      refreshAfter: rotateOptions.refreshAfter ?? null,
      actorUserId: rotateOptions.actorUserId ?? null,
      requestId: rotateOptions.requestId ?? null,
    });
  }

  async function listCredentials(
    connectionId?: string,
  ): Promise<CredentialMetadata[]> {
    const credentials = await db.query.connectionCredentials.findMany({
      where:
        connectionId === undefined
          ? undefined
          : (table, { eq }) => eq(table.connectionId, connectionId),
      orderBy: (table, { asc }) => [
        asc(table.connectionId),
        asc(table.credentialType),
      ],
    });
    return Promise.all(
      credentials.map(async (credential) => {
        const version = await db.query.connectionCredentialVersions.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.credentialId, credential.id),
              eq(table.version, credential.currentVersion),
            ),
          columns: { keyVersion: true, expiresAt: true, refreshAfter: true, createdAt: true },
        });
        if (version === undefined) {
          throw new SecretsServiceError(
            `credential ${credential.credentialType} for connection ${credential.connectionId} current version ${credential.currentVersion} has no version row`,
          );
        }
        return {
          id: credential.id,
          connectionId: credential.connectionId,
          credentialType: credential.credentialType,
          currentVersion: credential.currentVersion,
          keyVersion: version.keyVersion,
          expiresAt: version.expiresAt,
          refreshAfter: version.refreshAfter,
          createdAt: credential.createdAt,
          updatedAt: credential.updatedAt,
          currentVersionCreatedAt: version.createdAt,
        };
      }),
    );
  }

  return {
    setCredential,
    getCredentialPayload:
      getCredentialPayload as ConnectionCredentialsService["getCredentialPayload"],
    rotateCredential,
    listCredentials,
  };
}
