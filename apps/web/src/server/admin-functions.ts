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
import { randomBytes } from 'node:crypto';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { EconomicEntityKind } from '@loxep/db/schema';
import {
  authOnboardingOidcPromptDismissedSetting,
  authProvisioningSetting,
  EVIDENCE_INGEST_CONNECTION_KIND,
  FLEET_EVIDENCE_PROVIDERS,
  GATUS_PUSH_SECRET_KEY,
  gatusPushSetting,
  integrationsEnabledSetting,
  PROVIDER_WRITE_POLICY_TIERS,
  providerWritePolicySetting
} from '@loxep/domain';
import type {
  ConnectionStatus,
  FleetEvidenceProvider,
  ProviderWritePolicyTier
} from '@loxep/domain';
import type { HealthReport } from '@loxep/runtime';
import type { NotificationEventClass } from '@loxep/db/schema';
// Pure renderer (no runtime imports at all), so the bell and the outbound
// ntfy message describe a fact identically. The package index is dynamically
// imported elsewhere because it reaches graphile-worker; this deep path does
// not.
import { renderNotificationEventMessage } from '@loxep/notifications/render';
import {
  ECONOMIC_ENTITY_KIND_VALUES,
  NOTIFICATION_EVENT_CLASS_VALUES
} from '@/features/settings/constants';
import {
  EBAY_ORDERS_TARGET_TYPE,
  MEDUSA_ORDERS_TARGET_TYPE,
  WOO_ORDERS_TARGET_TYPE,
  type OrderSyncStatusDto
} from '@/server/order-sync-functions';
import {
  EBAY_PURCHASES_TARGET_TYPE,
  type PurchaseSyncStatusDto
} from '@/server/purchase-sync-functions';

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
// integration_health (Phase 8 milestone 1, loxep-ovj.1)
// ---------------------------------------------------------------------------

/**
 * One row of the shared-foundation `integration_health` rollup, labeled for
 * display. `status`/`source` are the design's closed sets
 * (ok/degraded/failing/unknown; probe/adapter/ingest/report) but travel as
 * plain strings here, same convention as every other text-union DTO field in
 * this module. There is deliberately no `stale` field: the UI derives that
 * from `checkedAt` itself, per the design.
 */
export interface IntegrationHealthDto {
  subjectType: string;
  subjectId: string;
  /** Human-readable subject name, resolved from the owning table. */
  label: string;
  status: string;
  source: string;
  checkedAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  detail: JsonValue;
  /** The status immediately before the most recent transition; null until the first one (loxep-oii). */
  previousStatus: string | null;
  /** When the most recent transition was observed; null until the first one (loxep-oii). */
  statusChangedAt: string | null;
}

/**
 * Subjects by status, for `/settings/overview` and the dashboard Operations
 * band. Labels are resolved per subject type from the owning table/service —
 * `integration_health` itself carries only the polymorphic
 * `(subject_type, subject_id)` key (the design's deliberate cost: no FK, see
 * the schema doc), so a subject deleted after its last probe and before the
 * owning service cleared its row would fall back to a short id label rather
 * than fail the whole read.
 */
export const fetchIntegrationHealth = createServerFn({ method: 'GET' }).handler(
  async (): Promise<IntegrationHealthDto[]> => {
    const { requireSession, getAdminServices, getNotificationsService, getStorageBackendsService } =
      await import('@/server/admin');
    await requireSession();
    const admin = getAdminServices();

    const [rows, connections, endpoints, backends] = await Promise.all([
      admin.health.listHealth(),
      admin.connections.listConnections(),
      getNotificationsService().then((service) => service.listEndpoints()),
      getStorageBackendsService().then((service) => service.listBackends())
    ]);

    const connectionLabels = new Map(
      connections.map((row) => [row.id, `${row.name} (${row.provider})`])
    );
    const endpointLabels = new Map(endpoints.map((row) => [row.id, row.name]));
    const backendLabels = new Map(backends.map((row) => [row.id, row.name]));

    function labelFor(subjectType: string, subjectId: string): string {
      const short = subjectId.slice(0, 8);
      if (subjectType === 'connection') {
        return connectionLabels.get(subjectId) ?? `connection ${short}`;
      }
      if (subjectType === 'notification_endpoint') {
        return endpointLabels.get(subjectId) ?? `notification endpoint ${short}`;
      }
      if (subjectType === 'storage_backend') {
        return backendLabels.get(subjectId) ?? `storage backend ${short}`;
      }
      return `${subjectType} ${short}`;
    }

    return rows.map((row) => ({
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      label: labelFor(row.subjectType, row.subjectId),
      status: row.status,
      source: row.source,
      checkedAt: iso(row.checkedAt),
      lastSuccessAt: iso(row.lastSuccessAt),
      lastFailureAt: iso(row.lastFailureAt),
      consecutiveFailures: row.consecutiveFailures,
      detail: row.detail as JsonValue,
      previousStatus: row.previousStatus,
      statusChangedAt: iso(row.statusChangedAt)
    }));
  }
);

// ---------------------------------------------------------------------------
// Gatus outward health push (Phase 8 milestone 2, loxep-ovj.2)
// ---------------------------------------------------------------------------

/**
 * Non-secret half of `infrastructure.gatus_push` plus whether a push token
 * is stored (never the token itself) — same "settings echo, secrets don't"
 * split every other credential-bearing form in this file uses.
 */
export interface GatusPushSettingsDto {
  enabled: boolean;
  baseUrl: string | null;
  endpointKey: string | null;
  /**
   * `'single'` (PROVISIONAL default, loxep-4ah owner ruling 6b) keeps
   * milestone 2's shipped behavior exactly — one push, to `endpointKey`
   * itself. `'facts'` opts into the OQ9 five-fact expansion: one push per
   * fact, to five keys DERIVED from `endpointKey` (never `endpointKey`
   * itself) — see the `gatus-health-push` guide for the exact YAML block an
   * operator must declare before flipping this.
   */
  mode: 'single' | 'facts';
  hasToken: boolean;
}

export const fetchGatusPushSettings = createServerFn({ method: 'GET' }).handler(
  async (): Promise<GatusPushSettingsDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { settings, secrets } = getAdminServices();
    const [value, storedSecrets] = await Promise.all([
      settings.get(gatusPushSetting),
      secrets.listSecrets()
    ]);
    return {
      enabled: value.enabled,
      baseUrl: value.baseUrl,
      endpointKey: value.endpointKey,
      mode: value.mode,
      hasToken: storedSecrets.some((secret) => secret.secretKey === GATUS_PUSH_SECRET_KEY)
    };
  }
);

const updateGatusPushSettingsInput = z.strictObject({
  enabled: z.boolean(),
  baseUrl: z.url().nullable(),
  endpointKey: z
    .string()
    .min(3)
    .regex(
      /^[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/u,
      'must look like <GROUP_NAME>_<ENDPOINT_NAME>, matching the gatus external-endpoints declaration'
    )
    .nullable(),
  mode: z.enum(['single', 'facts']),
  /** Write-only: sent once, stored through the encrypted secrets service. */
  token: z.string().trim().min(1).optional()
});

/**
 * Admin write for the Gatus push configuration. The non-secret fields
 * (`enabled`/`baseUrl`/`endpointKey`) go through the same registered-setting
 * write path every other application setting uses; the token, when present,
 * rotates the separate encrypted secret `infrastructure.gatus_push.default`
 * (purpose `token`) — omitting it leaves the currently stored token
 * untouched, the same write-only rotation `updateNotificationEndpoint` uses.
 */
export const updateGatusPushSettings = createServerFn({ method: 'POST' })
  .inputValidator(updateGatusPushSettingsInput)
  .handler(async ({ data }): Promise<GatusPushSettingsDto> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    const session = await requireAdmin();
    const { settings, secrets } = getAdminServices();
    const { token, ...value } = data;

    await settings.set(gatusPushSetting, value, { actorUserId: session.user.id });
    if (token !== undefined) {
      await secrets.setSecret({
        secretKey: GATUS_PUSH_SECRET_KEY,
        purpose: 'token',
        payload: { token },
        actorUserId: session.user.id
      });
    }

    const storedSecrets = await secrets.listSecrets();
    return {
      enabled: value.enabled,
      baseUrl: value.baseUrl,
      endpointKey: value.endpointKey,
      mode: value.mode,
      hasToken: storedSecrets.some((secret) => secret.secretKey === GATUS_PUSH_SECRET_KEY)
    };
  });

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
  /** `woo_orders`/`ebay_orders` monitor-target status (loxep-cxh), or `null` when none exists yet. */
  orderSync: OrderSyncStatusDto | null;
  /** `ebay_purchases` monitor-target status (loxep-dgf.5), or `null` when none exists yet. */
  purchaseSync: PurchaseSyncStatusDto | null;
}

export const fetchConnections = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ConnectionDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { connections, handle } = getAdminServices();
    const rows = await connections.listConnections();

    // Order-sync AND purchase-sync status folded into this DTO with one bulk
    // query each rather than one lookup per row (loxep-cxh, loxep-dgf.5) —
    // `fetchConnections` already returns every connection in a single call,
    // so a per-row status round-trip would just be an avoidable N+1.
    const orderSyncTargets =
      rows.length === 0
        ? []
        : await handle.db.query.monitorTargets.findMany({
            where: (table, { and, inArray }) =>
              and(
                inArray(table.targetType, [
                  WOO_ORDERS_TARGET_TYPE,
                  EBAY_ORDERS_TARGET_TYPE,
                  MEDUSA_ORDERS_TARGET_TYPE
                ]),
                inArray(
                  table.connectionId,
                  rows.map((row) => row.id)
                )
              ),
            columns: {
              id: true,
              connectionId: true,
              targetType: true,
              enabled: true,
              lastSuccessAt: true
            },
            orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)]
          });
    // One order-sync target per connection is the ensure/create invariant
    // (loxep-cxh); first by creation order wins if that were ever violated.
    const orderSyncByConnectionId = new Map<string, (typeof orderSyncTargets)[number]>();
    for (const target of orderSyncTargets) {
      if (target.connectionId !== null && !orderSyncByConnectionId.has(target.connectionId)) {
        orderSyncByConnectionId.set(target.connectionId, target);
      }
    }

    // Same shape, one `ebay_purchases` target per connection (loxep-dgf.5).
    const purchaseSyncTargets =
      rows.length === 0
        ? []
        : await handle.db.query.monitorTargets.findMany({
            where: (table, { and, eq, inArray }) =>
              and(
                eq(table.targetType, EBAY_PURCHASES_TARGET_TYPE),
                inArray(
                  table.connectionId,
                  rows.map((row) => row.id)
                )
              ),
            columns: {
              id: true,
              connectionId: true,
              enabled: true,
              lastSuccessAt: true
            },
            orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)]
          });
    const purchaseSyncByConnectionId = new Map<string, (typeof purchaseSyncTargets)[number]>();
    for (const target of purchaseSyncTargets) {
      if (target.connectionId !== null && !purchaseSyncByConnectionId.has(target.connectionId)) {
        purchaseSyncByConnectionId.set(target.connectionId, target);
      }
    }

    return Promise.all(
      rows.map(async (row) => {
        const credentials = await connections.listConnectionCredentials(row.id);
        const orderSyncTarget = orderSyncByConnectionId.get(row.id);
        const purchaseSyncTarget = purchaseSyncByConnectionId.get(row.id);
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
          })),
          orderSync:
            orderSyncTarget === undefined
              ? null
              : {
                  targetId: orderSyncTarget.id,
                  targetType: orderSyncTarget.targetType as OrderSyncStatusDto['targetType'],
                  enabled: orderSyncTarget.enabled,
                  lastSuccessAt: iso(orderSyncTarget.lastSuccessAt)
                },
          purchaseSync:
            purchaseSyncTarget === undefined
              ? null
              : ({
                  targetId: purchaseSyncTarget.id,
                  enabled: purchaseSyncTarget.enabled,
                  lastSuccessAt: iso(purchaseSyncTarget.lastSuccessAt)
                } satisfies PurchaseSyncStatusDto)
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

const createFleetEvidenceSourceInput = z.strictObject({
  provider: z.enum(FLEET_EVIDENCE_PROVIDERS),
  name: z.string().trim().min(1).max(200)
});

/**
 * Configure one inbound fleet-evidence source (Phase 8 milestone 7,
 * loxep-ovj.7): a `connections` row of kind `evidence_ingest` plus a freshly
 * minted `fleet_ingest_token` credential, in one admin action. ADR-0022
 * reveal-once: `token` is the plaintext value, returned in THIS response
 * only — nothing anywhere reads it back afterward. The endpoint URL to paste
 * into the sender's own configuration is built client-side from
 * `connectionId` (`/api/v1/hooks/fleet/:connectionId`); there is nothing
 * secret about the URL itself, only the bearer token.
 *
 * Deletion/archival reuse the existing generic `deleteConnection`/
 * `archiveConnection` — an evidence-ingest connection is an ordinary
 * `connections` row and needs no dedicated remove action.
 */
export const createFleetEvidenceSource = createServerFn({ method: 'POST' })
  .inputValidator(createFleetEvidenceSourceInput)
  .handler(async ({ data }): Promise<{ connectionId: string; token: string }> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    const session = await requireAdmin();
    const { connections, connectionCredentials } = getAdminServices();

    const created = await connections.createConnection(
      {
        provider: data.provider,
        kind: EVIDENCE_INGEST_CONNECTION_KIND,
        name: data.name,
        createdByUserId: session.user.id
      },
      { actorUserId: session.user.id }
    );

    const token = randomBytes(32).toString('base64url');
    await connectionCredentials.setCredential({
      connectionId: created.id,
      credentialType: 'fleet_ingest_token',
      payload: { token },
      actorUserId: session.user.id
    });

    return { connectionId: created.id, token };
  });

export interface FleetEvidenceSourceDto {
  connectionId: string;
  provider: FleetEvidenceProvider;
  name: string;
  createdAt: string;
  hasToken: boolean;
}

/**
 * Evidence-ingest connections only — filtered server-side so the settings
 * panel never has to know `EVIDENCE_INGEST_CONNECTION_KIND`'s literal value
 * or re-derive it from the full `fetchConnections` list itself.
 */
export const fetchFleetEvidenceSources = createServerFn({ method: 'GET' }).handler(
  async (): Promise<FleetEvidenceSourceDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { connections } = getAdminServices();
    const rows = await connections.listConnections({ kind: EVIDENCE_INGEST_CONNECTION_KIND });
    return Promise.all(
      rows.map(async (row) => {
        const credentials = await connections.listConnectionCredentials(row.id);
        return {
          connectionId: row.id,
          provider: row.provider as FleetEvidenceProvider,
          name: row.name,
          createdAt: iso(row.createdAt),
          hasToken: credentials.some(
            (credential) => credential.credentialType === 'fleet_ingest_token'
          )
        };
      })
    );
  }
);

/**
 * Guided store-connection input. Each variant is one catalog service's form
 * (`@/features/settings/integrations-catalog`): the browser never sends a
 * provider, a kind, or a raw config object — those are derived here from the
 * `service` discriminator, so a store connection cannot be created
 * half-shaped.
 *
 * Secret fields are write-only: they travel to the server once, are stored
 * through the encrypted connection-credentials service (ADR-0019), and are
 * never echoed back by any read surface.
 */
const createStoreConnectionInput = z.discriminatedUnion('service', [
  z.strictObject({
    service: z.literal('woocommerce'),
    name: z.string().trim().min(1),
    baseUrl: z.url(),
    economicEntityId: z.uuid().nullable(),
    consumerKey: z.string().trim().min(1),
    consumerSecret: z.string().trim().min(1)
  }),
  z.strictObject({
    service: z.literal('medusa'),
    name: z.string().trim().min(1),
    baseUrl: z.url(),
    economicEntityId: z.uuid().nullable(),
    apiToken: z.string().trim().min(1)
  }),
  z.strictObject({
    service: z.literal('invoiceninja'),
    name: z.string().trim().min(1),
    baseUrl: z.url(),
    economicEntityId: z.uuid().nullable(),
    apiToken: z.string().trim().min(1)
  }),
  /**
   * Reverb (loxep-g4t.3): a self-service Personal Access Token, simpler than
   * every other marketplace form — no `baseUrl` (one fixed hosted API, per
   * `packages/integrations/reverb/src/config.ts`) and no shop id to collect
   * (m1's `reverb_shop` monitor target always means "the connection's own
   * account"; see `packages/integrations/reverb/src/connection.ts`).
   */
  z.strictObject({
    service: z.literal('reverb'),
    name: z.string().trim().min(1),
    economicEntityId: z.uuid().nullable(),
    personalAccessToken: z.string().trim().min(1)
  }),
  /**
   * Cloudflare and Purelymail (loxep-lmy.1/.2): the Infrastructure control
   * plane's two provider connections. Neither carries a `baseUrl` — both
   * adapters talk to a fixed, provider-owned endpoint
   * (`packages/integrations/cloudflare/src/config.ts`,
   * `packages/integrations/purelymail/src/config.ts`) — so there is no store
   * URL to collect. `accountId` is Cloudflare's only non-secret config, and
   * optional (a zone-scoped token has none); Purelymail has no account
   * identifier of any kind, per its bundle doc in `@loxep/domain`.
   */
  z.strictObject({
    service: z.literal('cloudflare'),
    name: z.string().trim().min(1),
    accountId: z.string().trim().min(1).optional(),
    economicEntityId: z.uuid().nullable(),
    apiToken: z.string().trim().min(1)
  }),
  z.strictObject({
    service: z.literal('purelymail'),
    name: z.string().trim().min(1),
    economicEntityId: z.uuid().nullable(),
    apiToken: z.string().trim().min(1)
  }),
  /**
   * Tailscale and Termix (loxep-4su/loxep-g3f, Tailscale extended by
   * loxep-50t §2.2): read-only fleet-observability connections. Neither
   * carries a `baseUrl` field named that way in the `woocommerce`/`medusa`
   * sense of "the one non-secret config value" — Tailscale's `tailnet` plays
   * that role instead (defaulting to `-`, its own "default tailnet of this
   * credential" shorthand, when the operator leaves it blank), while Termix
   * genuinely does need a base URL, being self-hosted like Beszel/Dockhand.
   *
   * Tailscale carries BOTH of its documented credential modes
   * (`tailscale_credentials` in `@loxep/domain`) rather than picking one, per
   * loxep-50t's finding that shipping only the API-access-token branch made
   * an unattended credential that WILL silently expire the only option. The
   * fields for the branch not chosen stay optional here and are validated for
   * presence in the handler below (the same posture the Gatus branch already
   * uses for its own optional pair) rather than in the schema, because a
   * discriminated union nested inside this outer `service` union would need
   * every branch to repeat the `service` literal for no benefit. `mode ===
   * 'api_access_token'` is the only branch `credentialExpiresAt` applies to —
   * an OAuth client renews itself and has no expiry to record.
   */
  z.strictObject({
    service: z.literal('tailscale'),
    name: z.string().trim().min(1),
    tailnet: z.string().trim().min(1).optional(),
    economicEntityId: z.uuid().nullable(),
    mode: z.enum(['oauth_client', 'api_access_token']),
    apiAccessToken: z.string().trim().min(1).optional(),
    credentialExpiresAt: z.iso.date().optional(),
    clientId: z.string().trim().min(1).optional(),
    clientSecret: z.string().trim().min(1).optional()
  }),
  z.strictObject({
    service: z.literal('termix'),
    name: z.string().trim().min(1),
    baseUrl: z.url(),
    economicEntityId: z.uuid().nullable(),
    username: z.string().trim().min(1),
    password: z.string().trim().min(1)
  }),
  /**
   * Gatus (Phase 8 milestone 4, loxep-ovj.4): a read-only fleet-observability
   * connection, like Tailscale/Termix above. `username`/`password` are
   * OPTIONAL, unlike Termix's — Gatus's read API is fully open when the
   * operator's instance has no `security` block configured, and even an
   * OIDC-secured instance has no bearer credential this form could collect
   * (see `gatus_credentials` in `@loxep/domain`). Supplying exactly one half
   * is rejected in the handler below, the same atomicity every other
   * credential pair in this union enforces via its bundle schema.
   */
  z.strictObject({
    service: z.literal('gatus'),
    name: z.string().trim().min(1),
    baseUrl: z.url(),
    economicEntityId: z.uuid().nullable(),
    username: z.string().trim().min(1).optional(),
    password: z.string().trim().min(1).optional()
  }),
  /**
   * Beszel and Dockhand (loxep-rf4 scope (b), loxep-y64 §7 slice 1,
   * loxep-hb7 §1.7): the last two fleet-observability providers with shipped
   * adapters but no catalog entry until now. Both are login-shaped, like
   * Termix, and both `baseUrl`s are normalized to their ORIGIN
   * (`normalizeFleetBaseUrl` below) rather than only trimmed like every
   * sibling above — Dockhand's is the case that matters (a pasted
   * `.../api` URL must not double into `.../api/api` once the adapter
   * appends its own API path), and Beszel gets the same treatment for
   * consistency since both are "the instance root" in the operator's head.
   *
   * Beszel's pair is `email`/`password` (PocketBase's own field name is
   * `identity`, but Beszel accounts are emails) for a dedicated READONLY
   * user — never call this an API token in copy anywhere on this path;
   * Beszel issues none (see `beszel_credentials` in `@loxep/domain`).
   * Dockhand's pair is an ordinary `username`/`password` session login for
   * the same reason (see `dockhand_credentials`).
   */
  z.strictObject({
    service: z.literal('beszel'),
    name: z.string().trim().min(1),
    baseUrl: z.url(),
    economicEntityId: z.uuid().nullable(),
    email: z.string().trim().min(1),
    password: z.string().trim().min(1)
  }),
  z.strictObject({
    service: z.literal('dockhand'),
    name: z.string().trim().min(1),
    baseUrl: z.url(),
    economicEntityId: z.uuid().nullable(),
    username: z.string().trim().min(1),
    password: z.string().trim().min(1)
  }),
  /**
   * Pangolin (loxep-acj.1, milestone 1 — read only): `baseUrl` is the
   * Integration API's own origin (NOT the dashboard URL — the guided form
   * carries the full warning), and `orgId` is the organization slug this
   * connection reads, both non-secret `connections.config`. `apiKeyId` /
   * `apiKeySecret` are the two halves of the bearer credential
   * (`Authorization: Bearer <apiKeyId>.<apiKeySecret>`), stored atomically
   * in the `pangolin_credentials` bundle (`@loxep/domain`).
   */
  z.strictObject({
    service: z.literal('pangolin'),
    name: z.string().trim().min(1),
    baseUrl: z.url(),
    orgId: z.string().trim().min(1),
    economicEntityId: z.uuid().nullable(),
    apiKeyId: z.string().trim().min(1),
    apiKeySecret: z.string().trim().min(1)
  })
]);

/**
 * Normalizes a self-hosted fleet instance's pasted URL down to its origin —
 * protocol, host, and port, dropping any path. Used by the Beszel and
 * Dockhand branches below (loxep-hb7 §1.7's normalization rule): an operator
 * who pastes the instance's API root (Dockhand: `.../api`) rather than its
 * site root must not end up with that path doubled once the adapter appends
 * its own API path onto `connections.config`. `data.baseUrl` is already a
 * validated absolute URL (`z.url()`), so `new URL` here cannot throw.
 */
export function normalizeFleetBaseUrl(rawUrl: string): string {
  return new URL(rawUrl).origin;
}

/**
 * Create a store/billing/marketplace/infrastructure connection plus its
 * credential in one guided step. Despite the name (kept for the two
 * original callers), this also drives the Invoice Ninja form — its
 * "account" is a billing companion connection, not a commerce store, hence
 * `kind: 'billing_account'` for that one service; see
 * `packages/integrations/invoiceninja/src/connection.ts` — the Reverb form
 * (loxep-g4t.3, `kind: 'marketplace_account'`, matching eBay/Etsy's own
 * accounts even though this path is simpler than either's consent flow) —
 * and, per the same reasoning, the Cloudflare (`kind: 'dns'`) and Purelymail
 * (`kind: 'mail'`) forms for the Infrastructure control plane
 * (loxep-lmy.1/.2).
 *
 * WHERE EACH HALF LANDS — the split the integration packages document
 * (`packages/app/src/woo.ts`, `packages/integrations/medusa/src/connection.ts`,
 * `packages/integrations/invoiceninja/src/connection.ts`,
 * `packages/integrations/reverb/src/connection.ts`,
 * `packages/app/src/cloudflare.ts`, `packages/app/src/purelymail.ts`): any
 * non-secret provider identity — a base URL, or Cloudflare's optional
 * account id — goes into `connections.config.<service>` so it stays readable
 * without a decryption round-trip, while the key pair / API token is an
 * atomic encrypted bundle on the connection. Reverb and Purelymail have no
 * non-secret half at all, so their config objects stay empty.
 *
 * The credential type is the registered bundle purpose (`woo_credentials`,
 * `medusa_credentials`, `invoiceninja_credentials`, `reverb_credentials`,
 * `cloudflare_credentials`, `purelymail_credentials`) because that is what
 * the domain service accepts and what the worker-side readers ask for — see
 * `WOO_CREDENTIAL_TYPE` in `packages/app/src/woo.ts` and its siblings in
 * `reverb.ts`/`cloudflare.ts`/`purelymail.ts`.
 */
export const createStoreConnection = createServerFn({ method: 'POST' })
  .inputValidator(createStoreConnectionInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    const session = await requireAdmin();
    const { connections } = getAdminServices();

    let kind: string;
    let config: Record<string, unknown>;
    if (data.service === 'woocommerce') {
      kind = 'store_account';
      config = { woo: { baseUrl: data.baseUrl.replace(/\/+$/, '') } };
    } else if (data.service === 'medusa') {
      kind = 'store_account';
      config = { medusa: { baseUrl: data.baseUrl.replace(/\/+$/, '') } };
    } else if (data.service === 'invoiceninja') {
      kind = 'billing_account';
      config = { invoiceninja: { baseUrl: data.baseUrl.replace(/\/+$/, '') } };
    } else if (data.service === 'reverb') {
      // No non-secret half at all — the same shape as Purelymail's branch
      // below, for the same reason: Reverb has no per-deployment host and
      // no operator-entered shop id (see this union's Reverb doc comment).
      kind = 'marketplace_account';
      config = {};
    } else if (data.service === 'cloudflare') {
      // 'dns' / 'mail', matching packages/app's connections fixtures for the
      // Infrastructure control plane (loxep-lmy.1/.2). `accountId` stays out
      // of the config object entirely when absent, matching
      // readCloudflareAccountId's null-on-missing-key contract.
      kind = 'dns';
      config = data.accountId === undefined ? {} : { cloudflare: { accountId: data.accountId } };
    } else if (data.service === 'purelymail') {
      // Purelymail exposes no account identifier at all (see
      // purelymail_credentials in @loxep/domain's bundle registry), so its
      // config object stays empty.
      kind = 'mail';
      config = {};
    } else if (data.service === 'tailscale') {
      kind = 'fleet_observability';
      // Both credential modes are non-secret in `credentialMode` itself — it
      // names a SHAPE, not a value — so the catalog card (loxep-50t §2.2d) can
      // tell an auto-renewing OAuth connection from a token connection without
      // a decryption round-trip. `credentialExpiresAt` is the operator-recorded
      // date from the token branch only; an OAuth client has no expiry to
      // record.
      config = {
        tailscale: {
          ...(data.tailnet === undefined ? {} : { tailnet: data.tailnet }),
          credentialMode: data.mode,
          ...(data.mode === 'api_access_token' && data.credentialExpiresAt !== undefined
            ? { credentialExpiresAt: data.credentialExpiresAt }
            : {})
        }
      };
    } else if (data.service === 'termix') {
      kind = 'fleet_observability';
      config = { termix: { baseUrl: data.baseUrl.replace(/\/+$/, '') } };
    } else if (data.service === 'gatus') {
      kind = 'fleet_observability';
      config = { gatus: { baseUrl: data.baseUrl.replace(/\/+$/, '') } };
    } else if (data.service === 'beszel') {
      // Beszel (loxep-y64 §7 slice 1): origin-normalized, per this union's
      // Beszel/Dockhand doc comment.
      kind = 'fleet_observability';
      config = { beszel: { baseUrl: normalizeFleetBaseUrl(data.baseUrl) } };
    } else if (data.service === 'dockhand') {
      // Dockhand (loxep-hb7 §1.7): origin-normalized so a pasted `.../api`
      // URL never doubles once the adapter appends its own API path.
      kind = 'fleet_observability';
      config = { dockhand: { baseUrl: normalizeFleetBaseUrl(data.baseUrl) } };
    } else {
      // Pangolin (loxep-acj.1): baseUrl is the Integration API's own origin,
      // trimmed of a trailing slash like every self-hosted sibling; orgId is
      // the organization this connection reads, both non-secret config.
      kind = 'proxy';
      config = { pangolin: { baseUrl: data.baseUrl.replace(/\/+$/, ''), orgId: data.orgId } };
    }

    const created = await connections.createConnection(
      {
        provider: data.service,
        kind,
        name: data.name,
        config,
        createdByUserId: session.user.id
      },
      { actorUserId: session.user.id }
    );
    if (data.service === 'woocommerce') {
      await connections.setConnectionCredential(
        created.id,
        'woo_credentials',
        { consumerKey: data.consumerKey, consumerSecret: data.consumerSecret },
        { actorUserId: session.user.id }
      );
    } else if (data.service === 'medusa') {
      await connections.setConnectionCredential(
        created.id,
        'medusa_credentials',
        { apiToken: data.apiToken },
        { actorUserId: session.user.id }
      );
    } else if (data.service === 'invoiceninja') {
      await connections.setConnectionCredential(
        created.id,
        'invoiceninja_credentials',
        { apiToken: data.apiToken },
        { actorUserId: session.user.id }
      );
    } else if (data.service === 'reverb') {
      await connections.setConnectionCredential(
        created.id,
        'reverb_credentials',
        { personalAccessToken: data.personalAccessToken },
        { actorUserId: session.user.id }
      );
    } else if (data.service === 'cloudflare') {
      await connections.setConnectionCredential(
        created.id,
        'cloudflare_credentials',
        { apiToken: data.apiToken },
        { actorUserId: session.user.id }
      );
    } else if (data.service === 'purelymail') {
      await connections.setConnectionCredential(
        created.id,
        'purelymail_credentials',
        { apiToken: data.apiToken },
        { actorUserId: session.user.id }
      );
    } else if (data.service === 'tailscale') {
      // Two shapes of `tailscale_credentials` (loxep-50t §2.2a): the form
      // never sends fields for the branch not chosen, but the handler still
      // checks presence rather than trusting `mode` alone, matching the
      // Gatus branch's own posture below.
      if (data.mode === 'oauth_client') {
        if (data.clientId === undefined || data.clientSecret === undefined) {
          throw new Error('Tailscale OAuth client id and client secret are both required');
        }
        await connections.setConnectionCredential(
          created.id,
          'tailscale_credentials',
          { mode: 'oauth_client', clientId: data.clientId, clientSecret: data.clientSecret },
          { actorUserId: session.user.id }
        );
      } else {
        if (data.apiAccessToken === undefined) {
          throw new Error('Tailscale API access token is required');
        }
        await connections.setConnectionCredential(
          created.id,
          'tailscale_credentials',
          { mode: 'api_access_token', apiAccessToken: data.apiAccessToken },
          { actorUserId: session.user.id }
        );
      }
    } else if (data.service === 'termix') {
      await connections.setConnectionCredential(
        created.id,
        'termix_credentials',
        { username: data.username, password: data.password },
        { actorUserId: session.user.id }
      );
    } else if (data.service === 'gatus') {
      // Gatus (loxep-ovj.4): the pair is OPTIONAL — a legitimate Gatus
      // instance may be fully open or OIDC-secured, with no Basic credential
      // to store at all. `gatus_credentials` keeps the pair atomic when it IS
      // supplied; this handler enforces the same atomicity for the case a
      // caller supplied exactly one half (the form itself never does).
      if (data.username !== undefined && data.password !== undefined) {
        await connections.setConnectionCredential(
          created.id,
          'gatus_credentials',
          { username: data.username, password: data.password },
          { actorUserId: session.user.id }
        );
      } else if (data.username !== undefined || data.password !== undefined) {
        throw new Error(
          'Gatus username and password must be provided together, or both left blank'
        );
      }
      // else: no credential row at all — the instance is open or OIDC-secured.
    } else if (data.service === 'beszel') {
      // Beszel readonly user (loxep-y64 §7 slice 1) — email/password, never
      // called an API token anywhere on this path; Beszel issues none.
      await connections.setConnectionCredential(
        created.id,
        'beszel_credentials',
        { email: data.email, password: data.password },
        { actorUserId: session.user.id }
      );
    } else if (data.service === 'dockhand') {
      // Dockhand (loxep-hb7 §1.7) — an ordinary session login, not an API
      // token; Dockhand publishes none.
      await connections.setConnectionCredential(
        created.id,
        'dockhand_credentials',
        { username: data.username, password: data.password },
        { actorUserId: session.user.id }
      );
    } else {
      // Pangolin (loxep-acj.1) — the bearer key id/secret pair, atomic in
      // the pangolin_credentials bundle. baseUrl/orgId already landed in
      // config above.
      await connections.setConnectionCredential(
        created.id,
        'pangolin_credentials',
        { apiKeyId: data.apiKeyId, apiKeySecret: data.apiKeySecret },
        { actorUserId: session.user.id }
      );
    }
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

/** One referencing table's surviving row count (loxep-o7h). */
export interface ConnectionReferenceDto {
  table: string;
  label: string;
  count: number;
}

/**
 * Delete outcome. A refusal is DATA, not an exception: the browser needs the
 * per-table counts to explain why the account cannot be removed and to offer
 * archiving instead, and a thrown error would arrive as an opaque message.
 */
export type DeleteConnectionResultDto =
  | { deleted: true; id: string; deletedCredentials: number }
  | { deleted: false; id: string; total: number; references: ConnectionReferenceDto[] };

/**
 * Hard-delete an account that nothing references, credentials included.
 *
 * The domain service owns the rule (see `deleteConnection` in
 * `@loxep/domain`): zero references → the connection row and its encrypted
 * credential rows go; anything at all → `ConnectionInUseError`, translated
 * here into the refusal branch above.
 */
export const deleteConnection = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<DeleteConnectionResultDto> => {
    const [{ requireAdmin, getAdminServices }, { ConnectionInUseError }] = await Promise.all([
      import('@/server/admin'),
      import('@loxep/domain')
    ]);
    const session = await requireAdmin();
    try {
      const result = await getAdminServices().connections.deleteConnection(data.id, {
        actorUserId: session.user.id
      });
      return {
        deleted: true,
        id: result.id,
        deletedCredentials: result.deletedCredentials
      };
    } catch (error) {
      if (error instanceof ConnectionInUseError) {
        return {
          deleted: false,
          id: data.id,
          total: error.total,
          references: error.references.map((reference) => ({
            table: reference.table,
            label: reference.label,
            count: reference.count
          }))
        };
      }
      throw error;
    }
  });

/** Terminal retirement: keeps every referencing record, stops all use. */
export const archiveConnection = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ id: string; status: ConnectionStatus }> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    const session = await requireAdmin();
    const connection = await getAdminServices().connections.archiveConnection(data.id, {
      actorUserId: session.user.id
    });
    return { id: connection.id, status: connection.status };
  });

/** Restores an archived account to `disabled` — re-enabling stays deliberate. */
export const unarchiveConnection = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ id: string; status: ConnectionStatus }> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    const session = await requireAdmin();
    const connection = await getAdminServices().connections.unarchiveConnection(data.id, {
      actorUserId: session.user.id
    });
    return { id: connection.id, status: connection.status };
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

/**
 * Account provisioning policy (ADR-0024). Non-secret by construction — this is
 * the same registered setting `/settings/application` can already show as raw
 * JSON; this DTO exists so the surface can offer switches and copy instead.
 */
export interface AuthProvisioningDto {
  newUsers: { magicLink: 'open' | 'closed'; oidc: 'open' | 'closed' };
  magicLinkEmailDomains: string[];
  oidcAdminClaim: {
    claim: string | null;
    adminValues: string[];
    applyOn: 'create' | 'every_sign_in';
  };
  /**
   * False → the installation has no administrator yet, so `@loxep/auth`
   * force-opens provisioning regardless of the stored policy until one exists.
   * The surface must say so rather than showing a closed policy that is not in
   * force.
   */
  installationHasAdmin: boolean;
  /** The signed-in admin's own email domain, for the allowlist hint. */
  currentUserEmailDomain: string | null;
}

export const fetchAuthProvisioning = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AuthProvisioningDto> => {
    const [{ requireAdmin, getAdminServices }, { installationHasAdmin, emailDomain }] =
      await Promise.all([import('@/server/admin'), import('@loxep/auth')]);
    const session = await requireAdmin();
    const { settings, handle } = getAdminServices();
    const [value, hasAdmin] = await Promise.all([
      settings.get(authProvisioningSetting),
      installationHasAdmin(handle)
    ]);
    return {
      ...value,
      installationHasAdmin: hasAdmin,
      currentUserEmailDomain: emailDomain(session.user.email)
    };
  }
);

const provisioningStance = z.enum(['open', 'closed']);

/** Bare domain, as typed: `example.com`, never `@example.com` or a URL. */
const emailDomainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
    'Enter a bare domain such as example.com'
  );

const updateAuthProvisioningInput = z.strictObject({
  newUsers: z.strictObject({ magicLink: provisioningStance, oidc: provisioningStance }),
  magicLinkEmailDomains: z.array(emailDomainSchema).max(64),
  oidcAdminClaim: z.strictObject({
    claim: z.string().trim().min(1).max(200).nullable(),
    adminValues: z.array(z.string().trim().min(1).max(200)).max(64),
    applyOn: z.enum(['create', 'every_sign_in'])
  })
});

/**
 * Admin write for the provisioning policy. Goes through the ordinary
 * registered-setting path, so `SettingsService.set` validates against the
 * domain schema and appends the redacted `settings.update` audit event.
 */
export const updateAuthProvisioning = createServerFn({ method: 'POST' })
  .inputValidator(updateAuthProvisioningInput)
  .handler(async ({ data }): Promise<AuthProvisioningDto> => {
    const [{ requireAdmin, getAdminServices }, { installationHasAdmin, emailDomain }] =
      await Promise.all([import('@/server/admin'), import('@loxep/auth')]);
    const session = await requireAdmin();
    const { settings, handle } = getAdminServices();
    const value = await settings.set(authProvisioningSetting, data, {
      actorUserId: session.user.id
    });
    return {
      ...value,
      installationHasAdmin: await installationHasAdmin(handle),
      currentUserEmailDomain: emailDomain(session.user.email)
    };
  });

/**
 * Create a user directly — the escape hatch a closed installation uses to add
 * people (ADR-0024 §4). There is deliberately no invite system: this writes an
 * ordinary user row through Better Auth's admin plugin, and the person then
 * signs in through whichever method they normally would. Because they now
 * exist, both provisioning enforcement layers pass them through untouched.
 *
 * No password is sent: email+password is disabled (ADR-0007), and the admin
 * plugin's `password` field is optional for exactly this case.
 */
export const createUserAsAdmin = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({
      email: z.email().max(320),
      name: z.string().trim().min(1).max(200),
      role: z.enum(['admin', 'member'])
    })
  )
  .handler(async ({ data }): Promise<{ id: string }> => {
    const [{ requireAdmin }, { getAuth }, { getRequestHeaders }] = await Promise.all([
      import('@/server/admin'),
      import('@/server/auth'),
      import('@tanstack/react-start/server')
    ]);
    await requireAdmin();
    const result = await getAuth().api.createUser({
      body: { email: data.email, name: data.name, role: data.role },
      headers: getRequestHeaders()
    });
    return { id: result.user.id };
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
// Onboarding: OIDC auto-provisioning prompt (ADR-0024 §2, loxep-yk8)
//
// The owner ruling that confirmed auth.provisioning's closed-for-both default
// rejected defaulting `oidc` to 'open', and addressed the discoverability gap
// instead with this dismissible /dashboard/overview card. It is shown once —
// right after the installation's first administrator exists — and only to an
// admin whose deployment could actually act on it: OIDC has to be
// bootstrap-configured, and `newUsers.oidc` has to still be closed. Dismissal
// (with or without enabling) is permanent, tracked by the additive
// `auth.onboarding_oidc_prompt_dismissed` setting — independent of
// `auth.provisioning` itself, so a later reset of one never has to reason
// about the other's shape.
// ---------------------------------------------------------------------------

export interface OnboardingOidcPromptDto {
  /** Whether the card's conditions are all met right now. */
  show: boolean;
}

/**
 * `requireSession` rather than `requireAdmin`: a member landing on
 * `/dashboard/overview` must get a normal `{show: false}` response, not a 403
 * — this is a discoverability nicety, not a protected resource, and the
 * dashboard route is not admin-gated.
 */
export const fetchOnboardingOidcPrompt = createServerFn({ method: 'GET' }).handler(
  async (): Promise<OnboardingOidcPromptDto> => {
    const [
      { requireSession, getAdminServices },
      { hasRole, installationHasAdmin, readProvisioningPolicy },
      { getLoginPaths }
    ] = await Promise.all([
      import('@/server/admin'),
      import('@loxep/auth'),
      import('@/server/auth')
    ]);
    const session = await requireSession();
    if (!hasRole(session, 'admin')) return { show: false };

    const { settings, handle } = getAdminServices();
    const [dismissed, policy, hasAdmin] = await Promise.all([
      settings.get(authOnboardingOidcPromptDismissedSetting),
      readProvisioningPolicy(handle),
      installationHasAdmin(handle)
    ]);
    const show =
      !dismissed && hasAdmin && getLoginPaths().oidc && policy.newUsers.oidc === 'closed';
    return { show };
  }
);

/**
 * The card's primary action: flip `auth.provisioning.newUsers.oidc` to
 * `'open'`, preserving every other field of the stored policy untouched, and
 * mark the prompt dismissed in the same request so it cannot reappear.
 */
export const enableOidcOnboarding = createServerFn({ method: 'POST' }).handler(
  async (): Promise<OnboardingOidcPromptDto> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    const session = await requireAdmin();
    const { settings } = getAdminServices();

    const current = await settings.get(authProvisioningSetting);
    await settings.set(
      authProvisioningSetting,
      { ...current, newUsers: { ...current.newUsers, oidc: 'open' } },
      { actorUserId: session.user.id }
    );
    await settings.set(authOnboardingOidcPromptDismissedSetting, true, {
      actorUserId: session.user.id
    });
    return { show: false };
  }
);

/** The card's secondary action: dismiss without changing the policy. */
export const dismissOnboardingOidcPrompt = createServerFn({ method: 'POST' }).handler(
  async (): Promise<OnboardingOidcPromptDto> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    const session = await requireAdmin();
    await getAdminServices().settings.set(authOnboardingOidcPromptDismissedSetting, true, {
      actorUserId: session.user.id
    });
    return { show: false };
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

/**
 * Admin write for ONE registered application setting (loxep-fev).
 *
 * The browser cannot run a setting's Zod schema — the registry lives in
 * `@loxep/domain`, server-side — so the dialog sends the operator's raw JSON
 * text and this handler is the only validator: `settings.setByKey` rejects
 * any key that `defineSetting()` did not register and parses the value
 * through that definition's schema before a row is written. The domain
 * service appends the `settings.create`/`settings.update` audit event; there
 * is deliberately no separate audit call here.
 *
 * Setting values are non-secret by definition (ADR-0016/ADR-0019 — secret
 * material lives in the secrets service), so unlike credential forms this one
 * both reads the current value back and echoes the stored value on success.
 */
const updateApplicationSettingInput = z.strictObject({
  key: z.string().min(1),
  /** Raw JSON text as typed in the dialog; parsed and validated here. */
  valueJson: z.string()
});

export const updateApplicationSetting = createServerFn({ method: 'POST' })
  .inputValidator(updateApplicationSettingInput)
  .handler(async ({ data }): Promise<RegisteredSettingDto> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    const session = await requireAdmin();

    let value: unknown;
    try {
      value = JSON.parse(data.valueJson) as unknown;
    } catch (error) {
      throw new Error(
        `Value is not valid JSON: ${error instanceof Error ? error.message : 'parse failed'}`,
        { cause: error }
      );
    }

    const entry = await getAdminServices().settings.setByKey(data.key, value, {
      actorUserId: session.user.id
    });
    return {
      key: entry.key,
      description: entry.description,
      schemaVersion: entry.schemaVersion,
      isSet: entry.isSet,
      value: entry.value as JsonValue,
      updatedAt: iso(entry.updatedAt)
    };
  });

// ---------------------------------------------------------------------------
// Integration catalog visibility (loxep-dgg)
// ---------------------------------------------------------------------------

/**
 * The `integrations.enabled` map: which integration ids are hidden from the
 * catalog grid, connection-add options, and any other provider-enumerating
 * surface. Member-readable — the catalog itself is member-visible — so
 * `/settings/integrations` and `/settings/connections` can filter for every
 * signed-in user, not only admins. An id absent from the map, or mapped
 * `true`, is shown; only an explicit `false` hides it. See
 * `integrationsEnabledSetting`'s own doc in `@loxep/domain` for the full
 * PROVISIONAL-default reasoning (all-on, so an absent setting never hides a
 * provider an existing operator already uses).
 */
export const fetchIntegrationsEnabled = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Record<string, boolean>> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    return getAdminServices().settings.get(integrationsEnabledSetting);
  }
);

const setIntegrationEnabledInput = z.strictObject({
  id: z.string().min(1),
  enabled: z.boolean()
});

/**
 * Admin toggle for ONE integration's catalog visibility (loxep-dgg). Reads
 * the current map, then either deletes the id (re-enabling — the map's own
 * "absence means shown" rule keeps the stored map minimal and future-proof,
 * see the setting's doc) or sets it to `false` (disabling), and writes the
 * whole map back through the registered setting's own schema.
 *
 * This is a DISPLAY toggle only: it never touches `connections` rows or
 * worker job state. An already-connected provider's existing connections
 * keep syncing and its jobs keep running exactly as before either way —
 * disabling only changes what the catalog and connection-add surfaces show.
 */
export const setIntegrationEnabled = createServerFn({ method: 'POST' })
  .inputValidator(setIntegrationEnabledInput)
  .handler(async ({ data }): Promise<Record<string, boolean>> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    const session = await requireAdmin();
    const { settings } = getAdminServices();

    const current = await settings.get(integrationsEnabledSetting);
    const next = { ...current };
    if (data.enabled) {
      delete next[data.id];
    } else {
      next[data.id] = false;
    }

    return settings.set(integrationsEnabledSetting, next, { actorUserId: session.user.id });
  });

// ---------------------------------------------------------------------------
// Provider write-authorization policy (Pangolin chain design M3, loxep-acj.3)
// ---------------------------------------------------------------------------

/**
 * The `infrastructure.provider_write_policy` map: every connection id that
 * has an EXPLICIT tier stored. A connection absent from this map is
 * `'read_only'` (`resolveProviderWritePolicy`'s own fallback, applied
 * client-side by the connections table) — a fresh install cannot write to
 * any provider connection without an explicit, audited flip. Member-readable
 * like `fetchIntegrationsEnabled`: knowing a connection's write tier is no
 * more sensitive than knowing its sync status; only the FLIP below is
 * admin-only.
 */
export const fetchProviderWritePolicy = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Record<string, ProviderWritePolicyTier>> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    return getAdminServices().settings.get(providerWritePolicySetting);
  }
);

const setConnectionWritePolicyInput = z.strictObject({
  connectionId: z.uuid(),
  tier: z.enum(PROVIDER_WRITE_POLICY_TIERS)
});

/**
 * Admin-only flip of ONE connection's write-authorization tier (design rule
 * 1: "Flipping it is an admin-only server function that writes an
 * audit_events row in the same transaction"). `SettingsService.set` already
 * provides that transaction/audit discipline (`settings.ts`'s `write()`) —
 * this function adds no bespoke transaction, it inherits one.
 *
 * Reads the current map and writes back the whole map with one key changed,
 * the same read-then-set shape `setIntegrationEnabled` and
 * `setTailscaleDeviceIgnored` already use for a settings-backed map. Setting
 * a connection back to `'read_only'` REMOVES its key rather than storing the
 * literal value, keeping the stored map minimal — an absent key already
 * means `read_only`.
 */
export const setConnectionWritePolicy = createServerFn({ method: 'POST' })
  .inputValidator(setConnectionWritePolicyInput)
  .handler(async ({ data }): Promise<Record<string, ProviderWritePolicyTier>> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    const session = await requireAdmin();
    const { settings } = getAdminServices();

    const current = await settings.get(providerWritePolicySetting);
    const next = { ...current };
    if (data.tier === 'read_only') {
      delete next[data.connectionId];
    } else {
      next[data.connectionId] = data.tier;
    }

    return settings.set(providerWritePolicySetting, next, { actorUserId: session.user.id });
  });

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
  /** ADR-0023: the class dimension; `event_type` null means any type in it. */
  eventClass: string;
  eventType: string | null;
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
      eventClass: row.eventClass,
      eventType: row.eventType,
      monitorTargetId: row.monitorTargetId,
      endpointId: row.endpointId,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt)
    }));
  }
);

const notificationEventClassSchema = z.enum(
  NOTIFICATION_EVENT_CLASS_VALUES as [string, ...string[]]
);

const createNotificationRuleInput = z.strictObject({
  name: z.string().trim().min(1),
  endpointId: z.uuid(),
  enabled: z.boolean(),
  eventClass: notificationEventClassSchema,
  eventType: z.string().min(1).nullable(),
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
      eventClass: data.eventClass as NotificationEventClass,
      eventType: data.eventType,
      monitorTargetId: data.monitorTargetId,
      createdByUserId: session.user.id
    });
    return { id: rule.id };
  });

const updateNotificationRuleInput = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  eventClass: notificationEventClassSchema.optional(),
  eventType: z.string().min(1).nullable().optional(),
  monitorTargetId: z.uuid().nullable().optional()
});

export const updateNotificationRule = createServerFn({ method: 'POST' })
  .inputValidator(updateNotificationRuleInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getNotificationsService } = await import('@/server/admin');
    await requireAdmin();
    const { id, ...patch } = data;
    const notifications = await getNotificationsService();
    const { eventClass, ...rest } = patch;
    const rule = await notifications.updateRule(id, {
      ...rest,
      ...(eventClass === undefined ? {} : { eventClass: eventClass as NotificationEventClass })
    });
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
  eventClass: string;
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
    const eventIds = [...new Set(deliveries.map((row) => row.notificationEventId))];
    const [endpoints, events] = await Promise.all([
      handle.db.query.notificationEndpoints.findMany({
        where: (table, { inArray }) => inArray(table.id, endpointIds),
        columns: { id: true, name: true }
      }),
      // ADR-0023: deliveries carry a subject-neutral notification event, so
      // the class/type come from the ledger instead of a market_events join.
      handle.db.query.notificationEvents.findMany({
        where: (table, { inArray }) => inArray(table.id, eventIds),
        columns: { id: true, eventClass: true, eventType: true }
      })
    ]);
    const endpointNameById = new Map(endpoints.map((row) => [row.id, row.name]));
    const eventById = new Map(events.map((row) => [row.id, row]));
    return deliveries.map((row) => ({
      id: row.id,
      eventClass: eventById.get(row.notificationEventId)?.eventClass ?? 'unknown',
      eventType: eventById.get(row.notificationEventId)?.eventType ?? 'unknown',
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

// ---------------------------------------------------------------------------
// The notification feed (the product-shell bell)
// ---------------------------------------------------------------------------

export interface NotificationFeedItemDto {
  id: string;
  eventClass: string;
  eventType: string;
  subjectType: string;
  subjectId: string;
  occurredAt: string;
  title: string;
  body: string;
  /** In-app deep link for the subject, when one exists. */
  href: string | null;
  /** How many endpoints this event was actually delivered to. */
  deliveredCount: number;
}

const NOTIFICATION_FEED_LIMIT = 40;

/**
 * Deep link per subject type. Only routes that exist are returned — an event
 * whose subject has no surface yet renders without a link rather than with a
 * broken one.
 */
function notificationFeedHref(
  subjectType: string,
  subjectId: string,
  payload: Record<string, unknown>
): string | null {
  switch (subjectType) {
    case 'market_event': {
      const itemId = payload['marketplaceItemId'];
      return typeof itemId === 'string' && itemId.length > 0 ? `/market/items/${itemId}` : null;
    }
    case 'acquisition':
      return `/inventory/acquisitions/${subjectId}`;
    case 'order':
      return `/commerce/orders/${subjectId}`;
    case 'document':
      return '/finance/import';
    case 'connection':
    case 'notification_endpoint':
    case 'storage_backend':
      return '/settings/overview';
    default:
      return null;
  }
}

/**
 * Recent notifiable events for the product shell's bell (loxep-oii).
 *
 * Reads the real `notification_events` ledger and renders each row with the
 * SAME pure renderer that produces the outbound ntfy message, so the bell and
 * the push cannot describe the same fact differently. It deliberately does not
 * filter on deliveries: an installation with no transport configured still has
 * a feed, which is the property the polymorphic-delivery alternative could not
 * offer (ADR-0023).
 */
export const fetchNotificationFeed = createServerFn({ method: 'GET' }).handler(
  async (): Promise<NotificationFeedItemDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const events = await handle.db.query.notificationEvents.findMany({
      orderBy: (table, { desc }) => [desc(table.occurredAt), desc(table.id)],
      limit: NOTIFICATION_FEED_LIMIT
    });
    if (events.length === 0) return [];
    const eventIds = events.map((row) => row.id);
    const deliveries = await handle.db.query.notificationDeliveries.findMany({
      where: (table, { inArray }) => inArray(table.notificationEventId, eventIds),
      columns: { notificationEventId: true, deliveredAt: true }
    });
    const deliveredCounts = new Map<string, number>();
    for (const delivery of deliveries) {
      if (delivery.deliveredAt === null) continue;
      deliveredCounts.set(
        delivery.notificationEventId,
        (deliveredCounts.get(delivery.notificationEventId) ?? 0) + 1
      );
    }
    return events.map((row) => {
      const message = renderNotificationEventMessage(row);
      const payload =
        typeof row.payload === 'object' && row.payload !== null && !Array.isArray(row.payload)
          ? (row.payload as Record<string, unknown>)
          : {};
      return {
        id: row.id,
        eventClass: row.eventClass,
        eventType: row.eventType,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        occurredAt: iso(row.occurredAt),
        title: message.title,
        body: message.body,
        href: notificationFeedHref(row.subjectType, row.subjectId, payload),
        deliveredCount: deliveredCounts.get(row.id) ?? 0
      };
    });
  }
);
