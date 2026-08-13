/**
 * Typed adapter configuration (zod at the boundary). Nothing here reads
 * `process.env` — runtime credentials come from the connection model
 * (ADR-0009/ADR-0016/ADR-0019); the env-file helper in `credentials.ts` is
 * dev/test only.
 *
 * ## Auth, LIVE-VERIFIED 2026-08-13
 *
 * ```text
 * base URL   https://purelymail.com          (OpenAPI servers[0].url)
 * transport  POST /api/v0/<operation>, application/json, always
 * auth       Purelymail-Api-Token: <token>   (OpenAPI securitySchemes.token:
 *                                             {type: apiKey, in: header})
 * ```
 *
 * The header name is confirmed three ways: the published OpenAPI document's
 * `components.securitySchemes.token.name`, Raycast's published Purelymail
 * extension, and a live probe whose failure message names the header itself —
 * *"Token must be supplied in Purelymail-Api-Token header"*.
 *
 * `servers[1].url` in the same document is `https://localhost:1443`, which is
 * the provider's own development server. It is deliberately not offered as a
 * preset; {@link normalizePurelymailBaseUrl} accepts any absolute URL so a
 * self-hosted or proxied deployment stays possible, and defaults to production.
 *
 * ## There is no account identifier
 *
 * Unlike Cloudflare (`accountId`), WooCommerce (store URL), or Medusa (backend
 * URL), Purelymail exposes no account identity at all: the token IS the
 * account, and no endpoint takes or returns an account id. `connections.config`
 * therefore carries nothing for this provider, and
 * {@link purelymailSourceAccountKey} derives its key from the base URL alone.
 *
 * That matters for a specific reason rather than as trivia: the commerce
 * design's `source_account_key` must distinguish two connections pointed at
 * different accounts, and here it CANNOT. Two Purelymail connections against
 * the same host produce the same key, so the connection id remains the only
 * discriminator. Stated plainly so nobody later treats the key as unique.
 *
 * Zod issues are reported as `invalid_request` with paths and CODES only —
 * never the received values, which are credential material here.
 */
import { z } from "zod";
import { PurelymailAdapterError } from "./errors.ts";
import type { PurelymailAdapterLogger, RateBudget } from "./rate-budget.ts";

/** From the published OpenAPI document's `servers[0].url`. */
export const PURELYMAIL_DEFAULT_BASE_URL = "https://purelymail.com";

/** The API-key header, live-verified. */
export const PURELYMAIL_TOKEN_HEADER = "Purelymail-Api-Token";

/**
 * `listUser` is documented as returning users *"up to 1000"* with no paging
 * parameter of any kind — no `page`, no `cursor`, no `per_page`. Exported so a
 * caller can tell "this account has fewer than a thousand mailboxes" apart from
 * "this is all of them", which is otherwise indistinguishable.
 */
export const PURELYMAIL_LIST_USER_LIMIT = 1000;

/** Default per-request timeout. */
export const PURELYMAIL_DEFAULT_TIMEOUT_MS = 20_000;

export function normalizePurelymailBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new PurelymailAdapterError(
      "invalid_request",
      "Purelymail base URL must be an absolute http(s) URL",
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new PurelymailAdapterError(
      "invalid_request",
      "Purelymail base URL must use http or https",
      { protocol: parsed.protocol },
    );
  }
  // Refuse a base URL that smuggles anything, matching the Cloudflare
  // sibling's guard. Two of these are security-relevant and one is a silent
  // functional break:
  //
  //   userinfo   `https://user:pass@purelymail.com` makes `fetch` emit its own
  //              Basic `Authorization` header — a credential this adapter
  //              never chose to send, from a field nothing redacts;
  //   query      the adapter builds URLs by concatenation, so a base carrying
  //              `?x=1` swallows the path into the query string and EVERY
  //              call silently hits `/` instead of the operation;
  //   fragment   never sent over the wire, so its presence means the value is
  //              not what its author thinks it is.
  //
  // None is reachable from the connection model — this is operator-inflicted —
  // but each fails in a way that looks like a provider problem.
  if (parsed.username !== "" || parsed.password !== "") {
    throw new PurelymailAdapterError(
      "invalid_request",
      "Purelymail base URL must not embed credentials",
    );
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new PurelymailAdapterError(
      "invalid_request",
      "Purelymail base URL must not carry a query string or fragment",
    );
  }
  return trimmed;
}

export const purelymailAdapterConfigSchema = z.strictObject({
  /** The API token. Never logged, never returned, never in a URL. */
  apiToken: z.string().min(1),
  baseUrl: z.string().min(1).default(PURELYMAIL_DEFAULT_BASE_URL),
  timeoutMs: z.number().int().positive().default(PURELYMAIL_DEFAULT_TIMEOUT_MS),
});

export type PurelymailAdapterConfigInput = z.input<
  typeof purelymailAdapterConfigSchema
> & {
  logger?: PurelymailAdapterLogger;
  rateBudget?: RateBudget;
};

export interface PurelymailAdapterConfig {
  apiToken: string;
  baseUrl: string;
  timeoutMs: number;
}

export function parsePurelymailAdapterConfig(
  input: unknown,
): PurelymailAdapterConfig {
  const result = purelymailAdapterConfigSchema.safeParse(input);
  if (!result.success) {
    // Paths and codes only. The received value is a credential.
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
      .join("; ");
    throw new PurelymailAdapterError(
      "invalid_request",
      `invalid Purelymail adapter configuration: ${issues}`,
    );
  }
  return {
    apiToken: result.data.apiToken,
    baseUrl: normalizePurelymailBaseUrl(result.data.baseUrl),
    timeoutMs: result.data.timeoutMs,
  };
}

/**
 * A stable, NON-SECRET key for the provider account this adapter talks to.
 *
 * Purelymail exposes no account identifier, so this is the host and nothing
 * else. See the module doc: it is not unique across two connections holding two
 * different tokens for the same host, and it must not be used as one.
 */
export function purelymailSourceAccountKey(baseUrl: string): string {
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = "unknown";
  }
  return `purelymail:${host}`;
}

/**
 * `local_part@domain` — the FULL address form three operations require
 * (`deleteUser`, `getUser`, `modifyUser` all document `userName` as *"Full
 * username, e.g. 'user@domain.com'"*), while `createUser` takes the local part
 * and the domain SEPARATELY (*"Local part of username, e.g. 'user' in
 * 'user@domain.com'"*).
 *
 * That asymmetry inside one API is exactly the kind of thing that is got wrong
 * once and then debugged twice, so the join lives in one exported function and
 * the adapter's create path is the only place that does not call it.
 */
export function purelymailFullAddress(
  localPart: string,
  domainName: string,
): string {
  return `${localPart}@${domainName}`;
}
