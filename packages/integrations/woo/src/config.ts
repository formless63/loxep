/**
 * Typed adapter configuration (zod at the boundary). Nothing here reads
 * `process.env` — runtime credentials come from the connection model
 * (ADR-0009/ADR-0016/ADR-0019); the env-file helper in `credentials.ts` is
 * dev/test only.
 *
 * TRANSPORT SECURITY IS NOT OPTIONAL HERE. The WooCommerce REST API offers
 * two authentication modes (verified against the current REST API docs):
 *
 * 1. HTTPS — HTTP Basic Auth with the consumer key as username and the
 *    consumer secret as password. This is what Loxep implements.
 * 2. HTTP — OAuth 1.0a "one-legged" with an HMAC-SHA256 signature over the
 *    query string, precisely because plain Basic Auth over HTTP would put the
 *    key pair on the wire in cleartext.
 *
 * Loxep implements (1) only and REJECTS an `http:` base URL at config parse
 * time. Implementing (2) would mean building a signing path whose entire
 * purpose is to make an insecure deployment usable, and whose failure mode is
 * a leaked store credential. A self-hosted shop that cannot do TLS is a
 * problem to fix, not to accommodate.
 *
 * Zod issues are reported as `invalid_request` with paths and CODES only —
 * never the received values, which are credential material here.
 */
import { z } from "zod";
import { WooAdapterError } from "./errors.ts";
import type { RateBudget, WooAdapterLogger } from "./rate-budget.ts";

/** WooCommerce's REST namespace. `wc/v3` is current; `wc/v1`/`v2` are legacy. */
export const WOO_DEFAULT_NAMESPACE = "wc/v3";

/** WordPress's REST root path segment. Configurable on exotic installs. */
export const WOO_DEFAULT_REST_ROOT = "/wp-json";

export const wooAdapterConfigSchema = z.strictObject({
  /** Store root URL, e.g. `https://shop.example.com` (https only). */
  baseUrl: z.string().min(1),
  consumerKey: z.string().min(1),
  consumerSecret: z.string().min(1),
  namespace: z
    .string()
    .regex(/^wc\/v\d+$/)
    .default(WOO_DEFAULT_NAMESPACE),
  restRoot: z
    .string()
    .regex(/^\/[A-Za-z0-9._~\-/]*$/)
    .default(WOO_DEFAULT_REST_ROOT),
  /** Per-request timeout. Self-hosted WP is slow; 30s is a real value. */
  timeoutMs: z.number().int().positive().max(600_000).default(30_000),
});

export type WooAdapterConfig = z.output<typeof wooAdapterConfigSchema>;

export type WooAdapterConfigInput = z.input<typeof wooAdapterConfigSchema> & {
  logger?: WooAdapterLogger;
  /**
   * Per-connection token bucket every request acquires from. When omitted the
   * adapter creates a conservative private default (capacity 5, refill 2/s);
   * pass a shared budget to pool several adapters onto one store's budget.
   */
  rateBudget?: RateBudget;
};

/**
 * Normalize a store root URL: require https, strip trailing slashes, strip an
 * accidentally-included `/wp-json` suffix, and refuse a URL carrying its own
 * credentials or query string.
 *
 * The `user:pass@host` rejection is credential hygiene, not pedantry: URL
 * userinfo is the one place a base URL can smuggle a secret that would then
 * be safe to log by every other rule in this package.
 */
export function normalizeWooBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WooAdapterError(
      "invalid_request",
      "WooCommerce baseUrl is not a valid absolute URL",
    );
  }
  if (url.protocol !== "https:") {
    throw new WooAdapterError(
      "invalid_request",
      "WooCommerce baseUrl must use https: — Loxep does not implement the " +
        "OAuth 1.0a one-legged fallback that plain-HTTP stores require",
      { protocol: url.protocol },
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new WooAdapterError(
      "invalid_request",
      "WooCommerce baseUrl must not embed credentials (user:pass@host)",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new WooAdapterError(
      "invalid_request",
      "WooCommerce baseUrl must not carry a query string or fragment",
    );
  }
  let path = url.pathname.replace(/\/+$/, "");
  // Tolerate a pasted REST root; the adapter appends it itself.
  if (path.endsWith(WOO_DEFAULT_REST_ROOT)) {
    path = path.slice(0, -WOO_DEFAULT_REST_ROOT.length);
  }
  return `${url.origin}${path}`;
}

/**
 * Parse and validate adapter config. Returns the normalized config INCLUDING
 * the secret; the adapter keeps it in a closure and never re-exposes it.
 */
export function parseWooAdapterConfig(
  input: Omit<WooAdapterConfigInput, "logger" | "rateBudget">,
): WooAdapterConfig {
  const result = wooAdapterConfigSchema.safeParse(input);
  if (!result.success) {
    throw new WooAdapterError(
      "invalid_request",
      "invalid WooCommerce adapter configuration",
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
    );
  }
  return { ...result.data, baseUrl: normalizeWooBaseUrl(result.data.baseUrl) };
}

/**
 * The design doc's `orders.source_account_key` for this provider:
 * `woocommerce:<siteUrl>`. Deterministic from configuration alone, which is
 * what the Commerce Schema Design requires of every adapter so that
 * cross-connection duplicate orders stay DETECTABLE without the order key
 * itself depending on it.
 */
export function wooSourceAccountKey(baseUrl: string): string {
  return `woocommerce:${normalizeWooBaseUrl(baseUrl)}`;
}
