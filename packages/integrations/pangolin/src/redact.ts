/**
 * Per-response redactors for the Pangolin boundary — `redactCloudflareTokenCreate`'s
 * precedent, applied here: **the redactor ships in milestone 1, before any
 * code that could violate it.**
 *
 * The design document is explicit about the highest-risk case this package
 * will ever see: *"An `Authorization: Bearer <apiKeyId>.<secret>` must never
 * reach a `reconcile_run_steps` summary, and neither must a site-create
 * response's `secret`"* — a `PUT /org/{orgId}/site` create returns `siteId`,
 * `niceId`, `newtId`, and `secret` (the newt tunnel credential), and that
 * `secret` is revealed exactly once. {@link redactPangolinSiteCreate} exists
 * even though **nothing in this milestone calls `createSite`** (ADR-0022 —
 * see the design document's "Newt registration, API-side" section): the
 * rule ships before the code that could violate it, so a future milestone
 * inherits a redactor rather than writing one under deadline pressure.
 *
 * Every redactor below is an ALLOW-LIST, not a filter: it names every field
 * it passes through, so a field Pangolin adds later cannot arrive in a run
 * step or log line unreviewed.
 */

export type RedactedSummary = Record<string, unknown>;

function scalar(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * A site-create response -> a summary that OMITS the newt `secret` entirely.
 * Ships now, before `createSite` exists anywhere in this package (M1 never
 * calls it — ADR-0022), so the boundary test can hold this rule from day
 * one.
 */
export function redactPangolinSiteCreate(response: unknown): RedactedSummary {
  const value = (response ?? {}) as Record<string, unknown>;
  return {
    siteId: numeric(value["siteId"]) ?? scalar(value["siteId"]),
    niceId: scalar(value["niceId"]),
    newtId: scalar(value["newtId"]),
    // Stated positively so a reader of a run step knows the omission is
    // deliberate rather than an empty field.
    secretOmitted: true,
  };
}

/** A site record -> a summary safe for run steps. No `pubKey`/`publicKey`. */
export function redactPangolinSite(site: unknown): RedactedSummary {
  const record = (site ?? {}) as Record<string, unknown>;
  return {
    siteId: numeric(record["siteId"]),
    niceId: scalar(record["niceId"]),
    name: scalar(record["name"]),
    type: scalar(record["type"]),
    online: boolOrNull(record["online"]),
  };
}

/**
 * A resource record -> a summary. `sso`/`emailWhitelistEnabled` are carried
 * as PRESENCE booleans only — never a whitelist's contents — the same
 * asymmetry `ObservedContainerHost` uses for TLS material, per the design's
 * "No secret material crosses this boundary" rule for the future proxy
 * port.
 */
export function redactPangolinResource(resource: unknown): RedactedSummary {
  const record = (resource ?? {}) as Record<string, unknown>;
  return {
    resourceId: numeric(record["resourceId"]),
    niceId: scalar(record["niceId"]),
    name: scalar(record["name"]),
    fullDomain: scalar(record["fullDomain"]),
    mode: scalar(record["mode"]),
    enabled: boolOrNull(record["enabled"]),
    sso: boolOrNull(record["sso"]),
    emailWhitelistEnabled: boolOrNull(record["emailWhitelistEnabled"]),
  };
}

/**
 * A rule record -> a summary. `value` (a CIDR/IP/path/etc.) IS allow-listed
 * — it is the rule, not a secret, and M4 (`loxep-acj.4`) makes its inclusion
 * load-bearing rather than cosmetic: a `reconcile_run_steps` reader auditing
 * an ACCEPT rule this milestone created needs to see WHICH address or path
 * it grants, not just that a rule exists.
 */
export function redactPangolinRule(rule: unknown): RedactedSummary {
  const record = (rule ?? {}) as Record<string, unknown>;
  return {
    ruleId: numeric(record["ruleId"]),
    action: scalar(record["action"]),
    match: scalar(record["match"]),
    value: scalar(record["value"]),
    priority: numeric(record["priority"]),
    enabled: boolOrNull(record["enabled"]),
  };
}

/**
 * A target record -> a summary. No secret material ever lives on a target
 * (that is a resource-level concern), so this is a plain scalar allow-list —
 * added in M4 (`loxep-acj.4`) alongside `addTarget`, following the same
 * "the redactor ships with the code that could need it" discipline as every
 * other one in this file.
 */
export function redactPangolinTarget(target: unknown): RedactedSummary {
  const record = (target ?? {}) as Record<string, unknown>;
  return {
    targetId: numeric(record["targetId"]),
    siteId: numeric(record["siteId"]),
    ip: scalar(record["ip"]),
    port: numeric(record["port"]),
    method: scalar(record["method"]),
    enabled: boolOrNull(record["enabled"]),
    priority: numeric(record["priority"]),
  };
}

/** A page of any Pangolin list read -> a summary by count, never by inlining the records. */
export function redactPangolinPage(items: unknown[]): RedactedSummary {
  return { count: items.length };
}
