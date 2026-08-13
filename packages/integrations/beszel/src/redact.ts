/**
 * Per-response redactors for the Beszel boundary (ADR-0021's
 * `redactWooOrderFact` / `redactEbayOrderFact` precedent, and Purelymail's).
 *
 * The redactor lives HERE, next to the knowledge of which fields are sensitive,
 * and the consuming domain accepts only redacted input.
 *
 * ## The highest-risk value in this package is the LOGIN RESPONSE
 *
 * Purelymail's risk was a request body carrying a minted password. Beszel's is
 * the other direction: `POST …/auth-with-password` answers with
 * `{ token, record }`, where `token` is a live bearer credential for the hub
 * and `record` is the full user row. A debugging instinct that summarized that
 * response would put a working credential into `reconcile_run_steps`.
 *
 * **There is no redactor for the auth response, and that is the design.** No
 * function in this module accepts one, the adapter never summarizes it, and
 * `boundary.test.ts` asserts that a token with a distinctive marker cannot be
 * found in any error detail or summary the adapter produces.
 *
 * ## What a system summary may carry
 *
 * Everything below is an ALLOW-LIST. A Beszel system record carries a `users`
 * array of account ids and, upstream warns, arbitrary additional fields that
 * *"may change in minor releases"* — so nothing generic is ever copied. In
 * particular `users` is reduced to a COUNT: which accounts a system is shared
 * with is Beszel's access-control state, not a fact Loxep has any use for, and
 * the count is enough to explain an empty read ("the readonly user is on none
 * of these").
 */

/** A redacted structure safe for run steps and health projections. */
export type RedactedSummary = Record<string, unknown>;

function scalar(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function count(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

/**
 * One system record -> summary. Identity, status, and freshness; never the
 * sharing list, never the metric payload.
 */
export function redactBeszelSystem(system: unknown): RedactedSummary {
  const record = (system ?? {}) as Record<string, unknown>;
  return {
    id: scalar(record["id"]),
    name: scalar(record["name"]),
    status: scalar(record["status"]),
    updated: scalar(record["updated"]),
    sharedWithCount: count(record["users"]),
  };
}

/**
 * A list page -> summary. The paging counters, and nothing from `items` beyond
 * how many there were: a run step recording "read 12 systems, page 1 of 1" is
 * the useful statement, and inlining twelve records is how a summary becomes a
 * copy of the response.
 */
export function redactBeszelSystemPage(page: unknown): RedactedSummary {
  const record = (page ?? {}) as Record<string, unknown>;
  const number = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    page: number(record["page"]),
    perPage: number(record["perPage"]),
    totalItems: number(record["totalItems"]),
    totalPages: number(record["totalPages"]),
    itemCount: count(record["items"]),
  };
}

/**
 * The health probe -> summary. PocketBase's `/api/health` answers
 * `{"status":200,"message":"API is healthy."}` and carries nothing sensitive,
 * but it is passed through this allow-list anyway so that a future upstream
 * addition to that body cannot arrive in a summary unreviewed.
 */
export function redactBeszelHealth(health: unknown): RedactedSummary {
  const record = (health ?? {}) as Record<string, unknown>;
  return {
    status:
      typeof record["status"] === "number" ? record["status"] : null,
    message: scalar(record["message"]),
  };
}
