/**
 * Typed adapter configuration (zod at the boundary). Nothing here reads
 * `process.env` — runtime credentials come from the connection model
 * (ADR-0016/ADR-0019); the env-file helper in `credentials.ts` is dev/test
 * only.
 *
 * ## Base URL is fixed, not configurable
 *
 * Reverb is a single hosted API with no per-deployment base URL and no
 * sandbox host — SOURCE-VERIFIED against
 * https://www.reverb-api.com/docs/updating-your-listing and
 * https://www.reverb-api.com/docs/retrieve-orders (both fetched 2026-08-13),
 * whose every example endpoint is rooted at `https://api.reverb.com/api`.
 * This adapter hard-codes it rather than accepting one, the same choice
 * `@loxep/integration-etsy/config.ts` makes and unlike the self-hosted
 * WooCommerce/Medusa/Invoice Ninja adapters, which take a per-deployment
 * `baseUrl`.
 *
 * ## Auth — a single bearer token, SOURCE-VERIFIED
 *
 * `Authorization: Bearer <personalAccessToken>` on every request
 * (https://www.reverb-api.com/docs/authentication). There is no separate
 * app-level keyset the way eBay/Etsy have one — the Personal Access Token
 * IS the whole credential, and it does not expire (no refresh flow exists).
 *
 * ## Required headers baked in by the adapter, not configured here
 *
 * `Content-Type`/`Accept: application/hal+json` and `Accept-Version: 3.0`
 * are mandatory on every call
 * (https://www.reverb-api.com/docs/http-headers,
 * https://www.reverb-api.com/docs/getting-started) — a genuine divergence
 * from eBay/Etsy, neither of which has a request-level API version header.
 * `adapter.ts` sets them on every request; they are not adapter config
 * because they are protocol facts, not deployment facts.
 */
import { z } from "zod";
import { ReverbAdapterError } from "./errors.ts";
import type { RateBudget, ReverbAdapterLogger } from "./rate-budget.ts";

/** Reverb's fixed API base URL — not configurable per deployment. */
export const REVERB_API_BASE_URL = "https://api.reverb.com/api";

/** Mandatory on every Reverb request — see the module doc. */
export const REVERB_API_VERSION = "3.0";

export const reverbAdapterConfigSchema = z.strictObject({
  /** The connection's Personal Access Token (does not expire). */
  personalAccessToken: z.string().min(1),
  /** Per-request timeout. Default 30s, matching the other fetch-based adapters. */
  timeoutMs: z.number().int().positive().max(600_000).default(30_000),
});

export type ReverbAdapterConfig = z.output<typeof reverbAdapterConfigSchema>;

export type ReverbAdapterConfigInput = z.input<typeof reverbAdapterConfigSchema> & {
  logger?: ReverbAdapterLogger;
  /**
   * The rate budget every request acquires from. Optional — when omitted
   * the adapter creates a conservative PRIVATE default (see `adapter.ts`),
   * matching Woo's "no injected budget means a private default" contract.
   * UNLIKE Etsy, there is no requirement to pass a SHARED instance: Reverb's
   * limit is per-connection (see `rate-budget.ts`'s module doc), so a
   * private default per adapter instance is exactly the right shape.
   */
  rateBudget?: RateBudget;
};

/**
 * Parse and validate adapter config. Zod issues are reported as
 * `invalid_request` with paths and codes only — never received values, which
 * may be credential material.
 */
export function parseReverbAdapterConfig(
  input: Omit<ReverbAdapterConfigInput, "logger" | "rateBudget">,
): ReverbAdapterConfig {
  const result = reverbAdapterConfigSchema.safeParse(input);
  if (!result.success) {
    throw new ReverbAdapterError(
      "invalid_request",
      "invalid Reverb adapter configuration",
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
 * A stable per-connection identity string, computable with no API call — the
 * design's documented `source_account_key 'reverb:<connectionId>'`. UNLIKE
 * every sibling except Purelymail, this is NOT derived from a Reverb-reported
 * account fact (Reverb exposes no account identifier without a live
 * `/my/account` call) — see the design doc's "Credential bundle" section for
 * the collision caveat this implies.
 */
export function reverbSourceAccountKey(connectionId: string): string {
  const trimmed = connectionId.trim();
  if (trimmed === "") {
    throw new ReverbAdapterError(
      "invalid_request",
      "connectionId is required to compute a Reverb source_account_key",
    );
  }
  return `reverb:${trimmed}`;
}
