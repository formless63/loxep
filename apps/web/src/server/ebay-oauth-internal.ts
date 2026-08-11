/**
 * eBay OAuth internal helpers (loxep-62y.5) — split out of `@/server/ebay-oauth`
 * so that module (which client components import directly, for its
 * `createServerFn` exports) never contains a MODULE-SCOPE function whose body
 * calls `import('@loxep/integration-ebay')`.
 *
 * WHY THE SPLIT (found building `apps/web` for production once client code
 * started importing from `@/server/ebay-oauth`): `createServerFn(...).handler(fn)`
 * bodies ARE stripped from the client bundle by TanStack Start's
 * `server-fn:client` Vite plugin — but only that literal `.handler(fn)`
 * callback. A SEPARATE, shared top-level function that a handler merely
 * CALLS (this file's previous home inside `ebay-oauth.ts`, as
 * `ebayIntegration()`/`loadKeyset()`/`requireKeyset()`/`adapterForKeyset()`)
 * is not something that plugin strips, and Rollup resolves every `import()`
 * call it can see in a module that is part of a build's graph WHILE
 * constructing that graph — before tree-shaking can prove any particular
 * call site dead. Since `ebay-api` (`@loxep/integration-ebay`'s dependency)
 * touches Node's `crypto` in a way the browser build cannot externalize,
 * that resolution step hard-fails the CLIENT production build the moment
 * ANY client-reachable module merely CONTAINS such a call — regardless of
 * whether it is ever invoked at runtime.
 *
 * THE FIX: every handler in `@/server/ebay-oauth` reaches this module ONLY
 * via `await import('@/server/ebay-oauth-internal')` INSIDE its `.handler()`
 * body — the exact `@/server/admin` pattern `admin-functions.ts`/
 * `market-functions.ts` already use for their own heavy dependencies. That
 * dynamic-import call site is erased along with the rest of the handler body
 * by the client-side transform, so Rollup's CLIENT graph never reaches this
 * file, and therefore never reaches `@loxep/integration-ebay`.
 * `@/server/ebay-oauth-callback.ts` (server-only, reached only from the
 * consent-callback API route) imports this module statically — safe, since
 * nothing client-side ever reaches that file either.
 */

/** Mirrors `@/server/ebay-oauth`'s `EBAY_KEYSET_SECRET_KEY` (duplicated, not imported, to keep this module's only dependency edge on `@loxep/integration-ebay`). */
const EBAY_KEYSET_SECRET_KEY = 'integration.ebay.keyset';
/** Mirrors `@/server/ebay-oauth`'s `EBAY_CALLBACK_PATH`. */
const EBAY_CALLBACK_PATH = '/api/integrations/ebay/callback';

export interface EbayKeyset {
  appId: string;
  certId: string;
  devId: string;
  ruName?: string;
  environment: 'sandbox' | 'production';
}

export type EbayKeysetSource = 'secret' | 'dev-file';

type EbayIntegration = typeof import('@loxep/integration-ebay');

let integrationPromise: Promise<EbayIntegration> | undefined;

/** Runtime handle on the integration boundary. */
export async function ebayIntegration(): Promise<EbayIntegration> {
  integrationPromise ??= import('@loxep/integration-ebay');
  return integrationPromise;
}

/**
 * Resolve the keyset by the documented precedence (application secret, then
 * the local sandbox dev file). Returns `null` when neither source is
 * configured — callers turn that into an actionable message, never a stack
 * trace.
 */
export async function loadKeyset(): Promise<{
  keyset: EbayKeyset;
  source: EbayKeysetSource;
} | null> {
  const [{ getAdminServices }, { SecretNotFoundError }] = await Promise.all([
    import('@/server/admin'),
    import('@loxep/domain')
  ]);
  try {
    const { payload } = await getAdminServices().secrets.getSecretPayload(
      EBAY_KEYSET_SECRET_KEY,
      'ebay_keyset'
    );
    return { keyset: payload as EbayKeyset, source: 'secret' };
  } catch (error) {
    if (!(error instanceof SecretNotFoundError)) throw error;
  }
  const { loadSandboxCredentialsFromEnvFile } = await ebayIntegration();
  const devCredentials = loadSandboxCredentialsFromEnvFile();
  return devCredentials === null ? null : { keyset: devCredentials, source: 'dev-file' };
}

/** Error whose message is safe to show an administrator. */
export class EbayOAuthSetupError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'EbayOAuthSetupError';
    this.status = status;
  }
}

export async function requireKeyset(): Promise<{
  keyset: EbayKeyset;
  source: EbayKeysetSource;
}> {
  const resolved = await loadKeyset();
  if (resolved === null) {
    throw new EbayOAuthSetupError(
      `No eBay application keyset is configured. Store one as the application secret "${EBAY_KEYSET_SECRET_KEY}" ` +
        '(server function storeEbayKeyset), or, for local sandbox development, create ~/.config/loxep/ebay-sandbox.env.'
    );
  }
  if (resolved.keyset.ruName === undefined || resolved.keyset.ruName === '') {
    throw new EbayOAuthSetupError(
      'The eBay keyset has no RuName (eBay Redirect URL name). Add a redirect URL to the keyset in the eBay ' +
        `developer portal with "${EBAY_CALLBACK_PATH}" as its auth-accepted URL, then store the generated RuName.`
    );
  }
  return resolved;
}

/** Build a Loxep adapter for the resolved keyset. Never logs credentials. */
export async function adapterForKeyset(keyset: EbayKeyset) {
  const { createEbayAdapter } = await ebayIntegration();
  return createEbayAdapter({
    appId: keyset.appId,
    certId: keyset.certId,
    devId: keyset.devId,
    ...(keyset.ruName !== undefined ? { ruName: keyset.ruName } : {}),
    environment: keyset.environment
  });
}
