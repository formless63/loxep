/**
 * Typed adapter configuration (zod at the boundary). Nothing here reads
 * `process.env` — runtime credentials come from the connection model
 * (ADR-0009/ADR-0016/ADR-0019); the env-file helper in `credentials.ts` is
 * dev/test only.
 *
 * ## Base URL is fixed, not configurable
 *
 * Unlike the self-hosted WooCommerce/Medusa/Invoice Ninja adapters, Etsy is a
 * single hosted API with no per-deployment base URL — source-verified
 * against `anitabyte/etsyv3` (`main` branch, fetched 2026-08-13,
 * `etsyv3/etsy_api.py`): `ETSY_API_BASEURL = "https://api.etsy.com/v3/application"`.
 * This adapter hard-codes it rather than accepting one, so there is no
 * `baseUrl` field to validate or normalize.
 *
 * ## Auth headers — SOURCE-VERIFIED
 *
 * Confirmed in the same file's `EtsyAPI.__init__`:
 *
 * ```text
 * x-api-key:     <keystring>:<sharedSecret>     (every call)
 * Authorization: Bearer <etsyUserId>.<accessToken>   (private-auth calls only)
 * ```
 *
 * matching the binding design's "Auth: two tiers" section exactly. The
 * bearer value is the STORED token string verbatim — Etsy's own token
 * already carries the `<userId>.<accessToken>` shape (confirmed by the same
 * source: `self.user_id = token.split(".")[0]`), so this package's job is to
 * retain that shape end to end, never to split and reassemble it.
 *
 * ## The PKCE loopback exception
 *
 * Etsy's OAuth PKCE flow (see `oauth.ts`) requires an HTTPS redirect URI in
 * production but allows an `http://127.0.0.1` loopback for local development
 * (per the design's "Owner-action prerequisites", item 4). That exception is
 * validated where the redirect URI is actually used — `oauth.ts`'s consent-
 * URL builder — not here: this module's config carries no redirect URI at
 * all (it is supplied per consent attempt, a web-layer concern, exactly like
 * eBay's RuName is NOT part of `EbayAdapterConfig`... except eBay's RuName
 * genuinely is part of the keyset. Etsy's redirect URI is closer to a
 * per-request parameter, so `validateEtsyRedirectUri` lives in `oauth.ts`
 * next to the one function that consumes it).
 */
import { z } from "zod";
import { EtsyAdapterError } from "./errors.ts";
import type { EtsyAdapterLogger, RateBudget } from "./rate-budget.ts";

/** Etsy Open API v3's fixed base URL — not configurable per deployment. */
export const ETSY_API_BASE_URL = "https://api.etsy.com/v3/application";

export const etsyAdapterConfigSchema = z.strictObject({
  /** The approved Developer Portal app's keystring (public, but paired below). */
  keystring: z.string().min(1),
  /** The app's shared secret — sent alongside the keystring, never alone. */
  sharedSecret: z.string().min(1),
  /** Per-request timeout. Default 30s, matching the other fetch-based adapters. */
  timeoutMs: z.number().int().positive().max(600_000).default(30_000),
});

export type EtsyAdapterConfig = z.output<typeof etsyAdapterConfigSchema>;

export type EtsyAdapterConfigInput = z.input<typeof etsyAdapterConfigSchema> & {
  logger?: EtsyAdapterLogger;
  /**
   * The rate budget every request acquires from. UNLIKE the eBay/WooCommerce
   * adapters, this is NOT optional-with-a-private-default: Etsy's limit is
   * per APPLICATION (see `rate-budget.ts`'s module doc), so a caller that
   * omits this would get a private, per-adapter-instance bucket that
   * silently multiplies the app's real quota the moment a second connection
   * builds its own adapter. The composition root
   * (`packages/app/src/etsy.ts`) must build exactly ONE budget and pass the
   * SAME instance to every adapter it constructs.
   */
  rateBudget: RateBudget;
};

/**
 * Parse and validate adapter config. Zod issues are reported as
 * `invalid_request` with paths and codes only — never received values, which
 * may be credential material.
 */
export function parseEtsyAdapterConfig(
  input: Omit<EtsyAdapterConfigInput, "logger" | "rateBudget">,
): EtsyAdapterConfig {
  const result = etsyAdapterConfigSchema.safeParse(input);
  if (!result.success) {
    throw new EtsyAdapterError(
      "invalid_request",
      "invalid Etsy adapter configuration",
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
    );
  }
  return result.data;
}

/**
 * A stable per-connection identity string, computable from configuration
 * alone with no API call — the design's documented
 * `source_account_key 'etsy:<shopId>'` (a per-CONNECTION identity, unlike
 * `woo`/`medusa`/`invoiceninja`'s per-BASE-URL keys, because Etsy has one
 * fixed API host and the shop id is what actually distinguishes connections).
 */
export function etsySourceAccountKey(shopId: string): string {
  const trimmed = shopId.trim();
  if (trimmed === "") {
    throw new EtsyAdapterError(
      "invalid_request",
      "shopId is required to compute an Etsy source_account_key",
    );
  }
  return `etsy:${trimmed}`;
}
