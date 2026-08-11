/**
 * eBay adapter (loxep-62y.1.1): a thin Loxep-owned boundary over
 * hendt/ebay-api v10 (ADR-0009). The library provides construction
 * (`new eBayApi({appId, certId, devId, sandbox, ruName?})`), OAuth2
 * client-credentials token management (Restful calls invoke
 * `auth.getHeaderAuthorization()` → `OAuth2.getAccessToken()`, which mints
 * and caches an application access token when no user token is set), and the
 * Buy Browse API group — none of that is re-implemented here.
 *
 * USER CONTEXT (loxep-62y.1.2): `withUserToken(bundle)` returns a SECOND
 * adapter bound to one user's OAuth token. It is a separate `eBayApi`
 * instance on purpose — `OAuth2.setCredentials()` mutates the client it is
 * called on, and `OAuth2.getAccessToken()` prefers a user token over the
 * application token, so setting user credentials on the shared adapter would
 * silently re-authorize every application-scoped Browse call. The user
 * adapter SHARES the per-connection {@link RateBudget}, because eBay's
 * limits are per application/user pair, not per client object.
 *
 * Verified against ebay-api@10.0.0 (`dist/api/traditional/index.js`):
 * traditional (Trading) calls authenticate with the OAuth **user** token
 * through the IAF path — `getConfig()` calls `OAuth2.getAccessToken()` when
 * no Auth'n'Auth token is set and `apiConfig.useIaf` is true (the default in
 * `defaultApiConfig`), then sends it as the `X-EBAY-API-IAF-TOKEN` header.
 * Auth'n'Auth is therefore NOT required for GetMyeBayBuying; Loxep never
 * configures `authToken`. Trading additionally requires a numeric `siteId`
 * (`createTradingApi` throws without one), derived here from the configured
 * marketplace.
 *
 * Boundary rules enforced by this module:
 * - provider SDK types never appear in exported types (raw payloads cross as
 *   `Record<string, unknown>`);
 * - every API call acquires from the per-connection {@link RateBudget}
 *   BEFORE touching the network;
 * - every failure is normalized to {@link EbayAdapterError} with
 *   credential-free `detail`;
 * - application token material never leaves the adapter (mint reports
 *   metadata only). USER token material is the one deliberate exception:
 *   {@link EbayUserAdapter.currentTokenBundle} returns the bundle so the
 *   caller can persist it as an encrypted connection credential — that is
 *   the whole point of the OAuth lifecycle.
 */
import eBayApi from "ebay-api";
import {
  parseEbayAdapterConfig,
  type EbayAdapterConfig,
  type EbayAdapterConfigInput,
  type EbayEnvironment,
} from "./config.ts";
import { EbayAdapterError, normalizeEbayError } from "./errors.ts";
import {
  createRateBudget,
  type EbayAdapterLogger,
  type RateBudget,
  type RateBudgetStats,
} from "./rate-budget.ts";
import {
  bundleFromProviderToken,
  providerTokenFromBundle,
  type EbayUserTokenBundle,
} from "./tokens.ts";

export interface EbayBrowseSearchInput {
  query?: string;
  categoryIds?: string[];
  limit?: number;
  offset?: number;
}

export interface EbayBrowseSearchResult {
  total: number | null;
  /** Raw itemSummaries payloads (provider-shaped, deliberately untyped). */
  itemSummaries: Array<Record<string, unknown>>;
}

/** Token metadata only — the access token string never leaves the adapter. */
export interface EbayApplicationTokenInfo {
  tokenType: string | null;
  expiresInSeconds: number | null;
}

export interface EbayAdapterStats {
  environment: EbayEnvironment;
  marketplaceId: string;
  rateBudget: RateBudgetStats;
}

/** Browse operations available with either an application or a user token. */
interface EbayBrowseOperations {
  browseSearch(input: EbayBrowseSearchInput): Promise<EbayBrowseSearchResult>;
  /** Browse getItem — RESTful item id (`v1|...|0`). */
  browseGetItem(itemId: string): Promise<Record<string, unknown>>;
  /** Browse getItemByLegacyId — numeric Trading-era item id. */
  browseGetItemByLegacyId(
    legacyItemId: string,
  ): Promise<Record<string, unknown>>;
}

export interface EbayAdapter extends EbayBrowseOperations {
  readonly environment: EbayEnvironment;
  readonly marketplaceId: string;
  /** Force-mint an application (client-credentials) token; Buy calls also mint lazily. */
  mintApplicationToken(): Promise<EbayApplicationTokenInfo>;
  /**
   * Bind one user's OAuth token bundle, returning a user-context adapter
   * that shares this adapter's rate budget. The base adapter is unchanged.
   */
  withUserToken(
    bundle: EbayUserTokenBundle,
    options?: EbayUserAdapterOptions,
  ): EbayUserAdapter;
  stats(): EbayAdapterStats;
}

export interface EbayUserAdapterOptions {
  /**
   * Called whenever the bundle changes because the library auto-refreshed an
   * expired user token mid-call (`autoRefreshToken`, verified in
   * `dist/api/traditional/index.js` → `shouldRefreshToken`). Persist it:
   * the previous access token is dead once this fires.
   */
  onTokenRefreshed?: (bundle: EbayUserTokenBundle) => void;
}

export interface EbayUserAdapter extends EbayBrowseOperations {
  readonly environment: EbayEnvironment;
  readonly marketplaceId: string;
  /** The bundle currently in use, including any in-flight auto-refresh. */
  currentTokenBundle(): EbayUserTokenBundle;
  /** Explicitly exchange the refresh token for a fresh access token. */
  refreshUserToken(): Promise<EbayUserTokenBundle>;
  /**
   * Traditional (Trading) call with the user token in the IAF header.
   * Provider-shaped fields in, provider-shaped payload out — normalization
   * into Loxep facts belongs to the calling module (e.g. `watchlist.ts`).
   */
  tradingCall(
    callName: string,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  stats(): EbayAdapterStats;
}

/** Conservative default per-connection budget (see rate-budget.ts). */
const DEFAULT_BUDGET = { capacity: 5, refillPerSecond: 1 } as const;

/**
 * Trading/Shopping `siteId` per REST marketplace id (values from ebay-api's
 * `SiteId` enum). Marketplaces absent here can still use Browse; a Trading
 * call on one raises `invalid_request` rather than silently reporting a
 * different site's data.
 */
const SITE_ID_BY_MARKETPLACE: Readonly<Record<string, number>> = {
  EBAY_US: 0,
  EBAY_CA: 2,
  EBAY_GB: 3,
  EBAY_AU: 15,
  EBAY_AT: 16,
  EBAY_BE: 23,
  EBAY_FR: 71,
  EBAY_DE: 77,
  EBAY_IT: 101,
  EBAY_NL: 146,
  EBAY_ES: 186,
  EBAY_CH: 193,
  EBAY_HK: 201,
  EBAY_IN: 203,
  EBAY_IE: 205,
  EBAY_MY: 207,
  EBAY_PH: 211,
  EBAY_PL: 212,
  EBAY_SG: 216,
};

type ClientConstructorConfig = ConstructorParameters<typeof eBayApi>[0];

type AdapterCall = <T>(operation: string, fn: () => Promise<T>) => Promise<T>;

/**
 * Boundary-internal handle for sibling modules (`oauth.ts`, `watchlist.ts`).
 * Deliberately NOT re-exported from `index.ts`: it exposes the provider
 * client, which must not become part of the package's public surface. Kept
 * in a WeakMap rather than on the adapter object so the provider client can
 * never be reached through a returned adapter value.
 */
export interface EbayAdapterInternals {
  client: eBayApi;
  call: AdapterCall;
  config: EbayAdapterConfig;
  budget: RateBudget;
  logger: EbayAdapterLogger | undefined;
  /** Numeric Trading site id, or null when the marketplace has no mapping. */
  siteId: number | null;
}

const INTERNALS = new WeakMap<object, EbayAdapterInternals>();

/** @internal — sibling modules only. */
export function adapterInternals(adapter: object): EbayAdapterInternals {
  const internals = INTERNALS.get(adapter);
  if (internals === undefined) {
    throw new EbayAdapterError(
      "invalid_request",
      "value is not an eBay adapter created by createEbayAdapter()",
    );
  }
  return internals;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw normalizeEbayError(new Error("eBay returned a non-object payload"));
}

function buildClientConfig(
  parsed: EbayAdapterConfig,
  siteId: number | null,
): ClientConstructorConfig {
  return {
    appId: parsed.appId,
    certId: parsed.certId,
    devId: parsed.devId,
    ...(parsed.ruName !== undefined ? { ruName: parsed.ruName } : {}),
    sandbox: parsed.environment === "sandbox",
    marketplaceId: parsed.marketplaceId as ClientConstructorConfig["marketplaceId"],
    ...(siteId !== null
      ? { siteId: siteId as ClientConstructorConfig["siteId"] }
      : {}),
  };
}

/** Browse operations bound to one client + call wrapper. */
function browseOperations(
  client: eBayApi,
  call: AdapterCall,
): EbayBrowseOperations {
  return {
    async browseSearch(input) {
      return call("buy.browse.search", async () => {
        const response = asRecord(
          await client.buy.browse.search({
            ...(input.query !== undefined ? { q: input.query } : {}),
            ...(input.categoryIds !== undefined && input.categoryIds.length > 0
              ? { category_ids: input.categoryIds.join(",") }
              : {}),
            ...(input.limit !== undefined ? { limit: String(input.limit) } : {}),
            ...(input.offset !== undefined
              ? { offset: String(input.offset) }
              : {}),
          }),
        );
        const summaries = Array.isArray(response["itemSummaries"])
          ? (response["itemSummaries"] as unknown[])
          : [];
        return {
          total: typeof response["total"] === "number" ? response["total"] : null,
          itemSummaries: summaries.map(asRecord),
        };
      });
    },

    async browseGetItem(itemId) {
      return call("buy.browse.getItem", async () =>
        asRecord(await client.buy.browse.getItem(itemId)),
      );
    },

    async browseGetItemByLegacyId(legacyItemId) {
      return call("buy.browse.getItemByLegacyId", async () =>
        asRecord(
          await client.buy.browse.getItemByLegacyId({
            legacy_item_id: legacyItemId,
          }),
        ),
      );
    },
  };
}

/**
 * Build a user-context provider client.
 *
 * `setScope` matters here — the library sends its configured scope with the
 * refresh_token grant, and eBay requires that scope to be a subset of what
 * the user consented to.
 */
function createUserClient(
  internals: EbayAdapterInternals,
  options: {
    scopes: string[];
    token: {
      access_token: string;
      refresh_token: string;
      expires_in?: number;
      refresh_token_expires_in?: number;
      token_type?: string;
    };
  },
): eBayApi {
  const client = new eBayApi(
    buildClientConfig(internals.config, internals.siteId),
  );
  client.OAuth2.setScope([...options.scopes]);
  client.OAuth2.setCredentials(options.token);
  return client;
}

export function createEbayAdapter(config: EbayAdapterConfigInput): EbayAdapter {
  const { logger, rateBudget, ...rest } = config;
  const parsed = parseEbayAdapterConfig(rest);
  const budget: RateBudget =
    rateBudget ?? createRateBudget({ ...DEFAULT_BUDGET, logger });
  const siteId = SITE_ID_BY_MARKETPLACE[parsed.marketplaceId] ?? null;

  const client = new eBayApi(buildClientConfig(parsed, siteId));

  /** Rate-budget acquisition + error normalization around every call. */
  const call: AdapterCall = async (operation, fn) => {
    await budget.acquire(1);
    try {
      return await fn();
    } catch (error) {
      const normalized = normalizeEbayError(error);
      logger?.warn?.(
        {
          operation,
          kind: normalized.kind,
          environment: parsed.environment,
        },
        "eBay API call failed",
      );
      throw normalized;
    }
  };

  const stats = (): EbayAdapterStats => ({
    environment: parsed.environment,
    marketplaceId: parsed.marketplaceId,
    rateBudget: budget.stats(),
  });

  const internals: EbayAdapterInternals = {
    client,
    call,
    config: parsed,
    budget,
    logger,
    siteId,
  };

  const adapter: EbayAdapter = {
    environment: parsed.environment,
    marketplaceId: parsed.marketplaceId,
    ...browseOperations(client, call),

    async mintApplicationToken() {
      return call("oauth2.mintApplicationToken", async () => {
        const token = await client.OAuth2.obtainApplicationAccessToken();
        return {
          tokenType: token.token_type ?? null,
          expiresInSeconds: token.expires_in ?? null,
        };
      });
    },

    withUserToken(bundle, options) {
      return createUserAdapter(internals, bundle, options);
    },

    stats,
  };

  INTERNALS.set(adapter, internals);
  return adapter;
}

/** @internal — created through `adapter.withUserToken(...)`. */
export function createUserAdapter(
  internals: EbayAdapterInternals,
  bundle: EbayUserTokenBundle,
  options?: EbayUserAdapterOptions,
): EbayUserAdapter {
  const { call, config, budget, siteId } = internals;
  let current = bundle;

  const client = createUserClient(internals, {
    scopes: bundle.scopes,
    token: providerTokenFromBundle(bundle),
  });

  /** Idempotent: the emitter and an explicit refresh see the same token. */
  const applyProviderToken = (token: unknown): EbayUserTokenBundle => {
    const next = bundleFromProviderToken(token as Record<string, unknown>, {
      now: new Date(),
      scopes: current.scopes,
      previous: current,
    });
    if (next.accessToken === current.accessToken) return current;
    current = next;
    return current;
  };

  // The library emits this after its own auto-refresh (Trading IAF-expired
  // retry) as well as after an explicit refresh; both must update `current`
  // so the caller persists the token that is actually in use.
  client.OAuth2.on("refreshAuthToken", (token: unknown) => {
    applyProviderToken(token);
    options?.onTokenRefreshed?.(current);
  });

  const stats = (): EbayAdapterStats => ({
    environment: config.environment,
    marketplaceId: config.marketplaceId,
    rateBudget: budget.stats(),
  });

  const userAdapter: EbayUserAdapter = {
    environment: config.environment,
    marketplaceId: config.marketplaceId,
    ...browseOperations(client, call),

    currentTokenBundle() {
      return { ...current, scopes: [...current.scopes] };
    },

    async refreshUserToken() {
      return call("oauth2.refreshUserToken", async () => {
        const token = await client.OAuth2.refreshUserAccessToken();
        // The emitter above already applied this token; `applyProviderToken`
        // is idempotent, so both paths return the same bundle.
        const next = applyProviderToken(token);
        return { ...next, scopes: [...next.scopes] };
      });
    },

    async tradingCall(callName, fields) {
      if (siteId === null) {
        throw new EbayAdapterError(
          "invalid_request",
          "eBay Trading calls need a site id; marketplace has no mapped Trading site",
          { marketplaceId: config.marketplaceId, callName },
        );
      }
      const operation = `trading.${callName}`;
      return call(operation, async () => {
        const tradingApi = client.trading as unknown as Record<
          string,
          ((fields: Record<string, unknown>) => Promise<unknown>) | undefined
        >;
        const method = tradingApi[callName];
        if (typeof method !== "function") {
          throw new EbayAdapterError(
            "invalid_request",
            "unknown eBay Trading call",
            { callName },
          );
        }
        return asRecord(await method(fields));
      });
    },

    stats,
  };

  INTERNALS.set(userAdapter, internals);
  return userAdapter;
}
