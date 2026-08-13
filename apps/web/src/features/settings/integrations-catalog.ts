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
import type { EtsyKeysetStatus } from '@/server/etsy-oauth';

export type IntegrationServiceId =
  | 'ebay'
  | 'etsy'
  | 'reverb'
  | 'woocommerce'
  | 'medusa'
  | 'invoiceninja'
  | 'cloudflare'
  | 'purelymail'
  | 'tailscale'
  | 'termix'
  | 'ntfy';

/** Catalog grouping — purely presentational ordering for the catalog page. */
export type IntegrationCategory =
  | 'Marketplaces'
  | 'Stores'
  | 'Billing'
  | 'Infrastructure'
  | 'Notifications';

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
  /** `null` for non-administrators, mirroring `ebayKeyset`. */
  etsyKeyset: EtsyKeysetStatus | null;
}

/** The guided form an "Add account" action opens. */
export type IntegrationAccountForm =
  | 'ebay-consent'
  | 'etsy-consent'
  | 'reverb-api'
  | 'woo-api'
  | 'medusa-api'
  | 'invoiceninja-api'
  | 'cloudflare-api'
  | 'purelymail-api'
  | 'tailscale-api'
  | 'termix-api';

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
  | { kind: 'ebay-keyset' }
  | { kind: 'etsy-keyset' };

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

/**
 * A service's live accounts. Archived accounts are excluded (loxep-o7h):
 * they are retired records kept so their history resolves, so counting them
 * would report a service as connected on the strength of an account that can
 * no longer do anything.
 */
function accountsFor(connections: ConnectionDto[], provider: string): ConnectionDto[] {
  return connections.filter(
    (connection) => connection.provider === provider && connection.status !== 'archived'
  );
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
    'Resolved from the local ~/.config/loxep/ebay-sandbox.env development fallback, not a stored application secret. A stored secret always takes precedence over this file; it exists for local sandbox development only and does not carry to another install or a fresh database.'
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
      const warning = ebayKeyset.source === 'dev-file' ? { ...DEV_FILE_KEYSET_WARNING } : undefined;
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
    id: 'etsy',
    name: 'Etsy',
    category: 'Marketplaces',
    description:
      'Watch listings and a shop’s active catalogue on Etsy. One application keyset covers the installation; each Etsy shop is then connected through Etsy’s PKCE consent screen. Etsy has no sandbox — everything here runs against a real, approved Developer Portal app.',
    manage: { kind: 'etsy-keyset' },
    accounts: {
      provider: 'etsy',
      kind: 'marketplace_account',
      form: 'etsy-consent',
      addLabel: 'Add Etsy shop',
      formHint:
        'Name the shop, give its Etsy shop id, and choose how much access to ask Etsy for. Etsy’s consent screen opens next and binds the shop itself.',
      blockedReason: ({ etsyKeyset }) => {
        if (etsyKeyset === null) {
          return 'Only an administrator can set up the Etsy application keyset.';
        }
        if (!etsyKeyset.configured) {
          return 'Set up the Etsy application keyset before adding a shop.';
        }
        return null;
      }
    },
    status: ({ etsyKeyset, connections }) => {
      const count = accountsFor(connections, 'etsy').length;
      if (etsyKeyset === null) {
        return count > 0
          ? { tone: 'ready', label: 'In use', details: [accountCountDetail(count)] }
          : { tone: 'unconfigured', label: 'Not set up', details: [] };
      }
      if (!etsyKeyset.configured) {
        return { tone: 'unconfigured', label: 'Keyset not configured', details: [] };
      }
      const details = [accountCountDetail(count)];
      const warning =
        etsyKeyset.source === 'dev-file'
          ? {
              label: 'Keyset: dev file',
              title:
                'Resolved from the local ~/.config/loxep/etsy-sandbox.env development fallback, not a stored application secret. Etsy has no sandbox, so this file holds a real approved app’s credentials for local development only — a stored secret always takes precedence over it.'
            }
          : undefined;
      return { tone: 'ready', label: 'Keyset configured', details, ...(warning && { warning }) };
    }
  },
  {
    id: 'reverb',
    name: 'Reverb',
    category: 'Marketplaces',
    description:
      'Watch listings and your own catalogue on Reverb, the musical-gear marketplace. Each account connects with a self-service Personal Access Token minted in your own Reverb account settings — no application review, no approval wait.',
    manage: { kind: 'route', to: '/settings/connections', label: 'Manage accounts' },
    accounts: {
      provider: 'reverb',
      kind: 'marketplace_account',
      form: 'reverb-api',
      addLabel: 'Add Reverb account',
      formHint:
        'The Personal Access Token is stored encrypted and never shown again. Reverb has no separate application keyset and no shop id to enter — the token itself identifies the account.',
      blockedReason: () => null
    },
    status: ({ connections }) => {
      const count = accountsFor(connections, 'reverb').length;
      return count > 0
        ? { tone: 'ready', label: 'Connected', details: [accountCountDetail(count)] }
        : { tone: 'unconfigured', label: 'No accounts connected', details: [] };
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
    id: 'invoiceninja',
    name: 'Invoice Ninja',
    category: 'Billing',
    description:
      'Push Loxep-billed invoice drafts to a self-hosted Invoice Ninja instance for rendering, delivery, and payment collection. Loxep records the billable facts and amounts; Invoice Ninja owns the customer-visible invoice number, PDFs, email, and payment links.',
    manage: { kind: 'route', to: '/settings/connections', label: 'Manage instances' },
    accounts: {
      provider: 'invoiceninja',
      kind: 'billing_account',
      form: 'invoiceninja-api',
      addLabel: 'Add Invoice Ninja instance',
      formHint:
        'The instance URL is kept as ordinary connection configuration; the company API token is stored encrypted and never shown again.',
      blockedReason: () => null
    },
    status: ({ connections }) => {
      const count = accountsFor(connections, 'invoiceninja').length;
      return count > 0
        ? { tone: 'ready', label: 'Connected', details: [accountCountDetail(count)] }
        : { tone: 'unconfigured', label: 'No instances connected', details: [] };
    }
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    category: 'Infrastructure',
    description:
      'Give the Infrastructure control plane a scoped API token so it can read a domain’s DNS records at Cloudflare, compute the desired record set, and flag drift on a periodic sweep. Loxep never proxies a mail record under any circumstance. Each Cloudflare account is one connection.',
    manage: { kind: 'route', to: '/settings/connections', label: 'Manage DNS accounts' },
    accounts: {
      provider: 'cloudflare',
      kind: 'dns',
      form: 'cloudflare-api',
      addLabel: 'Add Cloudflare account',
      formHint:
        'A scoped API token — never the legacy global API key — is stored encrypted and never shown again. The account id is optional and kept as ordinary connection configuration.',
      blockedReason: () => null
    },
    status: ({ connections }) => {
      const count = accountsFor(connections, 'cloudflare').length;
      return count > 0
        ? { tone: 'ready', label: 'Connected', details: [accountCountDetail(count)] }
        : { tone: 'unconfigured', label: 'No accounts connected', details: [] };
    }
  },
  {
    id: 'purelymail',
    name: 'Purelymail',
    category: 'Infrastructure',
    description:
      'Give the Infrastructure control plane a Purelymail API token so it can register mail domains, poll for delegation, and sync mailboxes from a template. The required DNS records (MX, SPF, three DKIM keys, and a DMARC CNAME) are computed and applied through the same DNS connection — Loxep never proxies them.',
    manage: { kind: 'route', to: '/settings/connections', label: 'Manage mail accounts' },
    accounts: {
      provider: 'purelymail',
      kind: 'mail',
      form: 'purelymail-api',
      addLabel: 'Add Purelymail account',
      formHint:
        'The API token is stored encrypted and never shown again. Purelymail exposes no account identifier of its own, so there is no connection configuration beyond the account’s name.',
      blockedReason: () => null
    },
    status: ({ connections }) => {
      const count = accountsFor(connections, 'purelymail').length;
      return count > 0
        ? { tone: 'ready', label: 'Connected', details: [accountCountDetail(count)] }
        : { tone: 'unconfigured', label: 'No accounts connected', details: [] };
    }
  },
  {
    id: 'tailscale',
    name: 'Tailscale',
    category: 'Infrastructure',
    description:
      'Read a tailnet’s device list — hostname, addresses, and whether each device is currently connected — for the fleet view. Read-only: Loxep never authorizes, removes, or tags a device. Each Tailscale tailnet is one connection.',
    manage: { kind: 'route', to: '/settings/connections', label: 'Manage tailnets' },
    accounts: {
      provider: 'tailscale',
      kind: 'fleet_observability',
      form: 'tailscale-api',
      addLabel: 'Add Tailscale tailnet',
      formHint:
        'A personal API access token is stored encrypted and never shown again. It expires on the schedule you chose when generating it (up to 90 days) and must be replaced manually — Loxep surfaces the expiry as an ordinary authentication error when it happens.',
      blockedReason: () => null
    },
    status: ({ connections }) => {
      const count = accountsFor(connections, 'tailscale').length;
      return count > 0
        ? { tone: 'ready', label: 'Connected', details: [accountCountDetail(count)] }
        : { tone: 'unconfigured', label: 'No tailnets connected', details: [] };
    }
  },
  {
    id: 'termix',
    name: 'Termix',
    category: 'Infrastructure',
    description:
      'Read a self-hosted Termix instance’s SSH host inventory and active terminal sessions for the fleet view. Read-only: Loxep never opens a terminal, manages Docker, or touches a host through Termix. Each Termix instance is one connection.',
    manage: { kind: 'route', to: '/settings/connections', label: 'Manage instances' },
    accounts: {
      provider: 'termix',
      kind: 'fleet_observability',
      form: 'termix-api',
      addLabel: 'Add Termix instance',
      formHint:
        'The instance URL is kept as ordinary connection configuration; the username and password are stored encrypted and never shown again. Termix issues no scoped read-only token, so this should be an account you are comfortable having Loxep sign in as — Loxep’s own restraint is what keeps this integration read-only, not the account’s permissions.',
      blockedReason: () => null
    },
    status: ({ connections }) => {
      const count = accountsFor(connections, 'termix').length;
      return count > 0
        ? { tone: 'ready', label: 'Connected', details: [accountCountDetail(count)] }
        : { tone: 'unconfigured', label: 'No instances connected', details: [] };
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
  'Billing',
  'Infrastructure',
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
