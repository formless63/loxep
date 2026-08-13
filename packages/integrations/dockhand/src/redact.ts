/**
 * Per-request and per-response redactors for the Dockhand boundary (ADR-0021's
 * `redactWooOrderFact` / `redactEbayOrderFact` precedent, and Purelymail's).
 *
 * The redactor lives HERE, next to the knowledge of which fields are sensitive,
 * and the consuming domain accepts only redacted input. That is the design's
 * rule for `reconcile_run_steps.request_summary` / `response_summary`:
 *
 * > What must never appear: token values, mailbox passwords, `Authorization`
 * > header contents, or a full request URL carrying credentials in a query
 * > string. What should appear: the operation, the record identity, and the
 * > values that actually differed.
 *
 * ## The highest-risk value in THIS package is a REQUEST
 *
 * Beszel's risk was a response carrying an auth token. Dockhand's is the host
 * registration payload, and it is worse in kind: `POST /api/environments`
 * accepts `tlsCa`, `tlsCert`, and `tlsKey` — upstream describes each as a
 * *"multi-line PEM string with BEGIN/END markers"* — plus `hawserToken`. A
 * reconcile run step recording that call is exactly where a debugging instinct
 * would dump the body, and the body contains **a private key**.
 *
 * {@link redactDockhandHostPayload} is therefore an ALLOW-LIST that never reads
 * a payload generically. It cannot pass `tlsKey` through even if the intent
 * shape changes, because there is no code path that copies an unknown field.
 * Each secret field is reduced to a boolean "configured" bit, which is all the
 * reconciler ever compares anyway — see `DockhandHostFact` in `adapter.ts`,
 * which applies the same asymmetry on the read side.
 *
 * `boundary.test.ts` asserts this against a full-shaped fixture including a PEM
 * body with a distinctive marker, per the infrastructure design's
 * pre-implementation item: *"confirm no adapter can place a token value … or an
 * `Authorization` header into `reconcile_run_steps` or a job payload — a test
 * per adapter, not a code review."*
 */

/** A redacted structure safe for `reconcile_run_steps` / job payloads. */
export type RedactedSummary = Record<string, unknown>;

function scalar(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function configured(value: unknown): boolean {
  return typeof value === "string" ? value.length > 0 : value != null;
}

function toCount(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

/**
 * A host-registration intent -> summary. **The only redactor that sees secret
 * material, and it converts every piece of it to a bit.**
 */
export function redactDockhandHostPayload(payload: unknown): RedactedSummary {
  const record = (payload ?? {}) as Record<string, unknown>;
  return {
    name: scalar(record["name"]),
    connectionType: scalar(record["connectionType"]),
    host: scalar(record["host"]),
    port:
      typeof record["port"] === "number" ? record["port"] : null,
    protocol: scalar(record["protocol"]),
    socketPath: scalar(record["socketPath"]),
    // PEM material and the agent token: presence only, never the value.
    tlsCaConfigured: configured(record["tlsCa"]),
    tlsCertConfigured: configured(record["tlsCert"]),
    tlsKeyConfigured: configured(record["tlsKey"]),
    hawserTokenConfigured: configured(record["hawserToken"]),
    tlsSkipVerify: flag(record["tlsSkipVerify"]),
    labelCount: toCount(record["labels"]),
    publicIp: scalar(record["publicIp"]),
  };
}

/**
 * A managed-host record -> summary. Identity and connection shape; never TLS
 * material, never the Hawser token.
 */
export function redactDockhandHost(host: unknown): RedactedSummary {
  const record = (host ?? {}) as Record<string, unknown>;
  return {
    id: record["id"] == null ? null : String(record["id"]),
    name: scalar(record["name"]),
    connectionType: scalar(record["connectionType"]),
    host: scalar(record["host"]),
    tlsConfigured:
      configured(record["tlsCa"]) ||
      configured(record["tlsCert"]) ||
      configured(record["tlsKey"]),
    hawserConfigured: configured(record["hawserToken"]),
    hawserLastSeen: scalar(record["hawserLastSeen"]),
    updatedAt: scalar(record["updatedAt"]),
  };
}

/**
 * A container -> summary. Environment variables and labels are **absent by
 * construction**: a container's `env` array is where an operator's own database
 * passwords live, and a fleet summary has no use for them.
 */
export function redactDockhandContainer(container: unknown): RedactedSummary {
  const record = (container ?? {}) as Record<string, unknown>;
  return {
    id: scalar(record["id"]),
    name: scalar(record["name"]),
    image: scalar(record["image"]),
    state: scalar(record["state"]),
    status: scalar(record["status"]),
  };
}

/** A stack -> summary. Counts, not the container list. */
export function redactDockhandStack(stack: unknown): RedactedSummary {
  const record = (stack ?? {}) as Record<string, unknown>;
  return {
    name: scalar(record["name"]),
    status: scalar(record["status"]),
    sourceType: scalar(record["sourceType"]),
    containerCount:
      toCount(record["containers"]) ?? toCount(record["containerDetails"]),
  };
}
