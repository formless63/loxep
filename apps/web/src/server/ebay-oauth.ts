/**
 * eBay OAuth wiring for the web app (loxep-62y.1.2, loxep-62y.5).
 *
 * Four responsibilities, all admin-gated (ADR-0017):
 *
 * 1. **Keyset** — the eBay developer-portal application keyset is stored as
 *    the application secret `integration.ebay.keyset` (purpose `ebay_keyset`,
 *    ADR-0019). `storeEbayKeyset` is the server-side write path.
 * 2. **Consent** — `startEbayConsent` builds the eBay authorization URL and
 *    plants the CSRF nonce cookie.
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
import type { EbayErrorKind } from '@loxep/integration-ebay';
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

export interface EbayKeysetStatus {
  configured: boolean;
  source: EbayKeysetSource | null;
  environment: 'sandbox' | 'production' | null;
  /** Consent cannot run without a RuName; surfaced so the UI can say so. */
  ruNameConfigured: boolean;
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

// ---------------------------------------------------------------------------
// Consent start
// ---------------------------------------------------------------------------

export interface StartEbayConsentResult {
  url: string;
  scopes: string[];
  environment: 'sandbox' | 'production';
  keysetSource: EbayKeysetSource;
}

/**
 * Build the eBay consent URL for one connection and plant the CSRF nonce.
 * The caller navigates the browser to `url` (eBay requires a real browser
 * session for consent — there is no headless path).
 */
export const startEbayConsent = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ connectionId: z.uuid() }))
  .handler(async ({ data }): Promise<StartEbayConsentResult> => {
    const [{ requireAdmin, getAdminServices }, { setCookie, getRequestProtocol }, internal] =
      await Promise.all([
        import('@/server/admin'),
        import('@tanstack/react-start/server'),
        import('@/server/ebay-oauth-internal')
      ]);
    const integration = await internal.ebayIntegration();
    await requireAdmin();

    const connection = await getAdminServices().connections.getConnection(data.connectionId);
    if (connection.provider !== EBAY_CONNECTION_PROVIDER) {
      throw new internal.EbayOAuthSetupError(
        `Connection ${connection.id} has provider "${connection.provider}"; eBay consent needs an "${EBAY_CONNECTION_PROVIDER}" connection.`,
        400
      );
    }

    const { keyset, source } = await internal.requireKeyset();
    const adapter = await internal.adapterForKeyset(keyset);
    const state = integration.buildConsentState(connection.id);
    const consent = integration.buildConsentUrl(adapter, { state: state.state });

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
      environment: keyset.environment,
      keysetSource: source
    };
  });

// ---------------------------------------------------------------------------
// Validation (loxep-62y.5)
// ---------------------------------------------------------------------------

/** Non-secret facts `startEbayConsent`/the callback write to `connections.config`. */
interface EbayOAuthConnectionConfig {
  scopes?: unknown;
  refreshTokenExpiresAt?: unknown;
}

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
        const ebayOAuthConfig = (connection.config as { ebayOAuth?: EbayOAuthConnectionConfig })
          .ebayOAuth;
        const scopes = Array.isArray(ebayOAuthConfig?.scopes)
          ? (ebayOAuthConfig.scopes as string[])
          : undefined;
        const refreshTokenExpiresAt =
          typeof ebayOAuthConfig?.refreshTokenExpiresAt === 'string'
            ? ebayOAuthConfig.refreshTokenExpiresAt
            : null;
        const bundle = integration.bundleFromCredential({
          payload,
          expiresAt: oauthMeta.expiresAt,
          scopes,
          refreshTokenExpiresAt
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
