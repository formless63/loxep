/**
 * Per-response redactors for the Termix boundary (Beszel's `redactBeszelSystem`
 * precedent).
 *
 * ## The highest-risk value is the JWT
 *
 * `GET /users/me/token` answers with a live bearer credential for the
 * instance. **There is no redactor for it, and that is the design** — no
 * function here accepts it, the adapter never summarizes it, and
 * `test/boundary.test.ts` asserts a token with a distinctive marker cannot
 * be found in any error detail or summary the adapter produces.
 *
 * ## What a host or session summary may carry
 *
 * Allow-lists, not filters. `host/db/host` and `/status` carry no schema at
 * all (see `adapter.ts`), so `redactTermixHost` can only ever echo the
 * fields this adapter itself already chose to read defensively. The active
 * sessions schema IS fully specified, and `tabInstanceId`/`shareId` are
 * dropped from the summary as internal identifiers a run step has no use
 * for — the same "count or identity, never the internal id" discipline
 * Beszel's `sharedWithCount` applies.
 */

export type RedactedSummary = Record<string, unknown>;

function scalar(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function redactTermixHost(host: unknown): RedactedSummary {
  const record = (host ?? {}) as Record<string, unknown>;
  return {
    externalHostId: scalar(record["externalHostId"]),
    name: scalar(record["name"]),
    online: typeof record["online"] === "boolean" ? record["online"] : null,
  };
}

export function redactTermixSession(session: unknown): RedactedSummary {
  const record = (session ?? {}) as Record<string, unknown>;
  return {
    sessionId: scalar(record["sessionId"]),
    hostId: scalar(record["hostId"]),
    hostName: scalar(record["hostName"]),
    isConnected:
      typeof record["isConnected"] === "boolean" ? record["isConnected"] : null,
    isOwnSession:
      typeof record["isOwnSession"] === "boolean"
        ? record["isOwnSession"]
        : null,
    sharedByUsername: scalar(record["sharedByUsername"]),
  };
}

export function redactTermixSessionPage(sessions: unknown[]): RedactedSummary {
  return { sessionCount: sessions.length };
}
