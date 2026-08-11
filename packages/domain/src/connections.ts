/**
 * Connection management service over `connections` (foundation-schema
 * "Connection foundation", ADR-0017, ADR-0019).
 *
 * A connection is one configured relationship to an external
 * account/store/service. Connections are created and managed through
 * authenticated Loxep workflows — never Compose environment entries.
 * `created_by_user_id` is audit/provenance metadata, not ownership: Phase 0
 * has no per-connection ACLs and this service never filters by user.
 *
 * Deleting a connection is intentionally out of scope (credential
 * revocation/deletion must not delete imported historical data) — disable
 * it instead via `setConnectionStatus(id, "disabled")`.
 *
 * Credential material never touches this table: credential workflows
 * delegate to the connection-credentials service (ADR-0019 encrypted
 * versioned bundles) after verifying the connection exists.
 *
 * Queries go through the Drizzle relational query API and primary-key
 * upserts so `@loxep/domain` needs no direct `drizzle-orm` dependency.
 */
import { connections } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import type { Keyring } from "@loxep/config";
import { z } from "zod";
import { createAuditService } from "./audit.ts";
import { createConnectionCredentialsService } from "./connection-credentials.ts";
import type {
  ConnectionCredentialsService,
  CredentialMetadata,
  CredentialWriteResult,
} from "./connection-credentials.ts";
import type { SecretBundle, SecretPurpose } from "./bundles.ts";
import {
  ConnectionNotFoundError,
  DomainValidationError,
  EntityInactiveError,
  EntityNotFoundError,
} from "./errors.ts";

/**
 * Application-owned connection status union (text column, no PG enum).
 * `error` marks a connection whose most recent operation failed; `disabled`
 * is the deliberate off switch and is never changed by success/failure
 * recording.
 */
export const CONNECTION_STATUSES = ["active", "disabled", "error"] as const;

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

const statusSchema = z.enum(CONNECTION_STATUSES);

/**
 * Generic non-secret config shape: any JSON object. Per-provider schemas
 * plug in through `configSchemas` on service creation and replace this
 * fallback for their provider.
 */
const genericConfigSchema: z.ZodType<Record<string, unknown>> = z.record(
  z.string(),
  z.unknown(),
);

const createConnectionSchema = z.strictObject({
  provider: z.string().trim().min(1),
  kind: z.string().trim().min(1),
  name: z.string().trim().min(1),
  status: statusSchema.default("active"),
  config: z.record(z.string(), z.unknown()).default({}),
  externalAccountId: z.string().trim().min(1).nullish(),
  externalAccountName: z.string().trim().min(1).nullish(),
  createdByUserId: z.string().min(1),
});

const updateConnectionSchema = z.strictObject({
  name: z.string().trim().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  externalAccountId: z.string().trim().min(1).nullable().optional(),
  externalAccountName: z.string().trim().min(1).nullable().optional(),
});

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

export interface Connection {
  id: string;
  provider: string;
  kind: string;
  name: string;
  status: ConnectionStatus;
  economicEntityId: string | null;
  externalAccountId: string | null;
  externalAccountName: string | null;
  config: Record<string, unknown>;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorCode: string | null;
}

export interface ConnectionMutationOptions {
  actorUserId?: string | null;
  requestId?: string | null;
}

export interface ConnectionsService {
  createConnection: (
    input: {
      provider: string;
      kind: string;
      name: string;
      status?: ConnectionStatus;
      config?: Record<string, unknown>;
      externalAccountId?: string | null;
      externalAccountName?: string | null;
      /** Provenance only (ADR-0017): who created it, never an ownership/ACL rule. */
      createdByUserId: string;
    },
    options?: ConnectionMutationOptions,
  ) => Promise<Connection>;
  updateConnection: (
    id: string,
    patch: {
      name?: string;
      config?: Record<string, unknown>;
      externalAccountId?: string | null;
      externalAccountName?: string | null;
    },
    options?: ConnectionMutationOptions,
  ) => Promise<Connection>;
  getConnection: (id: string) => Promise<Connection>;
  listConnections: (filter?: {
    provider?: string;
    kind?: string;
    status?: ConnectionStatus;
  }) => Promise<Connection[]>;
  /** Explicit status transition; use `"disabled"` instead of deletion. */
  setConnectionStatus: (
    id: string,
    status: ConnectionStatus,
    options?: ConnectionMutationOptions,
  ) => Promise<Connection>;
  /**
   * Marks a successful provider operation: sets `last_success_at` and moves
   * `error` back to `active`. A `disabled` connection stays disabled.
   * Last-error fields keep their historical values.
   */
  recordConnectionSuccess: (
    id: string,
    options?: { at?: Date } & ConnectionMutationOptions,
  ) => Promise<Connection>;
  /**
   * Marks a failed provider operation: sets `last_error_at` and
   * `last_error_code` and moves `active` to `error`. A `disabled`
   * connection stays disabled.
   */
  recordConnectionFailure: (
    id: string,
    input: { errorCode: string; at?: Date },
    options?: ConnectionMutationOptions,
  ) => Promise<Connection>;
  /**
   * Stores/rotates an encrypted credential bundle for the connection after
   * verifying the connection exists; delegates to the ADR-0019
   * connection-credentials service.
   */
  setConnectionCredential: <P extends SecretPurpose>(
    connectionId: string,
    credentialType: P,
    payload: SecretBundle<P>,
    options?: {
      expiresAt?: Date | null;
      refreshAfter?: Date | null;
    } & ConnectionMutationOptions,
  ) => Promise<CredentialWriteResult>;
  /** Decrypts and returns the current typed credential bundle (delegate). */
  getConnectionCredentialPayload: ConnectionCredentialsService["getCredentialPayload"];
  /** Metadata-only credential listing for the connection (delegate). */
  listConnectionCredentials: (
    connectionId: string,
  ) => Promise<CredentialMetadata[]>;
  /**
   * Sets or clears `connections.economic_entity_id` (ADR-0017).
   *
   * Attribution is business CONTEXT, NOT AUTHORIZATION: it records which
   * economic entity an external account belongs to or primarily represents,
   * and grants or restricts nothing. Passing `null` clears the attribution
   * (shared/infrastructural/unknown ownership). A non-null entity must
   * exist and be active.
   */
  attributeConnection: (
    connectionId: string,
    economicEntityId: string | null,
    options?: ConnectionMutationOptions,
  ) => Promise<Connection>;
  /** Connections attributed to one economic entity. */
  listConnectionsByEntity: (economicEntityId: string) => Promise<Connection[]>;
  /** Connections with no economic-entity attribution. */
  listUnattributedConnections: () => Promise<Connection[]>;
}

type ConnectionRow = typeof connections.$inferSelect;

function toConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    name: row.name,
    status: row.status as ConnectionStatus,
    economicEntityId: row.economicEntityId,
    externalAccountId: row.externalAccountId,
    externalAccountName: row.externalAccountName,
    config: row.config as Record<string, unknown>,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastSuccessAt: row.lastSuccessAt,
    lastErrorAt: row.lastErrorAt,
    lastErrorCode: row.lastErrorCode,
  };
}

function connectionSnapshot(row: ConnectionRow): Record<string, unknown> {
  return {
    provider: row.provider,
    kind: row.kind,
    name: row.name,
    status: row.status,
    economicEntityId: row.economicEntityId,
    externalAccountId: row.externalAccountId,
    externalAccountName: row.externalAccountName,
    config: row.config,
  };
}

export function createConnectionsService(options: {
  db: LoxepDb;
  keyring: Keyring;
  /**
   * Optional per-provider non-secret config schemas keyed by provider name;
   * providers without an entry fall back to the generic JSON-object schema.
   */
  configSchemas?: Record<string, z.ZodType<Record<string, unknown>>>;
}): ConnectionsService {
  const { db, keyring } = options;
  const configSchemas = options.configSchemas ?? {};
  const credentials = createConnectionCredentialsService({ db, keyring });

  function validateConfig(
    provider: string,
    config: Record<string, unknown>,
  ): Record<string, unknown> {
    const schema = configSchemas[provider] ?? genericConfigSchema;
    const result = schema.safeParse(config);
    if (!result.success) {
      throw new DomainValidationError(
        `invalid config for provider "${provider}": ${formatIssues(result.error)}`,
      );
    }
    return result.data;
  }

  async function requireConnection(
    executor: Pick<LoxepDb, "query">,
    id: string,
  ): Promise<ConnectionRow> {
    const row = await executor.query.connections.findFirst({
      where: (table, { eq }) => eq(table.id, id),
    });
    if (row === undefined) {
      throw new ConnectionNotFoundError(`connection ${id} does not exist`);
    }
    return row;
  }

  /** Shared column-update path: PK upsert + audit inside one transaction. */
  async function applyUpdate(
    id: string,
    action: string,
    set: Record<string, unknown>,
    mutationOptions?: ConnectionMutationOptions,
    extraMetadata?: Record<string, unknown>,
  ): Promise<Connection> {
    return db.transaction(async (tx) => {
      const existing = await requireConnection(tx, id);
      const updated = await tx
        .insert(connections)
        .values({
          id,
          provider: existing.provider,
          kind: existing.kind,
          name: existing.name,
          status: existing.status,
        })
        .onConflictDoUpdate({
          target: connections.id,
          set: { ...set, updatedAt: new Date() },
        })
        .returning();
      const row = updated[0];
      if (row === undefined) {
        throw new Error("connection update returned no row");
      }

      const audit = createAuditService({ db: tx });
      await audit.append({
        actorUserId: mutationOptions?.actorUserId ?? null,
        action,
        resourceType: "connection",
        resourceId: id,
        before: connectionSnapshot(existing),
        after: connectionSnapshot(row),
        requestId: mutationOptions?.requestId ?? null,
        metadata: {
          provider: row.provider,
          name: row.name,
          ...extraMetadata,
        },
      });
      return toConnection(row);
    });
  }

  async function createConnection(
    input: {
      provider: string;
      kind: string;
      name: string;
      status?: ConnectionStatus;
      config?: Record<string, unknown>;
      externalAccountId?: string | null;
      externalAccountName?: string | null;
      createdByUserId: string;
    },
    mutationOptions?: ConnectionMutationOptions,
  ): Promise<Connection> {
    const result = createConnectionSchema.safeParse(input);
    if (!result.success) {
      throw new DomainValidationError(
        `invalid connection: ${formatIssues(result.error)}`,
      );
    }
    const parsed = result.data;
    const config = validateConfig(parsed.provider, parsed.config);
    const actorUserId =
      mutationOptions?.actorUserId ?? parsed.createdByUserId;

    return db.transaction(async (tx) => {
      const inserted = await tx
        .insert(connections)
        .values({
          provider: parsed.provider,
          kind: parsed.kind,
          name: parsed.name,
          status: parsed.status,
          config,
          externalAccountId: parsed.externalAccountId ?? null,
          externalAccountName: parsed.externalAccountName ?? null,
          createdByUserId: parsed.createdByUserId,
        })
        .returning();
      const row = inserted[0];
      if (row === undefined) {
        throw new Error("connection insert returned no row");
      }

      const audit = createAuditService({ db: tx });
      await audit.append({
        actorUserId,
        action: "connection.create",
        resourceType: "connection",
        resourceId: row.id,
        before: null,
        after: connectionSnapshot(row),
        requestId: mutationOptions?.requestId ?? null,
        metadata: { provider: row.provider, name: row.name },
      });
      return toConnection(row);
    });
  }

  async function updateConnection(
    id: string,
    patch: {
      name?: string;
      config?: Record<string, unknown>;
      externalAccountId?: string | null;
      externalAccountName?: string | null;
    },
    mutationOptions?: ConnectionMutationOptions,
  ): Promise<Connection> {
    const result = updateConnectionSchema.safeParse(patch);
    if (!result.success) {
      throw new DomainValidationError(
        `invalid connection patch: ${formatIssues(result.error)}`,
      );
    }
    const parsed = result.data;
    const set: Record<string, unknown> = {};
    if (parsed.name !== undefined) set.name = parsed.name;
    if (parsed.externalAccountId !== undefined) {
      set.externalAccountId = parsed.externalAccountId;
    }
    if (parsed.externalAccountName !== undefined) {
      set.externalAccountName = parsed.externalAccountName;
    }
    if (parsed.config !== undefined) {
      // Provider is immutable, so validate against the stored provider.
      const existing = await requireConnection(db, id);
      set.config = validateConfig(existing.provider, parsed.config);
    }
    return applyUpdate(id, "connection.update", set, mutationOptions);
  }

  async function getConnection(id: string): Promise<Connection> {
    const row = await requireConnection(db, id);
    return toConnection(row);
  }

  async function listConnections(filter?: {
    provider?: string;
    kind?: string;
    status?: ConnectionStatus;
  }): Promise<Connection[]> {
    const rows = await db.query.connections.findMany({
      where: (table, { and, eq }) => {
        const clauses = [];
        if (filter?.provider !== undefined) {
          clauses.push(eq(table.provider, filter.provider));
        }
        if (filter?.kind !== undefined) clauses.push(eq(table.kind, filter.kind));
        if (filter?.status !== undefined) {
          clauses.push(eq(table.status, filter.status));
        }
        return clauses.length === 0 ? undefined : and(...clauses);
      },
      orderBy: (table, { asc }) => [asc(table.name), asc(table.id)],
    });
    return rows.map(toConnection);
  }

  async function setConnectionStatus(
    id: string,
    status: ConnectionStatus,
    mutationOptions?: ConnectionMutationOptions,
  ): Promise<Connection> {
    const result = statusSchema.safeParse(status);
    if (!result.success) {
      throw new DomainValidationError(
        `invalid connection status "${String(status)}" (expected: ${CONNECTION_STATUSES.join(", ")})`,
      );
    }
    return applyUpdate(
      id,
      "connection.set_status",
      { status: result.data },
      mutationOptions,
      { status: result.data },
    );
  }

  async function recordConnectionSuccess(
    id: string,
    successOptions?: { at?: Date } & ConnectionMutationOptions,
  ): Promise<Connection> {
    const at = successOptions?.at ?? new Date();
    return db.transaction(async (tx) => {
      const existing = await requireConnection(tx, id);
      const nextStatus: ConnectionStatus =
        existing.status === "error"
          ? "active"
          : (existing.status as ConnectionStatus);
      const updated = await tx
        .insert(connections)
        .values({
          id,
          provider: existing.provider,
          kind: existing.kind,
          name: existing.name,
          status: existing.status,
        })
        .onConflictDoUpdate({
          target: connections.id,
          set: { lastSuccessAt: at, status: nextStatus, updatedAt: new Date() },
        })
        .returning();
      const row = updated[0];
      if (row === undefined) {
        throw new Error("connection success update returned no row");
      }

      const audit = createAuditService({ db: tx });
      await audit.append({
        actorUserId: successOptions?.actorUserId ?? null,
        action: "connection.record_success",
        resourceType: "connection",
        resourceId: id,
        before: {
          status: existing.status,
          lastSuccessAt: existing.lastSuccessAt?.toISOString() ?? null,
        },
        after: {
          status: row.status,
          lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
        },
        requestId: successOptions?.requestId ?? null,
        metadata: { provider: row.provider, name: row.name },
      });
      return toConnection(row);
    });
  }

  async function recordConnectionFailure(
    id: string,
    input: { errorCode: string; at?: Date },
    failureOptions?: ConnectionMutationOptions,
  ): Promise<Connection> {
    const at = input.at ?? new Date();
    return db.transaction(async (tx) => {
      const existing = await requireConnection(tx, id);
      const nextStatus: ConnectionStatus =
        existing.status === "active"
          ? "error"
          : (existing.status as ConnectionStatus);
      const updated = await tx
        .insert(connections)
        .values({
          id,
          provider: existing.provider,
          kind: existing.kind,
          name: existing.name,
          status: existing.status,
        })
        .onConflictDoUpdate({
          target: connections.id,
          set: {
            lastErrorAt: at,
            lastErrorCode: input.errorCode,
            status: nextStatus,
            updatedAt: new Date(),
          },
        })
        .returning();
      const row = updated[0];
      if (row === undefined) {
        throw new Error("connection failure update returned no row");
      }

      const audit = createAuditService({ db: tx });
      await audit.append({
        actorUserId: failureOptions?.actorUserId ?? null,
        action: "connection.record_failure",
        resourceType: "connection",
        resourceId: id,
        before: { status: existing.status, lastErrorCode: existing.lastErrorCode },
        after: { status: row.status, lastErrorCode: row.lastErrorCode },
        requestId: failureOptions?.requestId ?? null,
        metadata: {
          provider: row.provider,
          name: row.name,
          errorCode: input.errorCode,
        },
      });
      return toConnection(row);
    });
  }

  async function setConnectionCredential<P extends SecretPurpose>(
    connectionId: string,
    credentialType: P,
    payload: SecretBundle<P>,
    credentialOptions?: {
      expiresAt?: Date | null;
      refreshAfter?: Date | null;
    } & ConnectionMutationOptions,
  ): Promise<CredentialWriteResult> {
    // Verify the connection exists BEFORE any credential persistence.
    await requireConnection(db, connectionId);
    return credentials.setCredential({
      connectionId,
      credentialType,
      payload,
      expiresAt: credentialOptions?.expiresAt ?? null,
      refreshAfter: credentialOptions?.refreshAfter ?? null,
      actorUserId: credentialOptions?.actorUserId ?? null,
      requestId: credentialOptions?.requestId ?? null,
    });
  }

  async function attributeConnection(
    connectionId: string,
    economicEntityId: string | null,
    mutationOptions?: ConnectionMutationOptions,
  ): Promise<Connection> {
    // ADR-0017: attribution is context, not authorization — validate the
    // entity as a referenced record, never as a permission check.
    if (economicEntityId !== null) {
      const entity = await db.query.economicEntities.findFirst({
        where: (table, { eq }) => eq(table.id, economicEntityId),
        columns: { id: true, active: true },
      });
      if (entity === undefined) {
        throw new EntityNotFoundError(
          `economic entity ${economicEntityId} does not exist`,
        );
      }
      if (!entity.active) {
        throw new EntityInactiveError(
          `economic entity ${economicEntityId} is deactivated and cannot receive new attributions`,
        );
      }
    }
    return applyUpdate(
      connectionId,
      "connection.attribute",
      { economicEntityId },
      mutationOptions,
      { economicEntityId },
    );
  }

  async function listConnectionsByEntity(
    economicEntityId: string,
  ): Promise<Connection[]> {
    const rows = await db.query.connections.findMany({
      where: (table, { eq }) => eq(table.economicEntityId, economicEntityId),
      orderBy: (table, { asc }) => [asc(table.name), asc(table.id)],
    });
    return rows.map(toConnection);
  }

  async function listUnattributedConnections(): Promise<Connection[]> {
    const rows = await db.query.connections.findMany({
      where: (table, { isNull }) => isNull(table.economicEntityId),
      orderBy: (table, { asc }) => [asc(table.name), asc(table.id)],
    });
    return rows.map(toConnection);
  }

  return {
    createConnection,
    updateConnection,
    getConnection,
    listConnections,
    setConnectionStatus,
    recordConnectionSuccess,
    recordConnectionFailure,
    setConnectionCredential,
    getConnectionCredentialPayload: credentials.getCredentialPayload,
    listConnectionCredentials: (connectionId: string) =>
      credentials.listCredentials(connectionId),
    attributeConnection,
    listConnectionsByEntity,
    listUnattributedConnections,
  };
}
