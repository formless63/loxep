/**
 * Per-response redactors for the Gatus boundary (ADR-0021's
 * `redactWooOrderFact`/`redactEbayOrderFact` precedent, and Beszel's/
 * Purelymail's).
 *
 * ## There is no login response to guard against here, unlike Beszel
 *
 * Beszel's highest-risk value is its `POST …/auth-with-password` response,
 * which carries a live bearer token. Gatus has no such exchange at all —
 * Basic auth puts the credential directly in an `Authorization` header on
 * every request and Gatus never issues a token back. So the thing this
 * module protects against is different: not a credential IN a response, but
 * an operator's endpoint condition text (which can embed response bodies,
 * URLs, or hostnames from whatever Gatus is monitoring) ending up inlined
 * into a Loxep run-step summary wholesale.
 *
 * ## What a status summary may carry
 *
 * Everything below is an ALLOW-LIST. `errors` is reduced to a COUNT, the same
 * discipline Beszel's `redactBeszelSystem` applies to `users`: Gatus
 * condition-failure text is diagnostic content about a THIRD PARTY endpoint
 * the operator is monitoring, and Loxep has no way to know it never contains
 * something the operator would not want copied into Loxep's own storage —
 * the count is enough to explain "this endpoint is failing its checks."
 */

/** A redacted structure safe for run steps and health projections. */
export type RedactedSummary = Record<string, unknown>;

function scalar(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * One endpoint status -> summary. Identity and the latest result's outcome;
 * never the condition-failure text.
 */
export function redactGatusEndpointStatus(status: unknown): RedactedSummary {
  const record = (status ?? {}) as Record<string, unknown>;
  return {
    key: scalar(record["key"]),
    name: scalar(record["name"]),
    group: scalar(record["group"]),
    success: typeof record["success"] === "boolean" ? record["success"] : null,
    observedAt: scalar(record["observedAt"]),
    errorCount:
      typeof record["errorCount"] === "number" ? record["errorCount"] : 0,
  };
}

/**
 * A bulk `endpoints/statuses` read -> summary. A count, never the list
 * itself — the same discipline `redactBeszelSystemPage` applies to `items`.
 */
export function redactGatusEndpointStatusList(list: unknown): RedactedSummary {
  return { statusCount: Array.isArray(list) ? list.length : 0 };
}

/** The unauthenticated `/health` probe -> summary. */
export function redactGatusHealth(health: unknown): RedactedSummary {
  const record = (health ?? {}) as Record<string, unknown>;
  return {
    status: scalar(record["status"]),
    reason: scalar(record["reason"]),
  };
}

/**
 * The unauthenticated `/api/v1/config` probe -> summary. Nothing here is
 * sensitive, but it is passed through an allow-list anyway so a future
 * upstream addition (Gatus's own `announcements` field, for one) cannot
 * arrive in a summary unreviewed.
 */
export function redactGatusConfigProbe(probe: unknown): RedactedSummary {
  const record = (probe ?? {}) as Record<string, unknown>;
  return {
    oidc: typeof record["oidc"] === "boolean" ? record["oidc"] : null,
    authenticated:
      typeof record["authenticated"] === "boolean"
        ? record["authenticated"]
        : null,
  };
}
