/**
 * The integrations catalog: the typed registry of services Loxep can talk to.
 *
 * ONE source of truth for two surfaces:
 *
 * - `/settings/integrations` renders a card per entry — name, description,
 *   status badge, and the set-up/manage action;
 * - `/settings/connections` groups existing accounts by entry and offers
 *   "Add account" only for services whose set-up is complete.
 *
 * Because both surfaces read this registry, `connections.provider` and
 * `connections.kind` are SYSTEM-SUPPLIED facts picked from an entry — an
 * operator never types either one, and no surface offers a raw JSON config
 * box. A new service becomes available everywhere by adding one entry here
 * plus its guided form.
 *
 * Nothing in this module reads or holds credential material: statuses are
 * derived from metadata the settings server functions already return
 * (keyset presence, connection rows, endpoint rows).
 */
import type { ConnectionDto, NotificationEndpointDto } from '@/server/admin-functions';
import type { EbayKeysetStatus } from '@/server/ebay-oauth';

export type IntegrationServiceId = 'ebay' | 'woocommerce' | 'medusa' | 'ntfy';

/** Catalog grouping — purely presentational ordering for the catalog page. */
export type IntegrationCategory = 'Marketplaces' | 'Stores' | 'Notifications';

/**
 * How complete a service's set-up is:
 * `ready` — usable now; `partial` — set up but something still blocks use;
 * `unconfigured` — nothing has been set up yet.
 */
export type IntegrationStatusTone = 'ready' | 'partial' | 'unconfigured';

export interface IntegrationStatus {
  tone: IntegrationStatusTone;
  label: string;
  /** Extra facts worth a badge (environment, account counts) — never secrets. */
  details: string[];
  /**
   * A second, attention-worthy badge distinct from the plain `details` chips —
   * currently used to flag the eBay application keyset resolving from the
   * `~/.config/loxep/ebay-sandbox.env` development file rather than the
   * stored application secret, so a fresh install never reads as configured
   * from an empty database. Metadata only, never a credential value.
   */
  warning?: { label: string; title: string };
}

/**
 * Everything a status resolver may read. `ebayKeyset` is `null` for
 * non-administrators, because its server function is admin-only and the
 * catalog never fetches it for members.
 */
export interface IntegrationStatusInput {
  connections: ConnectionDto[];
  endpoints: NotificationEndpointDto[];
  ebayKeyset: EbayKeysetStatus | null;
}

/** The guided form an "Add account" action opens. */
export type IntegrationAccountForm = 'ebay-consent' | 'woo-api' | 'medusa-api';

export interface IntegrationAccountSetup {
  /** `connections.provider` written for accounts of this service. */
  provider: string;
  /** `connections.kind` written for accounts of this service. */
  kind: string;
  form: IntegrationAccountForm;
  addLabel: string;
  /** What the guided form asks for, shown above its fields. */
  formHint: string;
  /** Non-null when a new account cannot be added yet, and why. */
  blockedReason: (input: IntegrationStatusInput) => string | null;
}

/**
 * The set-up/manage action on a catalog card: either a link to the settings
 * page that owns the service, or the eBay keyset panel hosted on the catalog
 * page itself.
 */
export type IntegrationManageAction =
  | { kind: 'route'; to: string; label: string }
  | { kind: 'ebay-keyset' };

export interface IntegrationService {
  id: IntegrationServiceId;
  name: string;
  category: IntegrationCategory;
  /** One or two lines; describes the service, not the roadmap. */
  description: string;
  manage: IntegrationManageAction;
  /** `null` for services that are not represented by connection rows. */
  accounts: IntegrationAccountSetup | null;
  status: (input: IntegrationStatusInput) => IntegrationStatus;
}

function accountsFor(connections: ConnectionDto[], provider: string): ConnectionDto[] {
  return connections.filter((connection) => connection.provider === provider);
}

function accountCountDetail(count: number): string {
  return count === 1 ? '1 account' : `${count} accounts`;
}

/**
 * Shown when `EbayKeysetStatus.source` is `'dev-file'` — the keyset resolved
 * from the local `~/.config/loxep/ebay-sandbox.env` fallback rather than the
 * application secret stored in PostgreSQL. Documented precedence
 * (`apps/docs/.../configuration-and-secrets.md`): a stored secret always
 * wins, and this file exists only for local sandbox development, so a fresh
 * install must never read as "configured" the same way a stored secret does.
 */
const DEV_FILE_KEYSET_WARNING = {
  label: 'Keyset: dev file',
  title:
    "Resolved from the local ~/.config/loxep/ebay-sandbox.env development fallback, not a stored application secret. A stored secret always takes precedence over this file; it exists for local sandbox development only and does not carry to another install or a fresh database."
};

export const integrationServices: IntegrationService[] = [
  {
    id: 'ebay',
    name: 'eBay',
    category: 'Marketplaces',
    description:
      'Watch listings, searches, and sellers on eBay, and optionally read an account’s order history. One application keyset covers the installation; each eBay account is then connected through eBay’s consent screen, at the access level you choose.',
    manage: { kind: 'ebay-keyset' },
    accounts: {
      provider: 'ebay',
      kind: 'marketplace_account',
      form: 'ebay-consent',
      addLabel: 'Add eBay account',
      formHint:
        'Name the account, choose how much access to ask eBay for, and optionally attribute it to an economic entity. eBay’s consent screen opens next and binds the account itself; order access can also be granted later from the account’s actions.',
      blockedReason: ({ ebayKeyset }) => {
        if (ebayKeyset === null) {
          return 'Only an administrator can set up the eBay application keyset.';
        }
        if (!ebayKeyset.configured) {
          return 'Set up the eBay application keyset before adding an account.';
        }
        if (!ebayKeyset.ruNameConfigured) {
          return 'The eBay keyset has no redirect URL name, so the consent screen cannot open.';
        }
        return null;
      }
    },
    status: ({ ebayKeyset, connections }) => {
      const count = accountsFor(connections, 'ebay').length;
      if (ebayKeyset === null) {
        return count > 0
          ? { tone: 'ready', label: 'In use', details: [accountCountDetail(count)] }
          : { tone: 'unconfigured', label: 'Not set up', details: [] };
      }
      if (!ebayKeyset.configured) {
        return { tone: 'unconfigured', label: 'Keyset not configured', details: [] };
      }
      const details = [
        ...(ebayKeyset.environment === null ? [] : [ebayKeyset.environment]),
        accountCountDetail(count)
      ];
      // A dev-machine fallback resolving over an empty database must never
      // read as "configured" the same way a stored secret does — flag it with
      // its own badge rather than folding it into the plain `details` chips.
      const warning =
        ebayKeyset.source === 'dev-file' ? { ...DEV_FILE_KEYSET_WARNING } : undefined;
      return ebayKeyset.ruNameConfigured
        ? { tone: 'ready', label: 'Keyset configured', details, ...(warning && { warning }) }
        : {
            tone: 'partial',
            label: 'Redirect URL name missing',
            details,
            ...(warning && { warning })
          };
    }
  },
  {
    id: 'woocommerce',
    name: 'WooCommerce',
    category: 'Stores',
    description:
      'Read orders and products from a self-hosted WooCommerce store over its REST API. Each store is one connection: its URL plus the read-only key pair the store issues.',
    manage: { kind: 'route', to: '/settings/connections', label: 'Manage stores' },
    accounts: {
      provider: 'woocommerce',
      kind: 'store_account',
      form: 'woo-api',
      addLabel: 'Add WooCommerce store',
      formHint:
        'The store URL is kept as ordinary connection configuration; the consumer key and secret are stored encrypted and never shown again.',
      blockedReason: () => null
    },
    status: ({ connections }) => {
      const count = accountsFor(connections, 'woocommerce').length;
      return count > 0
        ? { tone: 'ready', label: 'Connected', details: [accountCountDetail(count)] }
        : { tone: 'unconfigured', label: 'No stores connected', details: [] };
    }
  },
  {
    id: 'medusa',
    name: 'Medusa',
    category: 'Stores',
    description:
      'Read orders and products from a Medusa backend over its Admin API. Each backend is one connection: its base URL plus a secret API key created in the Medusa dashboard.',
    manage: { kind: 'route', to: '/settings/connections', label: 'Manage backends' },
    accounts: {
      provider: 'medusa',
      kind: 'store_account',
      form: 'medusa-api',
      addLabel: 'Add Medusa backend',
      formHint:
        'The backend URL is kept as ordinary connection configuration; the secret API key is stored encrypted and never shown again.',
      blockedReason: () => null
    },
    status: ({ connections }) => {
      const count = accountsFor(connections, 'medusa').length;
      return count > 0
        ? { tone: 'ready', label: 'Connected', details: [accountCountDetail(count)] }
        : { tone: 'unconfigured', label: 'No backends connected', details: [] };
    }
  },
  {
    id: 'ntfy',
    name: 'ntfy',
    category: 'Notifications',
    description:
      'Deliver notifications by posting to an ntfy server, self-hosted or hosted. Endpoints and the rules that route events to them are managed on the notifications page.',
    manage: { kind: 'route', to: '/settings/notifications', label: 'Manage endpoints' },
    accounts: null,
    status: ({ endpoints }) => {
      const count = endpoints.filter((endpoint) => endpoint.provider === 'ntfy').length;
      if (count === 0) {
        return { tone: 'unconfigured', label: 'No endpoints', details: [] };
      }
      return {
        tone: 'ready',
        label: 'Configured',
        details: [count === 1 ? '1 endpoint' : `${count} endpoints`]
      };
    }
  }
];

/** Catalog order used by the catalog page's section headings. */
export const integrationCategories: IntegrationCategory[] = [
  'Marketplaces',
  'Stores',
  'Notifications'
];

export function getIntegrationService(id: IntegrationServiceId): IntegrationService {
  const service = integrationServices.find((entry) => entry.id === id);
  if (service === undefined) {
    throw new Error(`unknown integration service "${id}"`);
  }
  return service;
}

/** The catalog entry a connection row belongs to, or `null` for unknown providers. */
export function integrationServiceForProvider(provider: string): IntegrationService | null {
  return integrationServices.find((entry) => entry.accounts?.provider === provider) ?? null;
}

/** Catalog entries that can own connection rows, in catalog order. */
export const connectableIntegrationServices: IntegrationService[] = integrationServices.filter(
  (service) => service.accounts !== null
);
