/**
 * Etsy OAuth internal helpers (loxep-g4t.1) — split out of `@/server/etsy-oauth`
 * for the EXACT reason `@/server/ebay-oauth-internal.ts`'s module doc
 * documents for eBay: `createServerFn(...).handler(fn)` bodies are stripped
 * from the client bundle by TanStack Start's `server-fn:client` Vite
 * plugin, but only that literal `.handler(fn)` callback — a SEPARATE,
 * shared top-level function a handler merely CALLS is not something that
 * plugin strips, and Rollup resolves every `import()` call it can see while
 * constructing the client build's graph, before tree-shaking can prove a
 * call site dead. `@loxep/integration-etsy`'s `oauth.ts` touches
 * `node:crypto` (PKCE's SHA-256 challenge derivation, the consent-state
 * hash) in a way the browser build cannot externalize, so the same hazard
 * applies here as it does to `ebay-api`.
 *
 * THE FIX: every handler in `@/server/etsy-oauth` reaches this module ONLY
 * via `await import('@/server/etsy-oauth-internal')` INSIDE its `.handler()`
 * body. `@/server/etsy-oauth-callback.ts` (server-only, reached only from
 * the consent-callback API route) imports this module statically — safe,
 * since nothing client-side ever reaches that file either.
 *
 * WIRING CAVEAT: `apps/web/package.json` does not yet declare
 * `@loxep/integration-etsy` (this change's write fence excludes every
 * package.json), so it is reached through a workspace-relative import
 * rather than the package name — the exact caveat this module's eBay
 * sibling records for its own (now-resolved) dependency gap. Declaring the
 * proper `workspace:*` dependency and switching this specifier to the
 * package-name form is a one-line follow-up once a package.json change is
 * in scope.
 */

/** Mirrors `@/server/etsy-oauth`'s `ETSY_KEYSET_SECRET_KEY`. */
const ETSY_KEYSET_SECRET_KEY = 'integration.etsy.keyset';

export interface EtsyKeyset {
  keystring: string;
  sharedSecret: string;
}

export type EtsyKeysetSource = 'secret' | 'dev-file';

type EtsyIntegration = typeof import('@loxep/integration-etsy');

let integrationPromise: Promise<EtsyIntegration> | undefined;

/** Runtime handle on the integration boundary. */
export async function etsyIntegration(): Promise<EtsyIntegration> {
  integrationPromise ??= import('@loxep/integration-etsy');
  return integrationPromise;
}

/**
 * Resolve the keyset by the documented precedence (application secret, then
 * the local dev env file — Etsy has no sandbox, so that file is a dev
 * convenience only, see `@loxep/integration-etsy/credentials.ts`).
 */
export async function loadKeyset(): Promise<{
  keyset: EtsyKeyset;
  source: EtsyKeysetSource;
} | null> {
  const [{ getAdminServices }, { SecretNotFoundError }] = await Promise.all([
    import('@/server/admin'),
    import('@loxep/domain')
  ]);
  try {
    const { payload } = await getAdminServices().secrets.getSecretPayload(
      ETSY_KEYSET_SECRET_KEY,
      'etsy_keyset'
    );
    return { keyset: payload as EtsyKeyset, source: 'secret' };
  } catch (error) {
    if (!(error instanceof SecretNotFoundError)) throw error;
  }
  const { loadDevKeysetFromEnvFile } = await etsyIntegration();
  const devCredentials = loadDevKeysetFromEnvFile();
  return devCredentials === null ? null : { keyset: devCredentials, source: 'dev-file' };
}

/** Error whose message is safe to show an administrator. */
export class EtsyOAuthSetupError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'EtsyOAuthSetupError';
    this.status = status;
  }
}

export async function requireKeyset(): Promise<{
  keyset: EtsyKeyset;
  source: EtsyKeysetSource;
}> {
  const resolved = await loadKeyset();
  if (resolved === null) {
    throw new EtsyOAuthSetupError(
      `No Etsy application keyset is configured. Store one as the application secret "${ETSY_KEYSET_SECRET_KEY}" ` +
        '(server function storeEtsyKeyset), or, for local development, create ~/.config/loxep/etsy-sandbox.env.'
    );
  }
  return resolved;
}
