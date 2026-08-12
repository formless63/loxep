/**
 * Typed adapter configuration (zod at the boundary). Nothing here reads
 * `process.env` — runtime credentials come from the connection model
 * (ADR-0009/ADR-0016/ADR-0019); the env-file helper in `credentials.ts` is
 * dev/test only.
 *
 * TRANSPORT SECURITY IS NOT OPTIONAL HERE, same reasoning as the
 * WooCommerce adapter (`packages/integrations/woo/src/config.ts`). Loxep
 * rejects an `http:` base URL at config parse time.
 *
 * The https rule has one practical consequence worth recording: a local
 * Medusa dev backend speaks plain http on :9000, so the live-verification
 * harness (loxep-xh9.4.1) puts an nginx TLS terminator in front of it rather
 * than relaxing this check. See `test/live-store.test.ts`.
 *
 * AUTHENTICATION — LIVE-VERIFIED against Medusa 2.18.0 on 2026-08-12
 * (loxep-xh9.4.1), and originally read from Medusa's own source:
 *
 * Medusa v2's Admin API supports three authentication mechanisms — session
 * cookie, JWT bearer (from an interactive email/password login), and a
 * long-lived "secret API key" created once in the admin dashboard
 * (Settings → Developer → Secret API Keys per
 * https://docs.medusajs.com/user-guide/settings/developer/secret-api-keys,
 * found via search; not independently fetched here). Loxep uses the secret
 * API key exclusively — it is the only one of the three that does not
 * require running an interactive login flow to mint a credential, which
 * matches the eBay/WooCommerce precedent of storing a durable credential on
 * the connection rather than a session.
 *
 * The wire format is NOT what "Basic" ordinarily means. Verified directly
 * from `authenticate-middleware.ts`
 * (https://github.com/medusajs/medusa/blob/develop/packages/core/framework/src/http/middlewares/authenticate-middleware.ts,
 * `develop` branch, fetched 2026-08-11):
 *
 * ```text
 * Authorization: Basic <secret-api-key>
 * ```
 *
 * The secret key itself (which always starts with `sk_`) is placed directly
 * after `Basic ` — it is NOT base64("user:pass"), and Loxep does not encode
 * it. The server's `getApiKeyInfo()` splits on the first space, and only
 * base64-decodes the remainder when it does *not* already start with `sk_`
 * (a back-compat path for callers that base64-encoded the token the way a
 * literal HTTP Basic client would).
 *
 * Live results on 2.18.0, all four variants exercised against a real
 * backend:
 *
 * ```text
 * Authorization: Basic sk_…                     → 200   ← what this adapter sends
 * Authorization: Basic base64("sk_…:")          → 200   ← the back-compat path, confirmed real
 * Authorization: Bearer sk_…                    → 401   ← with the message quoted below
 * (no Authorization header)                     → 401
 * Authorization: Basic sk_<fabricated>          → 401   ← body is {"message"} only
 * ```
 *
 * Sending the key as a `Bearer` token is explicitly rejected with a
 * dedicated 401 message pointing the caller back at `Authorization: Basic` —
 * confirmed in the source, and reproduced verbatim by the live backend:
 *
 * > "A secret API key was passed as a Bearer token. Secret API keys must be
 * > sent using HTTP Basic authentication instead (Authorization: Basic
 * > <secret-api-key>)."
 *
 * Zod issues are reported as `invalid_request` with paths and CODES only —
 * never the received values, which are credential material here.
 */
import { z } from "zod";
import { MedusaAdapterError } from "./errors.ts";
import type { RateBudget, MedusaAdapterLogger } from "./rate-budget.ts";

/** Medusa's fixed Admin API path prefix — not configurable per deployment. */
export const MEDUSA_ADMIN_PATH = "/admin";

/** Secret API keys are always issued with this prefix. */
const SECRET_KEY_PREFIX = "sk_";

export const medusaAdapterConfigSchema = z.strictObject({
  /** Backend root URL, e.g. `https://commerce.example.com` (https only). */
  baseUrl: z.string().min(1),
  /** Admin secret API key (`sk_...`), sent as `Authorization: Basic <token>`. */
  apiToken: z.string().min(1).startsWith(SECRET_KEY_PREFIX),
  /** Per-request timeout. Self-hosted Medusa is slow under load; 30s is real. */
  timeoutMs: z.number().int().positive().max(600_000).default(30_000),
});

export type MedusaAdapterConfig = z.output<typeof medusaAdapterConfigSchema>;

export type MedusaAdapterConfigInput = z.input<
  typeof medusaAdapterConfigSchema
> & {
  logger?: MedusaAdapterLogger;
  /**
   * Per-connection token bucket every request acquires from. When omitted the
   * adapter creates a conservative private default (capacity 5, refill 2/s);
   * pass a shared budget to pool several adapters onto one deployment's
   * budget.
   */
  rateBudget?: RateBudget;
};

/**
 * Normalize a Medusa backend root URL: require https, strip trailing
 * slashes, strip an accidentally-included `/admin` suffix, and refuse a URL
 * carrying its own credentials or query string. Same credential-hygiene
 * reasoning as `normalizeWooBaseUrl` — URL userinfo is the one place a base
 * URL can smuggle a secret that would otherwise be safe to log.
 */
export function normalizeMedusaBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new MedusaAdapterError(
      "invalid_request",
      "Medusa baseUrl is not a valid absolute URL",
    );
  }
  if (url.protocol !== "https:") {
    throw new MedusaAdapterError(
      "invalid_request",
      "Medusa baseUrl must use https: — Loxep does not send admin secret " +
        "API keys over an unencrypted transport",
      { protocol: url.protocol },
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new MedusaAdapterError(
      "invalid_request",
      "Medusa baseUrl must not embed credentials (user:pass@host)",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new MedusaAdapterError(
      "invalid_request",
      "Medusa baseUrl must not carry a query string or fragment",
    );
  }
  let path = url.pathname.replace(/\/+$/, "");
  // Tolerate a pasted admin API root; the adapter appends it itself.
  if (path.endsWith(MEDUSA_ADMIN_PATH)) {
    path = path.slice(0, -MEDUSA_ADMIN_PATH.length);
  }
  return `${url.origin}${path}`;
}

/**
 * Parse and validate adapter config. Returns the normalized config INCLUDING
 * the secret; the adapter keeps it in a closure and never re-exposes it.
 */
export function parseMedusaAdapterConfig(
  input: Omit<MedusaAdapterConfigInput, "logger" | "rateBudget">,
): MedusaAdapterConfig {
  const result = medusaAdapterConfigSchema.safeParse(input);
  if (!result.success) {
    throw new MedusaAdapterError(
      "invalid_request",
      "invalid Medusa adapter configuration",
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
    );
  }
  return {
    ...result.data,
    baseUrl: normalizeMedusaBaseUrl(result.data.baseUrl),
  };
}

/**
 * The design doc's `orders.source_account_key` for this provider.
 *
 * The Commerce Schema Design's own starting-point example is
 * `medusa:<storeId>` (a design placeholder, not an observed payload — see
 * "Before implementing this schema" item 4 in
 * `commerce-schema-design.md`). This adapter uses `medusa:<baseUrl>` instead,
 * for the identical reason `wooSourceAccountKey` uses `<siteUrl>` rather
 * than a provider-reported id: it must be computable from configuration
 * ALONE, with no API call, so ingestion can always populate it (design item
 * 5, "confirm that each provider adapter can compute `source_account_key`
 * deterministically").
 *
 * Medusa v2 does have a Store module (`GET /admin/stores`) that could supply
 * a genuine store id, and a single backend can technically host more than
 * one `Store` row — but resolving that costs a network call this adapter
 * would rather not require just to compute an account-scope string, and the
 * overwhelmingly common deployment shape is one Medusa backend, one store.
 * If a real installation ever runs multiple stores behind one Admin API base
 * URL, `source_account_key` will not disambiguate them; that is the same
 * class of limitation the design's open question 2 already accepts for
 * WooCommerce and eBay (detect, don't constrain).
 */
export function medusaSourceAccountKey(baseUrl: string): string {
  return `medusa:${normalizeMedusaBaseUrl(baseUrl)}`;
}
