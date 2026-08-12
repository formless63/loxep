/**
 * eBay OAuth wiring for the web app (loxep-62y.1.2, loxep-62y.5).
 *
 * Four responsibilities, all admin-gated (ADR-0017):
 *
 * 1. **Keyset** — the eBay developer-portal application keyset is stored as
 *    the application secret `integration.ebay.keyset` (purpose `ebay_keyset`,
 *    ADR-0019). `storeEbayKeyset` is the server-side write path.
 * 2. **Consent** — `startEbayConsent` builds the eBay authorization URL and
 *    plants the CSRF nonce cookie. It takes a consent TIER (loxep-ld0), never
 *    scope strings: `watchlist` (base scope) or `orders` (base + Sell
 *    Fulfillment read-only), resolved to scopes server-side from the
 *    integration package's constants.
 * 3. **Callback** — `handleEbayConsentCallback` (`@/server/ebay-oauth-callback`)
 *    validates state, exchanges the code, and stores the user token as an
 *    encrypted connection credential. It lives in a separate module — see
 *    that file's doc and `ebay-oauth-internal.ts`'s doc for why.
 * 4. **Validation** — `validateEbayConnection` runs a cheap authenticated
 *    call and reports the integration boundary's taxonomy-mapped result.
 *
 * KEYSET PRECEDENCE (documented, deliberate):
 *   1. application secret `integration.ebay.keyset` — the real runtime path;
 *   2. the local dev file `~/.config/loxep/ebay-sandbox.env` — ONLY when no
 *      secret exists. It is a developer convenience for the sandbox
 *      bring-up and is never consulted once the secret is configured.
 * Nothing here reads provider credentials from environment variables
 * (ADR-0016: provider connections are created in-app, not via Compose env).
 *
 * CSRF/state: `startEbayConsent` generates a random nonce, sets it in a
 * short-lived httpOnly `SameSite=Lax` cookie scoped to the callback path, and
 * puts `sha256(nonce.connectionId).connectionId` in the `state` parameter. eBay echoes
 * `state` back on the callback; the handler recomputes the hash from the
 * cookie and compares in constant time. `SameSite=Lax` is required (and
 * sufficient): the callback is a top-level cross-site GET navigation, which
 * Lax permits and Strict would block. The nonce is single-use — the cookie is
 * deleted on every callback, success or failure. The connection id inside the
 * state is treated as untrusted data: the handler re-loads that connection and
 * verifies it is an eBay connection before writing anything.
 *
 * TOKEN STORAGE: the bundle is written to `connection_credentials` under the
 * registered purpose `oauth_tokens` (`{accessToken, refreshToken}`), with the
 * access-token expiry on the version row (`expires_at`) and the proactive
 * refresh point in `refresh_after`. Non-secret facts (granted scopes, refresh
 * token expiry, environment, consent timestamp) go on the connection's
 * non-secret `config.ebayOAuth`. Credential values are never returned to the
 * browser, logged, or put in a redirect parameter.
 *
 * CLIENT-BUNDLE BOUNDARY: this module IS imported directly by client
 * components (`features/settings/components/ebay-*`) for its `createServerFn`
 * exports — that only works safely because every dynamic import of
 * `@loxep/integration-ebay` (via `@/server/ebay-oauth-internal`) happens
 * INSIDE a `.handler()` callback body, which TanStack Start's
 * `server-fn:client` Vite plugin strips for the client build. See
 * `ebay-oauth-internal.ts`'s doc for the full mechanics and the production
 * build failure this avoids — do not hoist any of those calls to this
 * module's top level or a shared top-level function.
 *
 * WIRING CAVEAT: `apps/web/package.json` does not yet declare
 * `@loxep/integration-ebay`, so it is reached only through a
 * workspace-relative dynamic import (inside `ebay-oauth-internal.ts`).
 * Replacing the specifier with the package name once the dependency is
 * declared is a one-line change there.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { EbayConsentTier, EbayErrorKind } from '@loxep/integration-ebay';
import type { EbayKeyset, EbayKeysetSource } from '@/server/ebay-oauth-internal';

/** Application-secret key holding the eBay application keyset. */
export const EBAY_KEYSET_SECRET_KEY = 'integration.ebay.keyset';
/** `connections.provider` value this flow accepts. */
export const EBAY_CONNECTION_PROVIDER = 'ebay';
/**
 * Registered credential purpose used for the conceptual 'ebay_oauth' slot.
 * `oauth_tokens` already describes exactly `{accessToken, refreshToken}`.
 */
export const EBAY_OAUTH_CREDENTIAL_TYPE = 'oauth_tokens';
/** httpOnly nonce cookie backing the consent `state` parameter. */
export const EBAY_CONSENT_NONCE_COOKIE = 'loxep_ebay_consent';
/** Callback path — must match the eBay RuName's "auth accepted" URL. */
export const EBAY_CALLBACK_PATH = '/api/integrations/ebay/callback';
const CONSENT_COOKIE_MAX_AGE_SECONDS = 600;

export type { EbayKeyset, EbayKeysetSource };

// ---------------------------------------------------------------------------
// Consent tiers (loxep-ld0)
// ---------------------------------------------------------------------------

export type { EbayConsentTier };

/**
 * Tier ids as a runtime value, for the zod input and the UI's choice list.
 *
 * Deliberately a literal tuple rather than a re-export: this module is
 * imported by CLIENT components, so it must not pull a VALUE out of
 * `@loxep/integration-ebay` (see the CLIENT-BUNDLE BOUNDARY note above). The
 * `satisfies` clause plus {@link EBAY_CONSENT_TIER_LABELS}' exhaustive
 * `Record` make the pair a compile error the moment the package's
 * `EbayConsentTier` union gains or renames a member.
 */
export const EBAY_CONSENT_TIER_IDS = [
  'watchlist',
  'orders'
] as const satisfies readonly EbayConsentTier[];

/** Operator-facing tier names. Exhaustive over the package's union. */
export const EBAY_CONSENT_TIER_LABELS: Record<EbayConsentTier, string> = {
  watchlist: 'Watchlist & browsing',
  orders: 'Watchlist + order history'
};

/** One line each, shown beside the choice at consent time. */
export const EBAY_CONSENT_TIER_DESCRIPTIONS: Record<EbayConsentTier, string> = {
  watchlist: 'Watchlists, listings, and searches. Every keyset can grant this.',
  orders:
    'Adds read-only access to the account’s order history. Only offer it if the keyset was granted the Sell Fulfillment scope — eBay rejects the whole consent otherwise.'
};

/** The narrow tier, assumed whenever nothing said otherwise. */
export const DEFAULT_EBAY_CONSENT_TIER: EbayConsentTier = 'watchlist';

/**
 * Mirrors `@loxep/integration-ebay`'s `EBAY_SELL_FULFILLMENT_READONLY_SCOPE`
 * as a plain string, for the same client-bundle reason as
 * {@link EBAY_CONSENT_TIER_IDS} — the tier a connection HOLDS has to be
 * readable in the browser from `connections.config`, and importing the
 * package's constant would drag `ebay-api` into the client graph. The
 * authoritative copy is the package's; this one only classifies.
 */
export const EBAY_ORDER_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly';

/** `connections.config` key holding the tier a pending consent asked for. */
export const EBAY_CONSENT_REQUEST_CONFIG_KEY = 'ebayConsentRequest';
/** `connections.config` key holding the granted, non-secret consent facts. */
export const EBAY_OAUTH_CONFIG_KEY = 'ebayOAuth';

const consentTierSchema = z.enum(EBAY_CONSENT_TIER_IDS);

/**
 * Non-secret facts `startEbayConsent`/the callback write to
 * `connections.config` are read through these helpers rather than a cast: the
 * config column is untyped JSON, and a connection consented before a given
 * key existed must read as "absent", never as a crash.
 */
function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Granted scopes recorded on a connection, or `null` when there are none. */
export function ebayGrantedScopes(config: Record<string, unknown>): string[] | null {
  const scopes = readObject(config[EBAY_OAUTH_CONFIG_KEY]).scopes;
  return Array.isArray(scopes) && scopes.every((scope) => typeof scope === 'string')
    ? (scopes as string[])
    : null;
}

/**
 * Classify recorded scopes into a tier — the browser-side twin of the
 * package's `consentTierForScopes`. Conservative by construction: anything
 * that is not demonstrably an order-scoped grant reads as `watchlist`.
 */
export function ebayConsentTierForScopes(
  scopes: readonly string[] | null | undefined
): EbayConsentTier {
  return Array.isArray(scopes) && scopes.includes(EBAY_ORDER_SCOPE) ? 'orders' : 'watchlist';
}

/** The tier a pending (started but not yet completed) consent asked for. */
export function ebayRequestedConsentTier(config: Record<string, unknown>): EbayConsentTier | null {
  const tier = readObject(config[EBAY_CONSENT_REQUEST_CONFIG_KEY]).tier;
  return tier === 'watchlist' || tier === 'orders' ? tier : null;
}

export interface EbayKeysetStatus {
  configured: boolean;
  source: EbayKeysetSource | null;
  environment: 'sandbox' | 'production' | null;
  /** Consent cannot run without a RuName; surfaced so the UI can say so. */
  ruNameConfigured: boolean;
}

/**
 * What this installation's operator must paste into the eBay redirect URL's
 * "auth accepted URL" field. Both values are ordinary public facts — the
 * origin is the address the browser already reached — so nothing here is
 * gated beyond an authenticated session.
 */
export interface EbayCallbackUrlInfo {
  /** `LOXEP_PUBLIC_ORIGIN`, trailing slash removed; `null` if unset. */
  publicOrigin: string | null;
  /** `<publicOrigin>${EBAY_CALLBACK_PATH}`; `null` when the origin is unset. */
  callbackUrl: string | null;
  /** The path half, always known — usable as a fallback in the UI. */
  callbackPath: string;
}

const keysetInput = z.strictObject({
  appId: z.string().trim().min(1),
  certId: z.string().trim().min(1),
  devId: z.string().trim().min(1),
  ruName: z.string().trim().min(1).nullish(),
  environment: z.enum(['sandbox', 'production'])
});

// ---------------------------------------------------------------------------
// Keyset administration
// ---------------------------------------------------------------------------

/**
 * Store/rotate the eBay application keyset. Admin-only. The payload is a
 * typed ADR-0019 bundle, so a half-configured keyset cannot be persisted.
 */
export const storeEbayKeyset = createServerFn({ method: 'POST' })
  .inputValidator(keysetInput)
  .handler(async ({ data }): Promise<{ currentVersion: number }> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    const session = await requireAdmin();
    const result = await getAdminServices().secrets.setSecret({
      secretKey: EBAY_KEYSET_SECRET_KEY,
      purpose: 'ebay_keyset',
      payload: {
        appId: data.appId,
        certId: data.certId,
        devId: data.devId,
        ...(data.ruName !== undefined && data.ruName !== null ? { ruName: data.ruName } : {}),
        environment: data.environment
      },
      actorUserId: session.user.id
    });
    return { currentVersion: result.currentVersion };
  });

/** Keyset presence/metadata — never any credential value. */
export const fetchEbayKeysetStatus = createServerFn({ method: 'GET' }).handler(
  async (): Promise<EbayKeysetStatus> => {
    const [{ requireAdmin }, { loadKeyset }] = await Promise.all([
      import('@/server/admin'),
      import('@/server/ebay-oauth-internal')
    ]);
    await requireAdmin();
    const resolved = await loadKeyset();
    if (resolved === null) {
      return { configured: false, source: null, environment: null, ruNameConfigured: false };
    }
    return {
      configured: true,
      source: resolved.source,
      environment: resolved.keyset.environment,
      ruNameConfigured: resolved.keyset.ruName !== undefined && resolved.keyset.ruName !== ''
    };
  }
);

/**
 * The exact callback URL this installation answers on, built from bootstrap
 * configuration (`LOXEP_PUBLIC_ORIGIN`, ADR-0016) plus
 * {@link EBAY_CALLBACK_PATH}.
 *
 * The keyset setup guidance shows this verbatim with a copy button, because
 * the value an operator must register in eBay's developer portal is a
 * property of THIS deployment — a documented example URL would be wrong for
 * every installation but one. Read through `getAdminServices()` so the
 * already-loaded bootstrap config is reused rather than re-parsed.
 */
export const fetchEbayCallbackUrl = createServerFn({ method: 'GET' }).handler(
  async (): Promise<EbayCallbackUrlInfo> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const configured = getAdminServices().config.publicOrigin;
    const publicOrigin =
      configured === undefined || configured === '' ? null : configured.replace(/\/+$/, '');
    return {
      publicOrigin,
      callbackUrl: publicOrigin === null ? null : `${publicOrigin}${EBAY_CALLBACK_PATH}`,
      callbackPath: EBAY_CALLBACK_PATH
    };
  }
);

// ---------------------------------------------------------------------------
// Consent start
// ---------------------------------------------------------------------------

export interface StartEbayConsentResult {
  url: string;
  scopes: string[];
  /** The tier the URL was built for — resolved server-side, never echoed input. */
  tier: EbayConsentTier;
  environment: 'sandbox' | 'production';
  keysetSource: EbayKeysetSource;
}

/**
 * Build the eBay consent URL for one connection and plant the CSRF nonce.
 * The caller navigates the browser to `url` (eBay requires a real browser
 * session for consent — there is no headless path).
 *
 * SCOPES (loxep-ld0): the caller passes a TIER, never scope strings. The
 * scope set is resolved from `@loxep/integration-ebay`'s own constants inside
 * this handler, so no request body can widen (or corrupt) a consent.
 *
 * The requested tier is also recorded on the connection
 * (`config.ebayConsentRequest`) before the browser leaves, because eBay's
 * callback carries no scope information back: the callback resolves the SAME
 * tier from the connection row when it exchanges the code, which is what
 * makes the recorded `config.ebayOAuth.scopes` true rather than always the
 * default set. A cookie would have done the same job less durably and with a
 * tamperable value; the connection row is server-owned and admin-gated.
 */
export const startEbayConsent = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ connectionId: z.uuid(), tier: consentTierSchema.optional() }))
  .handler(async ({ data }): Promise<StartEbayConsentResult> => {
    const [{ requireAdmin, getAdminServices }, { setCookie, getRequestProtocol }, internal] =
      await Promise.all([
        import('@/server/admin'),
        import('@tanstack/react-start/server'),
        import('@/server/ebay-oauth-internal')
      ]);
    const integration = await internal.ebayIntegration();
    const session = await requireAdmin();
    const services = getAdminServices();

    const connection = await services.connections.getConnection(data.connectionId);
    if (connection.provider !== EBAY_CONNECTION_PROVIDER) {
      throw new internal.EbayOAuthSetupError(
        `Connection ${connection.id} has provider "${connection.provider}"; eBay consent needs an "${EBAY_CONNECTION_PROVIDER}" connection.`,
        400
      );
    }
    // The row menu hides these actions on an archived account; this guard is
    // for the stale tab that still has them (loxep-o7h).
    if (connection.status === 'archived') {
      throw new internal.EbayOAuthSetupError(
        `Connection ${connection.id} is archived. Unarchive it before connecting an eBay account to it.`,
        400
      );
    }

    const tier: EbayConsentTier = data.tier ?? DEFAULT_EBAY_CONSENT_TIER;
    const { keyset, source } = await internal.requireKeyset();
    const adapter = await internal.adapterForKeyset(keyset);
    const state = integration.buildConsentState(connection.id);
    const consent = integration.buildConsentUrl(adapter, {
      state: state.state,
      scopes: integration.consentScopesForTier(tier)
    });

    // Remembered for the callback, which eBay gives no scope information to.
    await services.connections.updateConnection(
      connection.id,
      {
        config: {
          ...connection.config,
          [EBAY_CONSENT_REQUEST_CONFIG_KEY]: { tier, requestedAt: new Date().toISOString() }
        }
      },
      { actorUserId: session.user.id }
    );

    setCookie(EBAY_CONSENT_NONCE_COOKIE, state.nonce, {
      httpOnly: true,
      sameSite: 'lax',
      secure: getRequestProtocol() === 'https',
      path: EBAY_CALLBACK_PATH,
      maxAge: CONSENT_COOKIE_MAX_AGE_SECONDS
    });

    return {
      url: consent.url,
      scopes: consent.scopes,
      tier,
      environment: keyset.environment,
      keysetSource: source
    };
  });

// ---------------------------------------------------------------------------
// Validation (loxep-62y.5)
// ---------------------------------------------------------------------------

export interface EbayValidationResult {
  ok: boolean;
  /** Which credential the validation call actually authenticated with. */
  mode: 'user' | 'application';
  /** Safe to show an administrator — never provider headers/request material. */
  message: string;
  /** Present only on failure; the integration boundary's stable error taxonomy. */
  errorKind?: EbayErrorKind;
}

/**
 * Reports whether an eBay connection can currently authenticate, using the
 * cheapest call that actually exercises the credential in play:
 *
 * - **user mode** (an `ebay_oauth` credential exists): one page of
 *   {@link fetchWatchlist} at `entriesPerPage: 1` — the exact Trading
 *   `GetMyeBayBuying` call the watchlist poller itself makes, so a pass here
 *   means the poller will work. The stored bundle is refreshed first if it is
 *   due (`refreshTokenBundleIfNeeded`), and a refreshed bundle is persisted
 *   before the call — a validate action should never leave a rotated token
 *   un-persisted.
 * - **application mode** (no user consent yet): {@link EbayAdapter.mintApplicationToken},
 *   which validates the keyset can complete the client-credentials grant.
 *   (A Browse search was considered instead, but the integration package's
 *   own `sellers.ts` documents `category_ids=0` — the only query-free anchor
 *   available — as unverified/undocumented eBay behavior; minting the
 *   application token directly is both cheaper and unambiguous.)
 *
 * Every failure is the integration boundary's own {@link EbayAdapterError}
 * taxonomy (`kind`) — never a raw provider/HTTP error — and is also recorded
 * on the connection via `recordConnectionFailure` (`ebay_validate_<kind>`),
 * matching the callback's error-recording convention. A success records
 * `recordConnectionSuccess`, so validating doubles as a manual health check.
 */
export const validateEbayConnection = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ connectionId: z.uuid() }))
  .handler(async ({ data }): Promise<EbayValidationResult> => {
    const [{ requireAdmin, getAdminServices }, internal] = await Promise.all([
      import('@/server/admin'),
      import('@/server/ebay-oauth-internal')
    ]);
    const integration = await internal.ebayIntegration();
    const session = await requireAdmin();
    const services = getAdminServices();

    const connection = await services.connections.getConnection(data.connectionId);
    if (connection.provider !== EBAY_CONNECTION_PROVIDER) {
      throw new internal.EbayOAuthSetupError(
        `Connection ${connection.id} has provider "${connection.provider}"; eBay validation needs an "${EBAY_CONNECTION_PROVIDER}" connection.`,
        400
      );
    }

    let keyset: EbayKeyset;
    try {
      keyset = (await internal.requireKeyset()).keyset;
    } catch (error) {
      const message =
        error instanceof internal.EbayOAuthSetupError ? error.message : 'eBay is not configured.';
      return { ok: false, mode: 'application', message };
    }
    const adapter = await internal.adapterForKeyset(keyset);

    const credentialMetas = await services.connections.listConnectionCredentials(connection.id);
    const oauthMeta = credentialMetas.find(
      (credential) => credential.credentialType === EBAY_OAUTH_CREDENTIAL_TYPE
    );
    const mode: EbayValidationResult['mode'] = oauthMeta ? 'user' : 'application';

    try {
      if (oauthMeta) {
        const { payload } = await services.connections.getConnectionCredentialPayload(
          connection.id,
          EBAY_OAUTH_CREDENTIAL_TYPE
        );
        const connectionConfig = connection.config as Record<string, unknown>;
        const scopes = ebayGrantedScopes(connectionConfig) ?? undefined;
        const refreshTokenExpiresAt = readObject(
          connectionConfig[EBAY_OAUTH_CONFIG_KEY]
        ).refreshTokenExpiresAt;
        const bundle = integration.bundleFromCredential({
          payload,
          expiresAt: oauthMeta.expiresAt,
          scopes,
          refreshTokenExpiresAt:
            typeof refreshTokenExpiresAt === 'string' ? refreshTokenExpiresAt : null
        });
        const refresh = await integration.refreshTokenBundleIfNeeded({ bundle, adapter });
        if (refresh.refreshed) {
          const write = integration.credentialWriteForBundle(refresh.bundle);
          await services.connections.setConnectionCredential(
            connection.id,
            write.credentialType,
            write.payload,
            {
              expiresAt: write.expiresAt,
              refreshAfter: write.refreshAfter,
              actorUserId: session.user.id
            }
          );
        }
        const userAdapter = integration.userAdapterFromBundle(adapter, refresh.bundle);
        await integration.fetchWatchlist(userAdapter, { entriesPerPage: 1 });
      } else {
        await adapter.mintApplicationToken();
      }
    } catch (error) {
      const rawKind = (error as { kind?: unknown } | undefined)?.kind;
      const kind: EbayErrorKind =
        typeof rawKind === 'string' ? (rawKind as EbayErrorKind) : 'provider_unavailable';
      const message = error instanceof Error ? error.message : 'eBay validation failed.';
      await services.connections
        .recordConnectionFailure(
          connection.id,
          { errorCode: `ebay_validate_${kind}` },
          { actorUserId: session.user.id }
        )
        .catch(() => undefined);
      return { ok: false, mode, message, errorKind: kind };
    }

    await services.connections.recordConnectionSuccess(connection.id, {
      actorUserId: session.user.id
    });
    return {
      ok: true,
      mode,
      message:
        mode === 'user'
          ? 'eBay accepted the stored user token (watchlist read succeeded).'
          : 'eBay accepted the application keyset (no user consent yet).'
    };
  });
