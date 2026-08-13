/**
 * Per-response redactors for the Cloudflare boundary (ADR-0021's
 * `redactWooOrderFact` / `redactEbayOrderFact` precedent).
 *
 * The redactor lives HERE, next to the knowledge of which fields are
 * sensitive, and the domain service accepts only redacted input. That is the
 * design's rule for `reconcile_run_steps.request_summary` /
 * `response_summary` and `provider_operations.response_summary`:
 *
 * > What must never appear: token values, mailbox passwords, `Authorization`
 * > header contents, or a full request URL carrying credentials in a query
 * > string. What should appear: the operation, the record identity, and the
 * > values that actually differed.
 *
 * ## The highest-risk line in the whole design
 *
 * Cloudflare's API-token create response carries `result.value` — the token
 * itself, marked `readOnly` and `x-sensitive` in the published schema and
 * *"only shown once"*. It is simultaneously the one response a debugging
 * instinct most wants to log and the one that must never be logged.
 * {@link redactCloudflareTokenCreate} is an ALLOW-LIST over four scalar
 * fields; it cannot pass `value` through even if the response shape changes,
 * because it never reads the input object generically.
 *
 * Token creation itself is milestone 3. The redactor ships in milestone 1 on
 * purpose: the rule must exist before the code that would violate it, and
 * `redact.test.ts` asserts it against a full-shaped fixture today.
 */

/** A redacted structure safe for `reconcile_run_steps` / `provider_operations`. */
export type RedactedSummary = Record<string, unknown>;

function scalar(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Zone response -> summary. A zone object carries no credential material, so
 * this is a projection rather than a filter — but it is still an allow-list,
 * so a field Cloudflare adds later cannot arrive in a run step unreviewed.
 */
export function redactCloudflareZone(zone: unknown): RedactedSummary {
  const record = (zone ?? {}) as Record<string, unknown>;
  const account = (record["account"] ?? {}) as Record<string, unknown>;
  const nameServers = record["name_servers"];
  return {
    zoneId: scalar(record["id"]),
    name: scalar(record["name"]),
    status: scalar(record["status"]),
    accountId: scalar(account["id"]),
    nameserverCount: Array.isArray(nameServers) ? nameServers.length : 0,
  };
}

/**
 * DNS record response -> summary. `content` IS included: a DNS record is
 * public data by construction, and the design says the summary "should
 * contain the record identity and the values that actually differed", which
 * is unusable without content. `comment` and `tags` are dropped — they are
 * operator free text and the one field on a record that could carry something
 * a human pasted by mistake.
 */
export function redactCloudflareDnsRecord(record: unknown): RedactedSummary {
  const value = (record ?? {}) as Record<string, unknown>;
  return {
    recordId: scalar(value["id"]),
    type: scalar(value["type"]),
    name: scalar(value["name"]),
    content: scalar(value["content"]),
    ttl: typeof value["ttl"] === "number" ? value["ttl"] : null,
    proxied: value["proxied"] === true,
    proxiable: value["proxiable"] === true,
  };
}

/**
 * API-token create response -> summary. **Never carries `result.value`.**
 *
 * Written as an explicit four-field projection rather than a delete/omit over
 * the response, because an omit-list silently fails open when the provider
 * renames a field and an allow-list silently fails closed. The value goes to
 * `application_secrets` in the same transaction that records the token row,
 * and nowhere else.
 */
export function redactCloudflareTokenCreate(
  response: unknown,
): RedactedSummary {
  const value = (response ?? {}) as Record<string, unknown>;
  return {
    tokenId: scalar(value["id"]),
    name: scalar(value["name"]),
    status: scalar(value["status"]),
    policyCount: Array.isArray(value["policies"])
      ? value["policies"].length
      : 0,
    // Stated positively so a reader of a run step knows the omission is
    // deliberate rather than an empty field.
    valueOmitted: true,
  };
}

/**
 * Request summary for an outbound call. Takes the operation label and the
 * PATH — never the URL, because a URL can carry a query string and a query
 * string is the one place a credential could travel in a request line.
 */
export function redactCloudflareRequest(input: {
  operation: string;
  method: string;
  path: string;
  body?: unknown;
}): RedactedSummary {
  return {
    operation: input.operation,
    method: input.method,
    path: input.path,
    ...(input.body === undefined
      ? {}
      : { body: redactCloudflareDnsRecord(input.body) }),
  };
}
