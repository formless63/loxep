/**
 * Etsy OAuth2+PKCE wiring for the web app (loxep-g4t.1).
 *
 * Four responsibilities, all admin-gated (ADR-0017), mirroring
 * `@/server/ebay-oauth`'s shape exactly except for the PKCE code_verifier
 * this flow additionally needs across the request/callback boundary:
 *
 * 1. **Keyset** — the Etsy Developer Portal application keyset is stored as
 *    the application secret `integration.etsy.keyset` (purpose
 *    `etsy_keyset`, ADR-0019). `storeEtsyKeyset` is the server-side write
 *    path.
 * 2. **Consent** — `startEtsyConsent` builds the Etsy PKCE authorization URL
 *    and plants BOTH the CSRF nonce cookie and the PKCE code_verifier
 *    cookie. It takes a consent TIER ('shop' | 'orders', mirroring eBay's
 *    watchlist/orders split — loxep-ld0's pattern), never scope strings.
 * 3. **Callback** — `handleEtsyConsentCallback`
 *    (`@/server/etsy-oauth-callback`) validates state, retrieves the
 *    code_verifier, exchanges the code, and stores the user token as an
 *    encrypted connection credential. Lives in a separate module for the
 *    same client-bundle reason `ebay-oauth-callback.ts` does.
 * 4. **Validation** — `validateEtsyConnection` runs a cheap call
 *    (`openapi-ping`) and reports the taxonomy-mapped result.
 *
 * KEYSET PRECEDENCE and CSRF/state binding mirror eBay's documented design
 * exactly (see `@/server/ebay-oauth`'s module doc) — only the URL, the PKCE
 * addition, and the tier vocabulary differ.
 *
 * PKCE: the `code_verifier` `startEtsyConsent` generates is held in a
 * SEPARATE short-lived httpOnly cookie alongside the nonce cookie (both
 * planted together, both cleared together on the callback) — per the
 * binding design's direction that it "should live alongside [the nonce] in
 * the same short-lived httpOnly-cookie mechanism, not be reinvented."
 *
 * CLIENT-BUNDLE BOUNDARY: see `etsy-oauth-internal.ts`'s module doc for why
 * every heavy import happens inside a `.handler()` body.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { EtsyConsentTier, EtsyErrorKind } from '@loxep/integration-etsy';
import type { EtsyKeyset, EtsyKeysetSource } from '@/server/etsy-oauth-internal';

/** Application-secret key holding the Etsy application keyset. */
export const ETSY_KEYSET_SECRET_KEY = 'integration.etsy.keyset';
/** `connections.provider` value this flow accepts. */
export const ETSY_CONNECTION_PROVIDER = 'etsy';
/** Registered credential purpose reused for the conceptual 'etsy_oauth' slot. */
export const ETSY_OAUTH_CREDENTIAL_TYPE = 'oauth_tokens';
/** httpOnly nonce cookie backing the consent `state` parameter. */
export const ETSY_CONSENT_NONCE_COOKIE = 'loxep_etsy_consent';
/** httpOnly cookie holding the PKCE code_verifier across the redirect. */
export const ETSY_CONSENT_PKCE_COOKIE = 'loxep_etsy_pkce';
/** Callback path — must match the redirect URI registered with Etsy. */
export const ETSY_CALLBACK_PATH = '/api/integrations/etsy/callback';
const CONSENT_COOKIE_MAX_AGE_SECONDS = 600;

export type { EtsyKeyset, EtsyKeysetSource };

// ---------------------------------------------------------------------------
// Consent tiers
// ---------------------------------------------------------------------------

export type { EtsyConsentTier };

/**
 * Tier ids as a runtime value, for the zod input and the UI's choice list.
 * A literal tuple rather than a re-export, for the same client-bundle
 * reason `EBAY_CONSENT_TIER_IDS` is one in `@/server/ebay-oauth`.
 */
export const ETSY_CONSENT_TIER_IDS = [
  'shop',
  'orders'
] as const satisfies readonly EtsyConsentTier[];

export const ETSY_CONSENT_TIER_LABELS: Record<EtsyConsentTier, string> = {
  shop: 'Shop & listings',
  orders: 'Shop + order history'
};

export const ETSY_CONSENT_TIER_DESCRIPTIONS: Record<EtsyConsentTier, string> = {
  shop: 'The shop’s full listing set, including drafts and inactive listings. Every keyset can grant this.',
  orders:
    'Adds read-only access to the shop’s receipts and transactions. Only offer it once order ingestion is available.'
};

export const DEFAULT_ETSY_CONSENT_TIER: EtsyConsentTier = 'shop';

const consentTierSchema = z.enum(ETSY_CONSENT_TIER_IDS);

/** `connections.config` key holding the tier a pending consent asked for. */
export const ETSY_CONSENT_REQUEST_CONFIG_KEY = 'etsyConsentRequest';
/** `connections.config` key holding the granted, non-secret consent facts. */
export const ETSY_OAUTH_CONFIG_KEY = 'etsyOAuth';
/** `connections.config` key holding the connected shop's non-secret id. */
export const ETSY_SHOP_CONFIG_KEY = 'etsy';

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function etsyGrantedScopes(config: Record<string, unknown>): string[] | null {
  const scopes = readObject(config[ETSY_OAUTH_CONFIG_KEY]).scopes;
  return Array.isArray(scopes) && scopes.every((scope) => typeof scope === 'string')
    ? (scopes as string[])
    : null;
}

export function etsyRequestedConsentTier(config: Record<string, unknown>): EtsyConsentTier | null {
  const tier = readObject(config[ETSY_CONSENT_REQUEST_CONFIG_KEY]).tier;
  return tier === 'shop' || tier === 'orders' ? tier : null;
}

export interface EtsyKeysetStatus {
  configured: boolean;
  source: EtsyKeysetSource | null;
}

export interface EtsyCallbackUrlInfo {
  publicOrigin: string | null;
  callbackUrl: string | null;
  callbackPath: string;
}

const keysetInput = z.strictObject({
  keystring: z.string().trim().min(1),
  sharedSecret: z.string().trim().min(1)
});

// ---------------------------------------------------------------------------
// Keyset administration
// ---------------------------------------------------------------------------

/**
 * Store/rotate the Etsy application keyset. Admin-only. The payload is a
 * typed ADR-0019 bundle, so a half-configured keyset cannot be persisted.
 */
export const storeEtsyKeyset = createServerFn({ method: 'POST' })
  .inputValidator(keysetInput)
  .handler(async ({ data }): Promise<{ currentVersion: number }> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    const session = await requireAdmin();
    const result = await getAdminServices().secrets.setSecret({
      secretKey: ETSY_KEYSET_SECRET_KEY,
      purpose: 'etsy_keyset',
      payload: { keystring: data.keystring, sharedSecret: data.sharedSecret },
      actorUserId: session.user.id
    });
    return { currentVersion: result.currentVersion };
  });

/** Keyset presence/metadata — never any credential value. */
export const fetchEtsyKeysetStatus = createServerFn({ method: 'GET' }).handler(
  async (): Promise<EtsyKeysetStatus> => {
    const [{ requireAdmin }, { loadKeyset }] = await Promise.all([
      import('@/server/admin'),
      import('@/server/etsy-oauth-internal')
    ]);
    await requireAdmin();
    const resolved = await loadKeyset();
    if (resolved === null) {
      return { configured: false, source: null };
    }
    return { configured: true, source: resolved.source };
  }
);

/**
 * The exact callback URL this installation answers on. Etsy takes the
 * literal callback URL as `redirect_uri` — unlike eBay's RuName
 * indirection, there is no portal-side registration step that generates a
 * second value; the operator registers this URL directly with Etsy.
 */
export const fetchEtsyCallbackUrl = createServerFn({ method: 'GET' }).handler(
  async (): Promise<EtsyCallbackUrlInfo> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const configured = getAdminServices().config.publicOrigin;
    const publicOrigin =
      configured === undefined || configured === '' ? null : configured.replace(/\/+$/, '');
    return {
      publicOrigin,
      callbackUrl: publicOrigin === null ? null : `${publicOrigin}${ETSY_CALLBACK_PATH}`,
      callbackPath: ETSY_CALLBACK_PATH
    };
  }
);

// ---------------------------------------------------------------------------
// Consent start
// ---------------------------------------------------------------------------

export interface StartEtsyConsentResult {
  url: string;
  scopes: string[];
  tier: EtsyConsentTier;
  keysetSource: EtsyKeysetSource;
}

/**
 * Build the Etsy PKCE consent URL for one connection, plant the CSRF nonce
 * AND the PKCE code_verifier, and record the requested tier + shop-config
 * placeholder on the connection (Etsy's callback carries no scope
 * information back, exactly like eBay's — see `startEbayConsent`'s doc for
 * why the tier must be recorded here rather than trusted from the browser
 * later).
 */
export const startEtsyConsent = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ connectionId: z.uuid(), tier: consentTierSchema.optional() }))
  .handler(async ({ data }): Promise<StartEtsyConsentResult> => {
    const [{ requireAdmin, getAdminServices }, { setCookie, getRequestProtocol }, internal] =
      await Promise.all([
        import('@/server/admin'),
        import('@tanstack/react-start/server'),
        import('@/server/etsy-oauth-internal')
      ]);
    const integration = await internal.etsyIntegration();
    const session = await requireAdmin();
    const services = getAdminServices();

    const connection = await services.connections.getConnection(data.connectionId);
    if (connection.provider !== ETSY_CONNECTION_PROVIDER) {
      throw new internal.EtsyOAuthSetupError(
        `Connection ${connection.id} has provider "${connection.provider}"; Etsy consent needs an "${ETSY_CONNECTION_PROVIDER}" connection.`,
        400
      );
    }
    if (connection.status === 'archived') {
      throw new internal.EtsyOAuthSetupError(
        `Connection ${connection.id} is archived. Unarchive it before connecting an Etsy shop to it.`,
        400
      );
    }

    const tier: EtsyConsentTier = data.tier ?? DEFAULT_ETSY_CONSENT_TIER;
    const { keyset, source: keysetSource } = await internal.requireKeyset();
    const state = integration.buildConsentState(connection.id);
    const { codeVerifier, codeChallenge } = integration.generatePkcePair();
    const protocol = getRequestProtocol();
    const publicOrigin = services.config.publicOrigin;
    const redirectUri =
      publicOrigin !== undefined && publicOrigin !== ''
        ? `${publicOrigin.replace(/\/+$/, '')}${ETSY_CALLBACK_PATH}`
        : `${protocol}://127.0.0.1:3020${ETSY_CALLBACK_PATH}`;
    const consent = integration.buildConsentUrl({
      keystring: keyset.keystring,
      redirectUri,
      state: state.state,
      scopes: integration.consentScopesForTier(tier),
      codeChallenge
    });

    // Remembered for the callback (the tier eBay's/Etsy's callback carries
    // no scope information to recover) and for the exchange (redirectUri
    // must match exactly).
    await services.connections.updateConnection(
      connection.id,
      {
        config: {
          ...connection.config,
          [ETSY_CONSENT_REQUEST_CONFIG_KEY]: {
            tier,
            redirectUri,
            requestedAt: new Date().toISOString()
          }
        }
      },
      { actorUserId: session.user.id }
    );

    const cookieOptions = {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: protocol === 'https',
      path: ETSY_CALLBACK_PATH,
      maxAge: CONSENT_COOKIE_MAX_AGE_SECONDS
    };
    setCookie(ETSY_CONSENT_NONCE_COOKIE, state.nonce, cookieOptions);
    setCookie(ETSY_CONSENT_PKCE_COOKIE, codeVerifier, cookieOptions);

    return { url: consent.url, scopes: consent.scopes, tier, keysetSource };
  });

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface EtsyValidationResult {
  ok: boolean;
  message: string;
  errorKind?: EtsyErrorKind;
}

/**
 * Reports whether the Etsy application keyset can currently authenticate —
 * `openapi-ping`, the cheapest authenticated-with-just-the-keyset call this
 * adapter has a shape for (public auth, no per-connection state).
 */
export const validateEtsyConnection = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ connectionId: z.uuid() }))
  .handler(async ({ data }): Promise<EtsyValidationResult> => {
    const [{ requireAdmin, getAdminServices }, internal] = await Promise.all([
      import('@/server/admin'),
      import('@/server/etsy-oauth-internal')
    ]);
    const integration = await internal.etsyIntegration();
    const session = await requireAdmin();
    const services = getAdminServices();

    const connection = await services.connections.getConnection(data.connectionId);
    if (connection.provider !== ETSY_CONNECTION_PROVIDER) {
      throw new internal.EtsyOAuthSetupError(
        `Connection ${connection.id} has provider "${connection.provider}"; Etsy validation needs an "${ETSY_CONNECTION_PROVIDER}" connection.`,
        400
      );
    }

    let keyset: EtsyKeyset;
    try {
      keyset = (await internal.requireKeyset()).keyset;
    } catch (error) {
      const message =
        error instanceof internal.EtsyOAuthSetupError ? error.message : 'Etsy is not configured.';
      return { ok: false, message };
    }

    try {
      const adapter = integration.createEtsyAdapter({
        keystring: keyset.keystring,
        sharedSecret: keyset.sharedSecret,
        rateBudget: integration.createRateBudget({ capacity: 5, refillPerSecond: 5 })
      });
      const result = await integration.probeConnection(adapter);
      if (!result.ok) {
        throw Object.assign(new Error(result.error?.message ?? 'Etsy validation failed.'), {
          kind: result.error?.kind
        });
      }
    } catch (error) {
      const rawKind = (error as { kind?: unknown } | undefined)?.kind;
      const kind: EtsyErrorKind =
        typeof rawKind === 'string' ? (rawKind as EtsyErrorKind) : 'provider_unavailable';
      const message = error instanceof Error ? error.message : 'Etsy validation failed.';
      await services.connections
        .recordConnectionFailure(
          connection.id,
          { errorCode: `etsy_validate_${kind}` },
          { actorUserId: session.user.id }
        )
        .catch(() => undefined);
      return { ok: false, message, errorKind: kind };
    }

    await services.connections.recordConnectionSuccess(connection.id, {
      actorUserId: session.user.id
    });
    return { ok: true, message: 'Etsy accepted the application keyset (openapi-ping succeeded).' };
  });
