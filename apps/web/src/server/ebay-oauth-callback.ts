/**
 * eBay OAuth consent-callback handler (loxep-62y.1.2) — split out of
 * `@/server/ebay-oauth` (see `ebay-oauth-internal.ts`'s doc for why): this
 * module is reached ONLY from the server-only API route
 * (`routes/api.integrations.ebay.callback.ts`, via a dynamic import inside
 * its `GET` handler) and is never imported — directly or transitively — by
 * any client-bundled file. A STATIC import of `@loxep/integration-ebay`'s
 * boundary (through `ebay-oauth-internal.ts`) is therefore safe here.
 *
 * CSRF/state: the nonce cookie is planted by `startEbayConsent`
 * (`@/server/ebay-oauth`); see that module's doc for the full state/CSRF
 * design. Order matters below: the nonce cookie is cleared FIRST (single
 * use), then the state is verified, then the session is checked, then the
 * connection is re-validated — nothing is written until all four hold.
 */
import {
  DEFAULT_EBAY_CONSENT_TIER,
  EBAY_CALLBACK_PATH,
  EBAY_CONNECTION_PROVIDER,
  EBAY_CONSENT_NONCE_COOKIE,
  EBAY_CONSENT_REQUEST_CONFIG_KEY,
  EBAY_OAUTH_CONFIG_KEY,
  ebayRequestedConsentTier,
  type EbayKeyset
} from '@/server/ebay-oauth';
import {
  EbayOAuthSetupError,
  adapterForKeyset,
  ebayIntegration,
  requireKeyset
} from '@/server/ebay-oauth-internal';

const CONNECTIONS_SETTINGS_PATH = '/settings/connections';

/** Redirect statuses the settings page can render (`?ebay=<status>`). */
export type EbayCallbackStatus = 'connected' | 'declined' | 'failed';

function redirectToConnections(status: EbayCallbackStatus, connectionId?: string): Response {
  const target = new URL(CONNECTIONS_SETTINGS_PATH, 'http://placeholder.invalid');
  target.searchParams.set('ebay', status);
  if (connectionId !== undefined) target.searchParams.set('connection', connectionId);
  return new Response(null, {
    status: 303,
    headers: { location: `${target.pathname}${target.search}` }
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Minimal, dependency-free error page — this route has no React surface. */
function errorPage(status: number, title: string, detail: string): Response {
  const body =
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    '<main style="font:16px/1.5 system-ui,sans-serif;max-width:44rem;margin:4rem auto;padding:0 1rem">' +
    `<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1>` +
    `<p>${escapeHtml(detail)}</p>` +
    `<p><a href="${CONNECTIONS_SETTINGS_PATH}">Back to connections</a></p></main>`;
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
}

/**
 * Handle eBay's redirect back from the consent screen.
 *
 * Order matters: the nonce cookie is cleared FIRST (single use), then the
 * state is verified, then the session is checked, then the connection is
 * re-validated — nothing is written until all four hold.
 */
export async function handleEbayConsentCallback(request: Request): Promise<Response> {
  const [{ requireAdmin, getAdminServices }, { deleteCookie, getCookie }, integration] =
    await Promise.all([
      import('@/server/admin'),
      import('@tanstack/react-start/server'),
      ebayIntegration()
    ]);

  const url = new URL(request.url);
  const nonce = getCookie(EBAY_CONSENT_NONCE_COOKIE);
  deleteCookie(EBAY_CONSENT_NONCE_COOKIE, { path: EBAY_CALLBACK_PATH });

  // eBay sends the user to the declined URL, but a denied consent can also
  // come back here with an OAuth error code.
  const oauthError = url.searchParams.get('error');
  if (oauthError !== null && oauthError !== '') {
    return redirectToConnections('declined');
  }

  let connectionId: string;
  try {
    connectionId = integration.verifyConsentState(
      url.searchParams.get('state'),
      nonce
    ).connectionId;
  } catch {
    return errorPage(
      400,
      'eBay consent could not be verified',
      'The consent request did not match a pending one from this browser. Start the connection flow again from the connections settings page.'
    );
  }

  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    const status =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 401;
    return errorPage(
      status,
      status === 403 ? 'Administrator role required' : 'Sign in as an administrator',
      'Completing an eBay connection requires an administrator session in this browser. Sign in as an administrator and start the connection flow again.'
    );
  }

  const services = getAdminServices();
  let connection;
  try {
    connection = await services.connections.getConnection(connectionId);
  } catch {
    return errorPage(
      404,
      'Unknown connection',
      'The connection this consent was started for no longer exists.'
    );
  }
  if (connection.provider !== EBAY_CONNECTION_PROVIDER) {
    return errorPage(
      400,
      'Wrong connection type',
      'This consent was bound to a connection that is not an eBay connection.'
    );
  }

  const code = url.searchParams.get('code');
  if (code === null || code === '') {
    return errorPage(
      400,
      'eBay returned no authorization code',
      'Start the connection flow again from the connections settings page.'
    );
  }

  let keyset: EbayKeyset;
  try {
    keyset = (await requireKeyset()).keyset;
  } catch (error) {
    const setupError = error instanceof EbayOAuthSetupError ? error : null;
    return errorPage(
      setupError?.status ?? 500,
      'eBay is not configured',
      setupError?.message ??
        'The eBay application keyset could not be read. Check the server logs for details.'
    );
  }

  // The tier `startEbayConsent` asked for. eBay's callback carries NO scope
  // information, so without this the exchange would fall back to the default
  // (base-scope) set and record a watchlist-only grant on a connection that
  // had actually been consented for orders — the bug loxep-ld0 fixes. The
  // value is server-written and admin-gated; anything unrecognised (an older
  // connection consented before this existed) reads as the narrow tier.
  const connectionConfig = connection.config as Record<string, unknown>;
  const tier = ebayRequestedConsentTier(connectionConfig) ?? DEFAULT_EBAY_CONSENT_TIER;

  try {
    const adapter = await adapterForKeyset(keyset);
    const bundle = await integration.exchangeConsentCode(adapter, {
      code,
      scopes: integration.consentScopesForTier(tier)
    });
    // The integration boundary owns the secret/non-secret split.
    const write = integration.credentialWriteForBundle(bundle);

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
    // Non-secret consent facts live on the connection, not in the ciphertext.
    // The pending-consent marker is consumed here — it described THIS
    // exchange, and leaving it would misreport the next one.
    const nextConfig: Record<string, unknown> = { ...connectionConfig };
    delete nextConfig[EBAY_CONSENT_REQUEST_CONFIG_KEY];
    // No `tier` field: the granted SCOPES are the fact, and the tier is
    // derived from them (`ebayConsentTierForScopes`). A stored tier would be
    // a second copy that a later token refresh could leave stale.
    nextConfig[EBAY_OAUTH_CONFIG_KEY] = {
      environment: keyset.environment,
      ...write.connectionConfig,
      consentedAt: new Date().toISOString()
    };
    await services.connections.updateConnection(
      connection.id,
      { config: nextConfig },
      { actorUserId: session.user.id }
    );
    await services.connections.recordConnectionSuccess(connection.id, {
      actorUserId: session.user.id
    });
  } catch (error) {
    // Provider evidence is already credential-free at the boundary; record
    // the taxonomy kind on the connection and keep the browser message generic.
    const kind =
      typeof (error as { kind?: unknown }).kind === 'string'
        ? (error as { kind: string }).kind
        : 'provider_unavailable';
    await services.connections
      .recordConnectionFailure(
        connection.id,
        { errorCode: `ebay_oauth_${kind}` },
        { actorUserId: session.user.id }
      )
      .catch(() => undefined);
    return redirectToConnections('failed', connection.id);
  }

  return redirectToConnections('connected', connection.id);
}
