/**
 * Server functions for the /settings workspace surfaces.
 *
 * Handlers use dynamic imports so `@/server/admin` (and the server packages
 * behind it) stay out of the client bundle; only type-only imports from
 * server packages are allowed at the top level here.
 *
 * Role gates (ADR-0017): reads of ordinary product data call
 * `requireSession` (any authenticated member); mutations and user listing
 * call `requireAdmin`. Secret/credential material is never returned — the
 * domain/storage services already enforce metadata-only output and these
 * functions keep it that way.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { EconomicEntityKind } from '@loxep/db/schema';
import type { ConnectionStatus } from '@loxep/domain';
import type { HealthReport } from '@loxep/runtime';
import type { MarketEventType } from '@loxep/market';
import {
  ECONOMIC_ENTITY_KIND_VALUES,
  MARKET_EVENT_TYPE_VALUES
} from '@/features/settings/constants';

/** JSON-serializable value — keeps server-fn return types serializable-typed. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function iso(date: Date): string;
function iso(date: Date | null | undefined): string | null;
function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

const entityKindSchema = z.enum(
  ECONOMIC_ENTITY_KIND_VALUES as [EconomicEntityKind, ...EconomicEntityKind[]]
);

// ---------------------------------------------------------------------------
// Health (loxep-nyl.2)
// ---------------------------------------------------------------------------

/**
 * Readiness/health detail (ADR-0018). Under `bin/loxep` this reports real
 * component/check state; in vite dev there is no runtime state and the
 * report degrades to `mode: 'dev'` with empty maps.
 */
export const fetchHealthReport = createServerFn({ method: 'GET' }).handler(
  async (): Promise<HealthReport> => {
    const [{ requireSession }, { readiness }] = await Promise.all([
      import('@/server/admin'),
      import('@loxep/runtime')
    ]);
    await requireSession();
    return readiness();
  }
);

// ---------------------------------------------------------------------------
// Economic entities (loxep-e51.4)
// ---------------------------------------------------------------------------

export interface EntityDto {
  id: string;
  name: string;
  kind: EconomicEntityKind;
  parentEntityId: string | null;
  legalName: string | null;
  active: boolean;
  childCount: number;
  createdAt: string;
  updatedAt: string;
}

export const fetchEntities = createServerFn({ method: 'GET' }).handler(
  async (): Promise<EntityDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const rows = await getAdminServices().entities.listEntities();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      parentEntityId: row.parentEntityId,
      legalName: row.legalName,
      active: row.active,
      childCount: row.childCount,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt)
    }));
  }
);

const createEntityInput = z.strictObject({
  name: z.string().trim().min(1),
  kind: entityKindSchema,
  parentEntityId: z.uuid().nullable(),
  legalName: z.string().trim().min(1).nullable()
});

export const createEntity = createServerFn({ method: 'POST' })
  .inputValidator(createEntityInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    const session = await requireAdmin();
    const entity = await getAdminServices().entities.createEntity(data, {
      actorUserId: session.user.id
    });
    return { id: entity.id };
  });

const updateEntityInput = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).optional(),
  kind: entityKindSchema.optional(),
  parentEntityId: z.uuid().nullable().optional(),
  legalName: z.string().trim().min(1).nullable().optional()
});

export const updateEntity = createServerFn({ method: 'POST' })
  .inputValidator(updateEntityInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    const session = await requireAdmin();
    const { id, ...patch } = data;
    const entity = await getAdminServices().entities.updateEntity(id, patch, {
      actorUserId: session.user.id
    });
    return { id: entity.id };
  });

export const deactivateEntity = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    const session = await requireAdmin();
    const entity = await getAdminServices().entities.deactivateEntity(data.id, {
      actorUserId: session.user.id
    });
    return { id: entity.id };
  });

// ---------------------------------------------------------------------------
// Connections (loxep-e51.4)
// ---------------------------------------------------------------------------

/** Credential metadata only (ADR-0019) — never key/token material. */
export interface ConnectionCredentialDto {
  credentialType: string;
  currentVersion: number;
  expiresAt: string | null;
  refreshAfter: string | null;
  updatedAt: string;
}

export interface ConnectionDto {
  id: string;
  provider: string;
  kind: string;
  name: string;
  status: ConnectionStatus;
  economicEntityId: string | null;
  externalAccountId: string | null;
  externalAccountName: string | null;
  config: Record<string, JsonValue>;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  credentials: ConnectionCredentialDto[];
}

export const fetchConnections = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ConnectionDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { connections } = getAdminServices();
    const rows = await connections.listConnections();
    return Promise.all(
      rows.map(async (row) => {
        const credentials = await connections.listConnectionCredentials(row.id);
        return {
          id: row.id,
          provider: row.provider,
          kind: row.kind,
          name: row.name,
          status: row.status,
          economicEntityId: row.economicEntityId,
          externalAccountId: row.externalAccountId,
          externalAccountName: row.externalAccountName,
          config: row.config as Record<string, JsonValue>,
          lastSuccessAt: iso(row.lastSuccessAt),
          lastErrorAt: iso(row.lastErrorAt),
          lastErrorCode: row.lastErrorCode,
          createdAt: iso(row.createdAt),
          credentials: credentials.map((credential) => ({
            credentialType: credential.credentialType,
            currentVersion: credential.currentVersion,
            expiresAt: iso(credential.expiresAt),
            refreshAfter: iso(credential.refreshAfter),
            updatedAt: iso(credential.updatedAt)
          }))
        };
      })
    );
  }
);

const createConnectionInput = z.strictObject({
  provider: z.string().trim().min(1),
  kind: z.string().trim().min(1),
  name: z.string().trim().min(1),
  config: z.record(z.string(), z.unknown()),
  economicEntityId: z.uuid().nullable()
});

export const createConnection = createServerFn({ method: 'POST' })
  .inputValidator(createConnectionInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    const session = await requireAdmin();
    const { connections } = getAdminServices();
    const created = await connections.createConnection(
      {
        provider: data.provider,
        kind: data.kind,
        name: data.name,
        config: data.config,
        createdByUserId: session.user.id
      },
      { actorUserId: session.user.id }
    );
    if (data.economicEntityId !== null) {
      await connections.attributeConnection(created.id, data.economicEntityId, {
        actorUserId: session.user.id
      });
    }
    return { id: created.id };
  });

export const setConnectionStatus = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ id: z.uuid(), status: z.enum(['active', 'disabled']) }))
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    const session = await requireAdmin();
    const connection = await getAdminServices().connections.setConnectionStatus(
      data.id,
      data.status,
      { actorUserId: session.user.id }
    );
    return { id: connection.id };
  });

export const attributeConnection = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ id: z.uuid(), economicEntityId: z.uuid().nullable() }))
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    const session = await requireAdmin();
    const connection = await getAdminServices().connections.attributeConnection(
      data.id,
      data.economicEntityId,
      { actorUserId: session.user.id }
    );
    return { id: connection.id };
  });

// ---------------------------------------------------------------------------
// Storage backends (loxep-nyl.3)
// ---------------------------------------------------------------------------

export interface StorageBackendDto {
  id: string;
  name: string;
  driver: string;
  enabled: boolean;
  isDefault: boolean;
  /** Non-secret driver config (rootDir / endpoint / region / bucket…). */
  config: JsonValue;
  /** Whether an encrypted credentials secret is attached (never the secret). */
  hasCredentials: boolean;
  createdAt: string;
}

export const fetchStorageBackends = createServerFn({ method: 'GET' }).handler(
  async (): Promise<StorageBackendDto[]> => {
    const { requireSession, getStorageBackendsService } = await import('@/server/admin');
    await requireSession();
    const storageBackends = await getStorageBackendsService();
    const rows = await storageBackends.listBackends();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      driver: row.driver,
      enabled: row.enabled,
      isDefault: row.isDefault,
      config: row.config as JsonValue,
      hasCredentials: row.secretId !== null,
      createdAt: iso(row.createdAt)
    }));
  }
);

/**
 * Access key/secret fields are write-only: they travel to the server once,
 * are stored via the encrypted secrets service, and are never echoed back.
 */
const registerStorageBackendInput = z.discriminatedUnion('driver', [
  z.strictObject({
    driver: z.literal('local'),
    name: z.string().trim().min(1),
    makeDefault: z.boolean(),
    rootDir: z.string().trim().min(1)
  }),
  z.strictObject({
    driver: z.literal('s3'),
    name: z.string().trim().min(1),
    makeDefault: z.boolean(),
    endpoint: z.url(),
    region: z.string().trim().min(1),
    bucket: z.string().trim().min(1),
    forcePathStyle: z.boolean(),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1)
  })
]);

export const registerStorageBackend = createServerFn({ method: 'POST' })
  .inputValidator(registerStorageBackendInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getStorageBackendsService } = await import('@/server/admin');
    const session = await requireAdmin();
    const storageBackends = await getStorageBackendsService();
    const record =
      data.driver === 'local'
        ? await storageBackends.registerBackend({
            name: data.name,
            driver: 'local',
            config: { rootDir: data.rootDir },
            makeDefault: data.makeDefault,
            createdByUserId: session.user.id
          })
        : await storageBackends.registerBackend({
            name: data.name,
            driver: 's3',
            config: {
              endpoint: data.endpoint,
              region: data.region,
              bucket: data.bucket,
              forcePathStyle: data.forcePathStyle
            },
            credentials: {
              accessKeyId: data.accessKeyId,
              secretAccessKey: data.secretAccessKey
            },
            makeDefault: data.makeDefault,
            createdByUserId: session.user.id
          });
    return { id: record.id };
  });

export const applyStorageBackendAction = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({ id: z.uuid(), action: z.enum(['enable', 'disable', 'set-default']) })
  )
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getStorageBackendsService } = await import('@/server/admin');
    await requireAdmin();
    const storageBackends = await getStorageBackendsService();
    if (data.action === 'enable') {
      await storageBackends.enableBackend(data.id);
    } else if (data.action === 'disable') {
      await storageBackends.disableBackend(data.id);
    } else {
      await storageBackends.setDefaultBackend(data.id);
    }
    return { id: data.id };
  });

// ---------------------------------------------------------------------------
// Users (loxep-nyl.3) — Better Auth admin API, admin-only including listing
// ---------------------------------------------------------------------------

export interface UserDto {
  id: string;
  email: string;
  name: string;
  role: string;
  banned: boolean;
  createdAt: string;
}

export const fetchUsers = createServerFn({ method: 'GET' }).handler(
  async (): Promise<UserDto[]> => {
    const [{ requireAdmin }, { getAuth }, { getRequestHeaders }] = await Promise.all([
      import('@/server/admin'),
      import('@/server/auth'),
      import('@tanstack/react-start/server')
    ]);
    await requireAdmin();
    const result = await getAuth().api.listUsers({
      query: { limit: 200, sortBy: 'createdAt', sortDirection: 'asc' },
      headers: getRequestHeaders()
    });
    return result.users.map((user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role ?? 'member',
      banned: user.banned ?? false,
      createdAt: iso(user.createdAt)
    }));
  }
);

export const setUserRole = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ userId: z.string().min(1), role: z.enum(['admin', 'member']) }))
  .handler(async ({ data }): Promise<{ userId: string }> => {
    const [{ requireAdmin }, { getAuth }, { getRequestHeaders }] = await Promise.all([
      import('@/server/admin'),
      import('@/server/auth'),
      import('@tanstack/react-start/server')
    ]);
    await requireAdmin();
    await getAuth().api.setRole({
      body: { userId: data.userId, role: data.role },
      headers: getRequestHeaders()
    });
    return { userId: data.userId };
  });

export interface FirstAdminBootstrapDto {
  completed: boolean;
  completedAt: string | null;
  email: string | null;
}

/** First-admin bootstrap marker from `application_settings` (read-only). */
export const fetchFirstAdminBootstrap = createServerFn({ method: 'GET' }).handler(
  async (): Promise<FirstAdminBootstrapDto> => {
    const [{ requireAdmin, getAdminServices }, { FIRST_ADMIN_BOOTSTRAP_SETTING_KEY }] =
      await Promise.all([import('@/server/admin'), import('@loxep/auth')]);
    await requireAdmin();
    const row = await getAdminServices().handle.db.query.applicationSettings.findFirst({
      where: (table, { eq }) => eq(table.key, FIRST_ADMIN_BOOTSTRAP_SETTING_KEY)
    });
    if (row === undefined) {
      return { completed: false, completedAt: null, email: null };
    }
    const value = row.value as { completedAt?: string; email?: string };
    return {
      completed: true,
      completedAt: value.completedAt ?? null,
      email: value.email ?? null
    };
  }
);

// ---------------------------------------------------------------------------
// Application settings (loxep-nyl.3)
// ---------------------------------------------------------------------------

export interface RegisteredSettingDto {
  key: string;
  description: string;
  schemaVersion: number;
  isSet: boolean;
  value: JsonValue;
  updatedAt: string | null;
}

/** Raw `application_settings` row — key/version/provenance, no value. */
export interface RawSettingDto {
  key: string;
  schemaVersion: number;
  updatedByUserId: string | null;
  updatedAt: string;
}

export interface ApplicationSettingsDto {
  registered: RegisteredSettingDto[];
  raw: RawSettingDto[];
}

export const fetchApplicationSettings = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ApplicationSettingsDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { settings, handle } = getAdminServices();
    const registered = await settings.list();
    // Rows written outside the registry (e.g. @loxep/jobs' runtime.heartbeat
    // upsert) surface here without value interpretation.
    const rawRows = await handle.db.query.applicationSettings.findMany({
      columns: { key: true, schemaVersion: true, updatedByUserId: true, updatedAt: true },
      orderBy: (table, { asc }) => [asc(table.key)]
    });
    return {
      registered: registered.map((entry) => ({
        key: entry.key,
        description: entry.description,
        schemaVersion: entry.schemaVersion,
        isSet: entry.isSet,
        value: entry.value as JsonValue,
        updatedAt: iso(entry.updatedAt)
      })),
      raw: rawRows.map((row) => ({
        key: row.key,
        schemaVersion: row.schemaVersion,
        updatedByUserId: row.updatedByUserId,
        updatedAt: iso(row.updatedAt)
      }))
    };
  }
);

// ---------------------------------------------------------------------------
// Notifications (loxep-62y.3) — ntfy endpoints, rules, delivery status
// ---------------------------------------------------------------------------

/** Non-secret ntfy endpoint config; the token is write-only (ADR-0019). */
export interface NtfyEndpointConfigDto {
  baseUrl: string;
  topic: string;
  priority?: 'min' | 'low' | 'default' | 'high' | 'urgent';
}

export interface NotificationEndpointDto {
  id: string;
  provider: string;
  name: string;
  enabled: boolean;
  config: NtfyEndpointConfigDto;
  /** Whether an encrypted token secret is attached — never the token itself. */
  hasToken: boolean;
  createdAt: string;
  updatedAt: string;
}

export const fetchNotificationEndpoints = createServerFn({ method: 'GET' }).handler(
  async (): Promise<NotificationEndpointDto[]> => {
    const { requireSession, getNotificationsService } = await import('@/server/admin');
    await requireSession();
    const notifications = await getNotificationsService();
    const rows = await notifications.listEndpoints();
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      name: row.name,
      enabled: row.enabled,
      config: row.config as NtfyEndpointConfigDto,
      hasToken: row.secretId !== null,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt)
    }));
  }
);

const ntfyEndpointConfigInput = z.strictObject({
  baseUrl: z.url(),
  topic: z
    .string()
    .trim()
    .min(1)
    .regex(/^[-_A-Za-z0-9]+$/, 'ntfy topics may contain only letters, digits, - and _'),
  priority: z.enum(['min', 'low', 'default', 'high', 'urgent']).optional()
});

const createNotificationEndpointInput = z.strictObject({
  name: z.string().trim().min(1),
  config: ntfyEndpointConfigInput,
  enabled: z.boolean(),
  /** Write-only: sent once, stored through the encrypted secrets service. */
  token: z.string().trim().min(1).optional()
});

export const createNotificationEndpoint = createServerFn({ method: 'POST' })
  .inputValidator(createNotificationEndpointInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getNotificationsService } = await import('@/server/admin');
    const session = await requireAdmin();
    const notifications = await getNotificationsService();
    const endpoint = await notifications.createEndpoint({
      provider: 'ntfy',
      name: data.name,
      config: data.config,
      enabled: data.enabled,
      token: data.token,
      createdByUserId: session.user.id
    });
    return { id: endpoint.id };
  });

const updateNotificationEndpointInput = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  config: ntfyEndpointConfigInput.optional(),
  /** Write-only rotation: omit to leave the current token untouched. */
  token: z.string().trim().min(1).optional()
});

export const updateNotificationEndpoint = createServerFn({ method: 'POST' })
  .inputValidator(updateNotificationEndpointInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getNotificationsService } = await import('@/server/admin');
    await requireAdmin();
    const { id, ...patch } = data;
    const notifications = await getNotificationsService();
    const endpoint = await notifications.updateEndpoint(id, patch);
    return { id: endpoint.id };
  });

export const setNotificationEndpointEnabled = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ id: z.uuid(), enabled: z.boolean() }))
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getNotificationsService } = await import('@/server/admin');
    await requireAdmin();
    const notifications = await getNotificationsService();
    const endpoint = await notifications.updateEndpoint(data.id, { enabled: data.enabled });
    return { id: endpoint.id };
  });

export interface SendTestNotificationResultDto {
  ok: boolean;
  error: string | null;
  providerMessageId: string | null;
}

/**
 * Admin-only real POST through `createNtfyTransport` against the endpoint's
 * configured ntfy server — a real server may not exist at that address, so
 * transport failures are caught and reported as a clean `{ ok: false, error
 * }` result rather than a thrown 500.
 */
export const sendTestNotification = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<SendTestNotificationResultDto> => {
    const { requireAdmin, getNotificationsService, getNotificationsModule } =
      await import('@/server/admin');
    await requireAdmin();
    const [notifications, notificationsModule] = await Promise.all([
      getNotificationsService(),
      getNotificationsModule()
    ]);
    const endpoint = await notifications.getEndpoint(data.id);
    if (endpoint.provider !== 'ntfy') {
      return {
        ok: false,
        error: `Test send is not supported for provider "${endpoint.provider}"`,
        providerMessageId: null
      };
    }
    try {
      const token = await notifications.getEndpointToken(data.id);
      const transport = notificationsModule.createNtfyTransport();
      const result = await transport.send({
        config: endpoint.config,
        token,
        message: {
          title: 'Loxep test notification',
          body: `Test notification for endpoint "${endpoint.name}" sent ${new Date().toISOString()}.`,
          tags: ['test_tube']
        }
      });
      return { ok: true, error: null, providerMessageId: result.providerMessageId };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Test notification failed',
        providerMessageId: null
      };
    }
  });

export interface NotificationRuleDto {
  id: string;
  name: string;
  enabled: boolean;
  marketEventType: string | null;
  monitorTargetId: string | null;
  endpointId: string;
  createdAt: string;
  updatedAt: string;
}

export const fetchNotificationRules = createServerFn({ method: 'GET' }).handler(
  async (): Promise<NotificationRuleDto[]> => {
    const { requireSession, getNotificationsService } = await import('@/server/admin');
    await requireSession();
    const notifications = await getNotificationsService();
    const rows = await notifications.listRules();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      marketEventType: row.marketEventType,
      monitorTargetId: row.monitorTargetId,
      endpointId: row.endpointId,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt)
    }));
  }
);

const marketEventTypeSchema = z.enum(
  MARKET_EVENT_TYPE_VALUES as [MarketEventType, ...MarketEventType[]]
);

const createNotificationRuleInput = z.strictObject({
  name: z.string().trim().min(1),
  endpointId: z.uuid(),
  enabled: z.boolean(),
  marketEventType: marketEventTypeSchema.nullable(),
  monitorTargetId: z.uuid().nullable()
});

export const createNotificationRule = createServerFn({ method: 'POST' })
  .inputValidator(createNotificationRuleInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getNotificationsService } = await import('@/server/admin');
    const session = await requireAdmin();
    const notifications = await getNotificationsService();
    const rule = await notifications.createRule({
      name: data.name,
      endpointId: data.endpointId,
      enabled: data.enabled,
      marketEventType: data.marketEventType,
      monitorTargetId: data.monitorTargetId,
      createdByUserId: session.user.id
    });
    return { id: rule.id };
  });

const updateNotificationRuleInput = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  marketEventType: marketEventTypeSchema.nullable().optional(),
  monitorTargetId: z.uuid().nullable().optional()
});

export const updateNotificationRule = createServerFn({ method: 'POST' })
  .inputValidator(updateNotificationRuleInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getNotificationsService } = await import('@/server/admin');
    await requireAdmin();
    const { id, ...patch } = data;
    const notifications = await getNotificationsService();
    const rule = await notifications.updateRule(id, patch);
    return { id: rule.id };
  });

export interface MonitorTargetOptionDto {
  id: string;
  name: string;
  targetType: string;
}

/** Lightweight monitor-target picker list for the rule dialog's filter. */
export const fetchMonitorTargetOptions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<MonitorTargetOptionDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const rows = await getAdminServices().handle.db.query.monitorTargets.findMany({
      columns: { id: true, name: true, targetType: true },
      orderBy: (table, { asc }) => [asc(table.name)]
    });
    return rows;
  }
);

export interface NotificationDeliveryDto {
  id: string;
  eventType: string;
  endpointId: string;
  endpointName: string;
  status: string;
  attemptCount: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

/** Recent delivery attempts (metadata only) — member-readable status surface. */
export const fetchNotificationDeliveries = createServerFn({ method: 'GET' }).handler(
  async (): Promise<NotificationDeliveryDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const deliveries = await handle.db.query.notificationDeliveries.findMany({
      orderBy: (table, { desc }) => [desc(table.createdAt)],
      limit: 50
    });
    if (deliveries.length === 0) return [];
    const endpointIds = [...new Set(deliveries.map((row) => row.endpointId))];
    const eventIds = [...new Set(deliveries.map((row) => row.marketEventId))];
    const [endpoints, events] = await Promise.all([
      handle.db.query.notificationEndpoints.findMany({
        where: (table, { inArray }) => inArray(table.id, endpointIds),
        columns: { id: true, name: true }
      }),
      handle.db.query.marketEvents.findMany({
        where: (table, { inArray }) => inArray(table.id, eventIds),
        columns: { id: true, eventType: true }
      })
    ]);
    const endpointNameById = new Map(endpoints.map((row) => [row.id, row.name]));
    const eventTypeById = new Map(events.map((row) => [row.id, row.eventType]));
    return deliveries.map((row) => ({
      id: row.id,
      eventType: eventTypeById.get(row.marketEventId) ?? 'unknown',
      endpointId: row.endpointId,
      endpointName: endpointNameById.get(row.endpointId) ?? 'unknown',
      status: row.status,
      attemptCount: row.attemptCount,
      lastError: row.lastError,
      lastAttemptAt: iso(row.lastAttemptAt),
      deliveredAt: iso(row.deliveredAt),
      createdAt: iso(row.createdAt)
    }));
  }
);
