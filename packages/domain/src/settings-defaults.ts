/**
 * The registered application settings Loxep ships with (loxep-62y.2.3).
 *
 * ## Why the definitions live in `@loxep/domain`
 *
 * {@link defineSetting} registers into a MODULE-LEVEL registry, and
 * `SettingsService.list()` — the `/settings` application surface — can only
 * show what has been registered in the process that renders it. The worker
 * composition root (`@loxep/app`) is deliberately never imported by
 * `apps/web` (ADR-0013/ADR-0018: the request process must not pull in
 * graphile-worker or the provider integrations), so a definition declared
 * there would be invisible to the settings UI.
 *
 * Declaring them here — beside the registry itself, imported by every process
 * through `@loxep/domain`'s entrypoint — gives the operator surface and the
 * worker ONE definition, one key, one schema, one default. Nothing in this
 * module imports `@loxep/market` or an integration package: a setting
 * definition is a typed key with a default, not domain logic, so this does
 * not make `@loxep/domain` depend on the polling stack.
 *
 * ## What is here and what is deliberately not
 *
 * These are INSTALLATION-WIDE defaults. Per-target overrides already exist in
 * the schema (`monitor_targets.interval_seconds`, `config.maxItems`,
 * `config.adaptive`) and always win over a setting; a setting only moves the
 * value a target inherits or the cost ceiling a poll respects.
 *
 * Secret material never appears here — that is the secrets/credentials
 * services' job (ADR-0019). The eBay *keyset* is a secret; the eBay *rate
 * budget* is a non-secret operational limit, which is why only the latter is
 * a setting.
 */
import { z } from "zod";
import { defineSetting } from "./settings.ts";

/**
 * Installation-wide monitor cadence defaults.
 *
 * `intervalSeconds` is the ~60 s baseline a NEW monitor target inherits when
 * the operator does not choose a cadence. It is a starting point, not a
 * guarantee: the adaptive policy scales it per tier and the per-connection
 * rate-budget floor clamps it from below, so a 60 s default on a connection
 * whose budget implies a 90 s floor polls every 90 s.
 */
export const monitorDefaultsSetting = defineSetting({
  key: "monitors.defaults",
  schema: z.strictObject({
    /** Baseline cadence, in seconds, for newly created monitor targets. */
    intervalSeconds: z.number().int().min(5).max(86_400),
  }),
  description:
    "Default polling cadence new monitor targets inherit, in seconds " +
    "(the adaptive policy and the per-connection rate-budget floor still apply)",
  schemaVersion: 1,
  defaultValue: { intervalSeconds: 60 },
});

/**
 * How many items ONE poll may observe.
 *
 * A membership/discovery poll routinely sees more items than it should write
 * an observation for: a watchlist member snapshot costs one provider call
 * (one rate-budget token), and a search page can carry 200 summaries whose
 * observations all land in the hypertable. Both paths therefore observe
 * STALEST-FIRST up to a cap, so a monitor larger than its cap is covered
 * round-robin across polls instead of leaving its tail permanently
 * unobserved.
 *
 * Raising `watchlistItemsPerPoll` costs provider calls; raising
 * `searchItemsPerPoll` costs observation rows only (the summaries were
 * already fetched by the search itself).
 */
export const monitorObservationCapsSetting = defineSetting({
  key: "monitors.observation_caps",
  schema: z.strictObject({
    /** Watchlist member snapshots per poll — one provider call each. */
    watchlistItemsPerPoll: z.number().int().min(1).max(200),
    /** Search/seller summaries observed per poll — no extra provider call. */
    searchItemsPerPoll: z.number().int().min(1).max(1000),
  }),
  description:
    "Per-poll observation caps: watchlist member snapshots (one provider " +
    "call each) and search/seller summaries observed per discovery poll",
  schemaVersion: 1,
  defaultValue: { watchlistItemsPerPoll: 20, searchItemsPerPoll: 50 },
});

/**
 * The per-connection eBay token bucket (`capacity`, `refillPerSecond`).
 *
 * This is the operational half of the pair whose other half is the secret
 * keyset. Every eBay connection gets one bucket with these parameters, and
 * the ADAPTIVE INTERVAL FLOOR is derived from `refillPerSecond` — tightening
 * the budget automatically slows every monitor on the connection, because a
 * rate budget is a safety constraint rather than a preference. See
 * `@loxep/app`'s `rateBudgetIntervalFloorSeconds` for the formula.
 */
export const ebayRateBudgetSetting = defineSetting({
  key: "integration.ebay.rate_budget",
  schema: z.strictObject({
    /** Burst size, in provider calls. */
    capacity: z.number().int().min(1).max(1000),
    /** Sustained provider calls per second. */
    refillPerSecond: z.number().positive().max(100),
  }),
  description:
    "Per-connection eBay rate budget (token-bucket capacity and refill per " +
    "second); the refill rate also derives the adaptive interval floor",
  schemaVersion: 1,
  defaultValue: { capacity: 10, refillPerSecond: 1.5 },
});

/**
 * The per-connection WooCommerce token bucket (`capacity`,
 * `refillPerSecond`), the Woo sibling of `integration.ebay.rate_budget`.
 *
 * As with eBay, `refillPerSecond` also derives the per-connection adaptive
 * INTERVAL FLOOR (`wooRateBudgetIntervalFloorSeconds`), so tightening the
 * budget slows every order sync on the connection — a rate budget is a safety
 * constraint, not a preference. The defaults are deliberately gentler than
 * eBay's: the other end is a self-hosted WordPress install, not a marketplace
 * API built to be polled. (These defaults mirror `@loxep/app`'s
 * `WOO_RATE_BUDGET_CAPACITY` / `WOO_RATE_BUDGET_REFILL_PER_SECOND`; this
 * module cannot import those without depending on `@loxep/app`, so the
 * values are duplicated as literals the same way `ebayRateBudgetSetting`'s
 * are above.)
 */
export const wooRateBudgetSetting = defineSetting({
  key: "integration.woo.rate_budget",
  schema: z.strictObject({
    /** Burst size, in provider calls. */
    capacity: z.number().int().min(1).max(1000),
    /** Sustained provider calls per second. */
    refillPerSecond: z.number().positive().max(100),
  }),
  description:
    "Per-connection WooCommerce rate budget (token-bucket capacity and " +
    "refill per second); the refill rate also derives the adaptive interval " +
    "floor for that store's order sync",
  schemaVersion: 1,
  defaultValue: {
    capacity: 5,
    refillPerSecond: 1,
  },
});

/**
 * How long a retained ORDER payload keeps its buyer personal data (ADR-0021).
 *
 * Order payloads are the one provider-object class that carries buyer PII —
 * billing/shipping addresses, email, phone, customer IP, user agent, and on
 * eBay a taxpayer id and gift-recipient details. Foundational decision 7's
 * "retain everything, delete nothing automatically" stance was written for
 * marketplace observation payloads, which carry none of that, so ADR-0021
 * refines it for order-class objects only.
 *
 * `mode: 'redact'` (the default) replaces the stored payload with the
 * provider's redacted form once it is older than `afterDays`; the
 * `provider_objects` row itself — identity, provider, object type,
 * `payload_hash`, timestamps — and every `order_source_links` row pointing at
 * it survive untouched. There is deliberately NO hard-delete mode:
 * data-minimization here means removing personal data from a payload, never
 * destroying provenance. `mode: 'keep'` restores the pre-ADR-0021 behavior
 * for installations that want it, and makes the sweep a no-op.
 *
 * The DEFAULT is `keep` — owner-reviewed 2026-08-12: retained payloads feed
 * future CRM and cross-platform customer matching, and a lookup that hits a
 * redaction is worse for this product than the residual PII exposure of a
 * self-hosted install. `redact` remains fully supported for installations
 * that prefer data minimization; 180 days stays its suggested window because
 * typical marketplace dispute/return/chargeback windows run to about that.
 * The window applies per STORED PAYLOAD ROW, not per order, so a re-synced
 * order that produced a newer payload keeps its newest facts longest.
 */
export const orderPayloadRetentionSetting = defineSetting({
  key: "commerce.order_payload_retention",
  schema: z.strictObject({
    /** `redact` runs the sweep; `keep` makes it a no-op. Never deletes. */
    mode: z.enum(["redact", "keep"]),
    /** Age, in days, at which a stored order payload becomes eligible. */
    afterDays: z.number().int().min(1).max(3650),
  }),
  description:
    "Order-payload retention (ADR-0021): after how many days a retained " +
    "order provider-object payload is replaced by its redacted form, or " +
    "'keep' to retain payloads indefinitely. Provenance rows are never deleted",
  schemaVersion: 1,
  defaultValue: { mode: "keep", afterDays: 180 },
});

/** Every definition this module registers, for diagnostics and tests. */
export const registeredApplicationSettings = [
  monitorDefaultsSetting,
  monitorObservationCapsSetting,
  ebayRateBudgetSetting,
  wooRateBudgetSetting,
  orderPayloadRetentionSetting,
] as const;
