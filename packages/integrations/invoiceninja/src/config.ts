/**
 * Typed adapter configuration (zod at the boundary). Nothing here reads
 * `process.env` — runtime credentials come from the connection model
 * (ADR-0009/ADR-0016/ADR-0019); the env-file helper in `credentials.ts` is
 * dev/test only.
 *
 * TRANSPORT SECURITY IS NOT OPTIONAL HERE, same reasoning as the
 * WooCommerce/Medusa adapters (`packages/integrations/{woo,medusa}/src/config.ts`).
 * Loxep rejects an `http:` base URL at config parse time — a real deployment
 * puts a self-hosted Invoice Ninja instance behind TLS the same way it would
 * any other admin surface holding customer billing data. (The live instance
 * verified for this package — see the module docs on `errors.ts`/`probe.ts` —
 * runs plain HTTP internally on a private Docker network with no host port
 * published, so it was reachable only via the container's bridge-network
 * IP, never over `https:`. That deployment shape is exactly why this rule
 * exists: it is not how Invoice Ninja is meant to be exposed to a caller
 * holding a real API token.)
 *
 * AUTHENTICATION — SOURCE-VERIFIED (`App\Http\Middleware\TokenAuth`,
 * `invoiceninja/invoiceninja`, `v5-stable` branch, fetched 2026-08-13:
 * https://github.com/invoiceninja/invoiceninja/blob/v5-stable/app/Http/Middleware/TokenAuth.php)
 * and LIVE-CONFIRMED (see `errors.ts`'s module doc for the live probe
 * evidence):
 *
 * ```text
 * X-API-TOKEN: <company token>
 * ```
 *
 * Invoice Ninja v5 authenticates every `/api/v1/*` call with a single header
 * carrying a `CompanyToken` value — there is no Basic/Bearer wrapping the way
 * Medusa's secret key is. The token is a company-scoped credential (a
 * self-hosted instance's Settings → Account Management → API Tokens screen
 * issues one per company/user pair) generated server-side as
 * `Str::random(64)` (`app/Jobs/Company/CreateCompanyToken.php`, same
 * branch/fetch) — a 64-character random alphanumeric string with NO fixed
 * prefix comparable to Medusa's `sk_`, so this adapter does not assert one.
 */
import { z } from "zod";
import { InvoiceNinjaAdapterError } from "./errors.ts";
import type { RateBudget, InvoiceNinjaAdapterLogger } from "./rate-budget.ts";

/** Invoice Ninja's fixed API path prefix — not configurable per deployment. */
export const INVOICENINJA_API_PATH = "/api/v1";

export const invoiceNinjaAdapterConfigSchema = z.strictObject({
  /** Instance root URL, e.g. `https://billing.example.com` (https only). */
  baseUrl: z.string().min(1),
  /** Company API token, sent as `X-API-TOKEN: <apiToken>`. */
  apiToken: z.string().min(1),
  /** Per-request timeout. Self-hosted Invoice Ninja is slow under load; 30s is real. */
  timeoutMs: z.number().int().positive().max(600_000).default(30_000),
});

export type InvoiceNinjaAdapterConfig = z.output<
  typeof invoiceNinjaAdapterConfigSchema
>;

export type InvoiceNinjaAdapterConfigInput = z.input<
  typeof invoiceNinjaAdapterConfigSchema
> & {
  logger?: InvoiceNinjaAdapterLogger;
  /**
   * Per-connection token bucket every request acquires from. When omitted
   * the adapter creates a conservative private default (capacity 5, refill
   * 2/s); pass a shared budget to pool several adapters onto one
   * deployment's budget.
   */
  rateBudget?: RateBudget;
};

/**
 * Normalize an Invoice Ninja instance root URL: require https, strip
 * trailing slashes, strip an accidentally-included `/api/v1` suffix, and
 * refuse a URL carrying its own credentials or query string. Same
 * credential-hygiene reasoning as `normalizeMedusaBaseUrl` /
 * `normalizeWooBaseUrl` — URL userinfo is the one place a base URL can
 * smuggle a secret that would otherwise be safe to log.
 */
export function normalizeInvoiceNinjaBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new InvoiceNinjaAdapterError(
      "invalid_request",
      "Invoice Ninja baseUrl is not a valid absolute URL",
    );
  }
  if (url.protocol !== "https:") {
    throw new InvoiceNinjaAdapterError(
      "invalid_request",
      "Invoice Ninja baseUrl must use https: — Loxep does not send API " +
        "tokens over an unencrypted transport",
      { protocol: url.protocol },
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new InvoiceNinjaAdapterError(
      "invalid_request",
      "Invoice Ninja baseUrl must not embed credentials (user:pass@host)",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new InvoiceNinjaAdapterError(
      "invalid_request",
      "Invoice Ninja baseUrl must not carry a query string or fragment",
    );
  }
  let path = url.pathname.replace(/\/+$/, "");
  // Tolerate a pasted API root; the adapter appends it itself.
  if (path.endsWith(INVOICENINJA_API_PATH)) {
    path = path.slice(0, -INVOICENINJA_API_PATH.length);
  }
  return `${url.origin}${path}`;
}

/**
 * Parse and validate adapter config. Returns the normalized config INCLUDING
 * the secret; the adapter keeps it in a closure and never re-exposes it.
 */
export function parseInvoiceNinjaAdapterConfig(
  input: Omit<InvoiceNinjaAdapterConfigInput, "logger" | "rateBudget">,
): InvoiceNinjaAdapterConfig {
  const result = invoiceNinjaAdapterConfigSchema.safeParse(input);
  if (!result.success) {
    throw new InvoiceNinjaAdapterError(
      "invalid_request",
      "invalid Invoice Ninja adapter configuration",
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
    baseUrl: normalizeInvoiceNinjaBaseUrl(result.data.baseUrl),
  };
}

/**
 * A stable per-connection identity string, computable from configuration
 * ALONE with no API call — the same discipline the Commerce Schema Design's
 * `orders.source_account_key` requires of Medusa/WooCommerce/eBay. Invoice
 * Ninja does not itself source `orders` rows (it is a Phase 6 billing
 * companion, not a commerce channel — see the Services & Billing Schema
 * Design's "Owner answers" section), so this key is not a
 * `source_account_key` in that schema's sense; it exists for the same
 * reason those keys do — a deterministic scope string for health/diagnostic
 * surfaces and for `external_resources` provenance — under the vocabulary
 * that document's "External-resource integration surfaces" section already
 * assigns to `provider = 'invoiceninja'`.
 */
export function invoiceNinjaSourceAccountKey(baseUrl: string): string {
  return `invoiceninja:${normalizeInvoiceNinjaBaseUrl(baseUrl)}`;
}
