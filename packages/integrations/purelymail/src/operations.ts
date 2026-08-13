/**
 * **The single map of Purelymail operation names.**
 *
 * Purelymail's API is RPC-shaped: every operation is a `POST` to
 * `/api/v0/<operationName>` with a JSON body, and there are no path parameters,
 * no query strings, and no verbs other than `POST`. The whole protocol surface
 * is therefore a name. loxep-lmy.2's scope note makes the consequence a
 * requirement: build one generic call function plus one exported map, **so a
 * wrong name is a one-line fix** rather than a change spread across nine
 * methods.
 *
 * ## Provenance
 *
 * Every name below is transcribed from the provider's own OpenAPI document —
 * `window.swaggerSpec` in `https://news.purelymail.com/api/swagger-spec.js`,
 * the script the Swagger UI at `https://news.purelymail.com/api/index.html`
 * loads — retrieved and parsed on **2026-08-13** (`info.title` "Purelymail
 * API", `info.version` "0.0.1", `servers[0].url` `https://purelymail.com`).
 * The document lists exactly nineteen paths; all nineteen are here, including
 * the ones Loxep does not call, because an operation missing from this map is
 * invisible and one that is present but unused is obvious.
 *
 * The paths are transcribed rather than the request/response schemas, which
 * live as Loxep-owned types in `adapter.ts` per ADR-0009 #5. Two of them are
 * live-verified as a side effect of the auth probe recorded in `errors.ts`:
 * `checkAccountCredit` exists and answers, and a path that does NOT exist
 * answers HTTP 404 with an HTML page rather than an envelope — which is exactly
 * how a typo in this map would present.
 *
 * ## UNVERIFIED
 *
 * Names marked below are transcribed from the document and have **not** been
 * exercised against a live account, because no Purelymail API key exists yet.
 * That is the same stance `@loxep/integration-medusa` and
 * `@loxep/integration-ebay` take for their unexercised operations. `test/
 * live-purelymail.test.ts` skips cleanly until `~/.config/loxep/purelymail.env`
 * exists and confirms them when it does.
 */

/**
 * Operation name → path segment. The value is what goes after `/api/v0/`.
 *
 * Keys are Loxep-owned labels in `noun.verb` form, matching the operation
 * labels used in error details and run steps across every other adapter
 * (`dns.records.list`, `orders.list`). Values are the provider's names.
 */
export const PURELYMAIL_OPERATIONS = {
  /* ---- Domains ---------------------------------------------------------- */
  /** UNVERIFIED. Body `{domainName}`. Requires the ownership TXT to resolve. */
  "domain.add": "addDomain",
  /** UNVERIFIED. Body `{}` — the code is per ACCOUNT, not per domain. */
  "domain.ownershipCode": "getOwnershipCode",
  /** UNVERIFIED. Body `{includeShared?}`. The read-back path for a pending add. */
  "domain.list": "listDomains",
  /** UNVERIFIED. Body `{name, allowAccountReset?, symbolicSubaddressing?, recheckDns?}`. */
  "domain.updateSettings": "updateDomainSettings",
  /** UNVERIFIED. Body `{name}`. Loxep never calls this; listed for completeness. */
  "domain.delete": "deleteDomain",

  /* ---- Users (mailboxes) ------------------------------------------------ */
  /** UNVERIFIED. Body `{userName, domainName, password, ...}`. BILLABLE. */
  "user.create": "createUser",
  /** UNVERIFIED. Body `{userName}` — the FULL address. */
  "user.delete": "deleteUser",
  /** UNVERIFIED. Body `{}`. Up to 1000 users. The read-back path for a create. */
  "user.list": "listUser",
  /** UNVERIFIED. Body `{userName, newUserName?, newPassword?, ...}`. */
  "user.modify": "modifyUser",
  /** UNVERIFIED. Body `{userName}` — the FULL address. */
  "user.get": "getUser",

  /* ---- Password reset methods ------------------------------------------- */
  /** UNVERIFIED. Loxep does not call these; listed so the surface is complete. */
  "passwordReset.upsert": "upsertPasswordReset",
  /** UNVERIFIED. */
  "passwordReset.delete": "deletePasswordReset",
  /** UNVERIFIED. */
  "passwordReset.list": "listPasswordReset",

  /* ---- Routing (aliases and catch-alls) --------------------------------- */
  /** UNVERIFIED. Body `{domainName, prefix, matchUser, targetAddresses, catchall?}`. */
  "routing.create": "createRoutingRule",
  /** UNVERIFIED. Body `{routingRuleId}` — an int64 from a list call. */
  "routing.delete": "deleteRoutingRule",
  /** UNVERIFIED. Body `{}`. The read-back path for an alias create. */
  "routing.list": "listRoutingRules",

  /* ---- App passwords ---------------------------------------------------- */
  /**
   * UNVERIFIED, and deliberately NOT wired to an adapter method.
   *
   * `createAppPassword` is the one Purelymail response documented to return a
   * credential. Loxep does not mint app passwords in this milestone, and the
   * operation is listed here — unused — rather than omitted, so that a future
   * implementer finds the name next to this warning instead of transcribing it
   * afresh next to a debugging `console.log`.
   */
  "appPassword.create": "createAppPassword",
  /** UNVERIFIED. */
  "appPassword.delete": "deleteAppPassword",

  /* ---- Billing ---------------------------------------------------------- */
  /**
   * Body `{}`. Returns `{credit}` as a STRING.
   *
   * The cheapest authenticated read in the API and therefore the natural
   * credential health check — which is what the 2026-08-13 auth probe used, so
   * the path itself is LIVE-VERIFIED even though no successful call has been
   * made.
   */
  "account.credit": "checkAccountCredit",
} as const;

export type PurelymailOperation = keyof typeof PURELYMAIL_OPERATIONS;

/** The API version prefix every operation sits under. */
export const PURELYMAIL_API_PREFIX = "/api/v0";

/** `/api/v0/<providerName>` for one Loxep operation label. */
export function purelymailPath(operation: PurelymailOperation): string {
  return `${PURELYMAIL_API_PREFIX}/${PURELYMAIL_OPERATIONS[operation]}`;
}
