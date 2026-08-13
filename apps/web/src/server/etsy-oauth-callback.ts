/**
 * Etsy OAuth2+PKCE consent-callback handler (loxep-g4t.1) — split out of
 * `@/server/etsy-oauth` for the same client-bundle reason
 * `ebay-oauth-callback.ts` is split out of `ebay-oauth.ts`: this module is
 * reached ONLY from the server-only API route
 * (`routes/api.integrations.etsy.callback.ts`) and is never imported by any
 * client-bundled file, so a STATIC import of the integration boundary is
 * safe here.
 *
 * CSRF/state + PKCE: both cookies `startEtsyConsent` plants
 * (`@/server/etsy-oauth`) are read here — the nonce (state binding) and the
 * PKCE code_verifier — and BOTH are cleared first (single use), mirroring
 * the eBay callback's ordering discipline: nonce/verifier cleared FIRST,
 * then state verified, then session checked, then connection re-validated
 * — nothing is written until all four hold.
 */
import {
  DEFAULT_ETSY_CONSENT_TIER,
  ETSY_CALLBACK_PATH,
  ETSY_CONNECTION_PROVIDER,
  ETSY_CONSENT_NONCE_COOKIE,
  ETSY_CONSENT_PKCE_COOKIE,
  ETSY_CONSENT_REQUEST_CONFIG_KEY,
  ETSY_OAUTH_CONFIG_KEY,
  etsyRequestedConsentTier,
  type EtsyKeyset
} from '@/server/etsy-oauth';
import { EtsyOAuthSetupError, etsyIntegration, requireKeyset } from '@/server/etsy-oauth-internal';

const CONNECTIONS_SETTINGS_PATH = '/settings/connections';

export type EtsyCallbackStatus = 'connected' | 'declined' | 'failed';

function redirectToConnections(status: EtsyCallbackStatus, connectionId?: string): Response {
  const target = new URL(CONNECTIONS_SETTINGS_PATH, 'http://placeholder.invalid');
  target.searchParams.set('etsy', status);
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

/** Handle Etsy's redirect back from the consent screen. */
export async function handleEtsyConsentCallback(request: Request): Promise<Response> {
  const [{ requireAdmin, getAdminServices }, { deleteCookie, getCookie }, integration] =
    await Promise.all([
      import('@/server/admin'),
      import('@tanstack/react-start/server'),
      etsyIntegration()
    ]);

  const url = new URL(request.url);
  const nonce = getCookie(ETSY_CONSENT_NONCE_COOKIE);
  const codeVerifier = getCookie(ETSY_CONSENT_PKCE_COOKIE);
  deleteCookie(ETSY_CONSENT_NONCE_COOKIE, { path: ETSY_CALLBACK_PATH });
  deleteCookie(ETSY_CONSENT_PKCE_COOKIE, { path: ETSY_CALLBACK_PATH });

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
      'Etsy consent could not be verified',
      'The consent request did not match a pending one from this browser. Start the connection flow again from the connections settings page.'
    );
  }

  if (codeVerifier === undefined || codeVerifier === '') {
    return errorPage(
      400,
      'Etsy consent could not be completed',
      'The PKCE verifier for this consent attempt was missing. Start the connection flow again from the connections settings page.'
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
      'Completing an Etsy connection requires an administrator session in this browser. Sign in as an administrator and start the connection flow again.'
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
  if (connection.provider !== ETSY_CONNECTION_PROVIDER) {
    return errorPage(
      400,
      'Wrong connection type',
      'This consent was bound to a connection that is not an Etsy connection.'
    );
  }

  const code = url.searchParams.get('code');
  if (code === null || code === '') {
    return errorPage(
      400,
      'Etsy returned no authorization code',
      'Start the connection flow again from the connections settings page.'
    );
  }

  let keyset: EtsyKeyset;
  try {
    keyset = (await requireKeyset()).keyset;
  } catch (error) {
    const setupError = error instanceof EtsyOAuthSetupError ? error : null;
    return errorPage(
      setupError?.status ?? 500,
      'Etsy is not configured',
      setupError?.message ??
        'The Etsy application keyset could not be read. Check the server logs for details.'
    );
  }

  const connectionConfig = connection.config as Record<string, unknown>;
  const requested = connectionConfig[ETSY_CONSENT_REQUEST_CONFIG_KEY];
  const requestedRecord =
    typeof requested === 'object' && requested !== null && !Array.isArray(requested)
      ? (requested as Record<string, unknown>)
      : {};
  const tier = etsyRequestedConsentTier(connectionConfig) ?? DEFAULT_ETSY_CONSENT_TIER;
  const redirectUri =
    typeof requestedRecord['redirectUri'] === 'string'
      ? (requestedRecord['redirectUri'] as string)
      : `${services.config.publicOrigin ?? ''}${ETSY_CALLBACK_PATH}`;

  try {
    const bundle = await integration.exchangeConsentCode({
      keystring: keyset.keystring,
      sharedSecret: keyset.sharedSecret,
      code,
      codeVerifier,
      redirectUri,
      scopes: integration.consentScopesForTier(tier)
    });
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
    const nextConfig: Record<string, unknown> = { ...connectionConfig };
    delete nextConfig[ETSY_CONSENT_REQUEST_CONFIG_KEY];
    nextConfig[ETSY_OAUTH_CONFIG_KEY] = {
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
    const kind =
      typeof (error as { kind?: unknown }).kind === 'string'
        ? (error as { kind: string }).kind
        : 'provider_unavailable';
    await services.connections
      .recordConnectionFailure(
        connection.id,
        { errorCode: `etsy_oauth_${kind}` },
        { actorUserId: session.user.id }
      )
      .catch(() => undefined);
    return redirectToConnections('failed', connection.id);
  }

  return redirectToConnections('connected', connection.id);
}
