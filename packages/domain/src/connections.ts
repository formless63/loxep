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
 * Removing a connection has TWO outcomes, decided by the data (loxep-o7h):
 *
 * - `deleteConnection` hard-deletes a connection that nothing references,
 *   together with its encrypted credential rows (secret hygiene — a deleted
 *   account must not leave ciphertext behind);
 * - `archiveConnection` is the answer whenever anything does reference it.
 *   Archiving never deletes imported history; it parks the connection in a
 *   terminal state that pickers and polling skip.
 *
 * A delete is never silently downgraded to an archive: `deleteConnection`
 * refuses with {@link ConnectionInUseError}, carrying the per-table counts,
 * so the operator makes that call knowingly.
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
  ConnectionInUseError,
  ConnectionNotFoundError,
  DomainValidationError,
  EntityInactiveError,
  EntityNotFoundError,
} from "./errors.ts";
import type { ConnectionReferenceCount } from "./errors.ts";
import { uuidLiteral } from "./sql.ts";

/**
 * Application-owned connection status union (text column, no PG enum).
 * `error` marks a connection whose most recent operation failed; `disabled`
 * is the deliberate off switch and is never changed by success/failure
 * recording; `archived` is the terminal state a connection reaches when it is
 * retired but its data must survive (see {@link ConnectionsService.archiveConnection}).
 */
export const CONNECTION_STATUSES = [
  "active",
  "disabled",
  "error",
  "archived",
] as const;

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/**
 * Whether a connection may be used for work — pickers, polling, token
 * refresh. `archived` is terminal and always excluded; `disabled` and `error`
 * keep the meanings they already had elsewhere in the codebase, so callers
 * that intentionally still act on those states are unaffected.
 */
export function isConnectionArchived(status: string): boolean {
  return status === "archived";
}

/**
 * Every table that carries a `connection_id`, enumerated from the schema
 * rather than guessed, in the order an operator most wants to hear about.
 *
 * `marketplace_item_observations` has no foreign key (it is a hypertable and
 * the column is provenance resolved in the application), so it would NOT stop
 * a delete at the database level — which is exactly why it is counted here.
 */
export const CONNECTION_REFERENCE_TABLES = [
  { table: "orders", label: "orders" },
  { table: "channel_listings", label: "channel listings" },
  { table: "monitor_targets", label: "monitors" },
  { table: "marketplace_item_observations", label: "observations" },
  { table: "source_events", label: "source events" },
  { table: "provider_objects", label: "provider snapshots" },
  { table: "external_resources", label: "external resources" },
  { table: "acquisitions", label: "acquisitions" },
] as const satisfies readonly { table: string; label: string }[];

/** Reference counts for one connection, including the zero rows. */
export interface ConnectionReferences {
  /** One entry per table in {@link CONNECTION_REFERENCE_TABLES}. */
  counts: ConnectionReferenceCount[];
  /** Only the non-zero entries. */
  blocking: ConnectionReferenceCount[];
  total: number;
}

/** Outcome of a hard delete. */
export interface ConnectionDeleteResult {
  id: string;
  /** Logical credential rows removed with the connection (ADR-0019). */
  deletedCredentials: number;
  /** Encrypted credential VERSION rows removed with them. */
  deletedCredentialVersions: number;
}

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
  /** Explicit status transition (the operator's on/off switch). */
  setConnectionStatus: (
    id: string,
    status: ConnectionStatus,
    options?: ConnectionMutationOptions,
  ) => Promise<Connection>;
  /**
   * Per-table counts of everything that still references the connection.
   * Read-only: the UI uses it to decide whether to offer delete or archive
   * before the operator commits to either.
   */
  countConnectionReferences: (id: string) => Promise<ConnectionReferences>;
  /**
   * HARD delete, allowed only when nothing references the connection.
   *
   * Removes the connection row plus its `connection_credentials` and
   * `connection_credential_versions` (explicitly — those foreign keys are
   * `no action`, and leaving ciphertext behind for a deleted account would be
   * a secret-hygiene failure).
   *
   * Throws {@link ConnectionInUseError} carrying the per-table counts when
   * anything at all references it; archive instead.
   */
  deleteConnection: (
    id: string,
    options?: ConnectionMutationOptions,
  ) => Promise<ConnectionDeleteResult>;
  /**
   * Terminal retirement: status `archived`. Nothing is deleted, so orders,
   * observations, and provenance keep resolving; the connection disappears
   * from pickers and is skipped by polling and token refresh. Reversible
   * through {@link ConnectionsService.unarchiveConnection}.
   */
  archiveConnection: (
    id: string,
    options?: ConnectionMutationOptions,
  ) => Promise<Connection>;
  /**
   * Restores an archived connection to `disabled`, never straight to
   * `active`: re-enabling provider traffic stays a separate, deliberate
   * operator action.
   */
  unarchiveConnection: (
    id: string,
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

  /**
   * One round trip for every referencing table: a `union all` of counts, so
   * the answer is a single consistent snapshot rather than eight reads that
   * could disagree with each other.
   */
  async function readReferences(
    executor: Pick<LoxepDb, "execute">,
    id: string,
  ): Promise<ConnectionReferences> {
    const literal = uuidLiteral(id);
    const statement = CONNECTION_REFERENCE_TABLES.map(
      (entry) =>
        `select '${entry.table}' as source, count(*) as total ` +
        `from ${entry.table} where connection_id = ${literal}`,
    ).join(" union all ");
    const result = await executor.execute(statement);
    const totals = new Map<string, number>();
    for (const row of result.rows) {
      totals.set(String(row["source"]), Number(row["total"] ?? 0));
    }
    const counts = CONNECTION_REFERENCE_TABLES.map((entry) => ({
      table: entry.table,
      label: entry.label,
      count: totals.get(entry.table) ?? 0,
    }));
    const blocking = counts.filter((entry) => entry.count > 0);
    return {
      counts,
      blocking,
      total: blocking.reduce((sum, entry) => sum + entry.count, 0),
    };
  }

  async function countConnectionReferences(
    id: string,
  ): Promise<ConnectionReferences> {
    await requireConnection(db, id);
    return readReferences(db, id);
  }

  async function deleteConnection(
    id: string,
    mutationOptions?: ConnectionMutationOptions,
  ): Promise<ConnectionDeleteResult> {
    const literal = uuidLiteral(id);
    return db.transaction(async (tx) => {
      const existing = await requireConnection(tx, id);
      const references = await readReferences(tx, id);
      if (references.total > 0) {
        throw new ConnectionInUseError(
          `connection ${id} still has ${references.total} referencing ` +
            `record(s) (${references.blocking
              .map((entry) => `${entry.label}: ${entry.count}`)
              .join(", ")}) and cannot be deleted; archive it instead`,
          references.blocking,
        );
      }

      // Secret hygiene: versions first (they reference the logical row), then
      // the logical credentials, then the connection itself. These foreign
      // keys are `no action`, so nothing cascades on its own.
      const versions = await tx.execute(
        `delete from connection_credential_versions
          where credential_id in (
            select id from connection_credentials
             where connection_id = ${literal}
          )`,
      );
      const credentials = await tx.execute(
        `delete from connection_credentials where connection_id = ${literal}`,
      );
      await tx.execute(`delete from connections where id = ${literal}`);

      const audit = createAuditService({ db: tx });
      await audit.append({
        actorUserId: mutationOptions?.actorUserId ?? null,
        action: "connection.delete",
        resourceType: "connection",
        resourceId: id,
        before: connectionSnapshot(existing),
        after: null,
        requestId: mutationOptions?.requestId ?? null,
        metadata: {
          provider: existing.provider,
          name: existing.name,
          deletedCredentials: credentials.rowCount ?? 0,
          deletedCredentialVersions: versions.rowCount ?? 0,
        },
      });
      return {
        id,
        deletedCredentials: credentials.rowCount ?? 0,
        deletedCredentialVersions: versions.rowCount ?? 0,
      };
    });
  }

  async function archiveConnection(
    id: string,
    mutationOptions?: ConnectionMutationOptions,
  ): Promise<Connection> {
    return applyUpdate(
      id,
      "connection.archive",
      { status: "archived" satisfies ConnectionStatus },
      mutationOptions,
      { status: "archived" },
    );
  }

  async function unarchiveConnection(
    id: string,
    mutationOptions?: ConnectionMutationOptions,
  ): Promise<Connection> {
    const existing = await requireConnection(db, id);
    if (!isConnectionArchived(existing.status)) {
      throw new DomainValidationError(
        `connection ${id} is "${existing.status}", not archived`,
      );
    }
    // Deliberately `disabled`, not `active`: un-archiving restores the record,
    // re-enabling provider traffic stays a separate operator decision.
    return applyUpdate(
      id,
      "connection.unarchive",
      { status: "disabled" satisfies ConnectionStatus },
      mutationOptions,
      { status: "disabled" },
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
    countConnectionReferences,
    deleteConnection,
    archiveConnection,
    unarchiveConnection,
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
