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

/**
 * The per-connection Cloudflare token bucket, the Infrastructure sibling of
 * `integration.ebay.rate_budget` and `integration.woo.rate_budget`.
 *
 * The defaults are the most conservative of the three, and for a reason the
 * other two do not have: Cloudflare's documented limit is **1200 requests per
 * five minutes PER USER** — four per second — and it *"applies cumulatively
 * regardless of whether the request is made via the dashboard, API key, or API
 * token"* (verified 2026-08-13). Exceeding it blocks every call for the next
 * five minutes. A reconciler that spends the operator's whole budget makes
 * their own Cloudflare dashboard stop working, which is a worse failure than a
 * slow sweep. One sustained request per second claims a quarter of the account
 * ceiling and leaves the rest to the human.
 *
 * (These values mirror the adapter's private default in
 * `packages/integrations/cloudflare/src/adapter.ts`; this module cannot import
 * an integration package, so they are duplicated as literals exactly the way
 * `ebayRateBudgetSetting`'s and `wooRateBudgetSetting`'s are.)
 */
export const cloudflareRateBudgetSetting = defineSetting({
  key: "integration.cloudflare.rate_budget",
  schema: z.strictObject({
    /** Burst size, in provider calls. */
    capacity: z.number().int().min(1).max(1000),
    /** Sustained provider calls per second. */
    refillPerSecond: z.number().positive().max(100),
  }),
  description:
    "Per-connection Cloudflare rate budget (token-bucket capacity and refill " +
    "per second). Cloudflare's own limit is 1200 requests per five minutes " +
    "per USER and is shared with the operator's dashboard, so this default " +
    "deliberately claims only a fraction of it",
  schemaVersion: 1,
  defaultValue: { capacity: 8, refillPerSecond: 1 },
});

/**
 * The installation's CAA issuance policy — Phase 7 open question 2,
 * **OWNER-REVIEW-CRITICAL**, resolved PROVISIONAL per its own recommendation
 * with one owner amendment: **ship with NO default issuer list.**
 *
 * A CAA record set closes a real certificate-misissuance path and costs one
 * record, which is why the materializer emits one at all. A **wrong** CAA
 * record silently breaks certificate renewal, and the failure surfaces at
 * expiry rather than at write time — weeks or months after the mistake, at the
 * worst possible moment.
 *
 * So the default below is empty and `reviewed` is `false`, and
 * `materializeDesiredRecords` **refuses to emit any CAA record** until the
 * owner has filled this in and marked it reviewed. The design's own words:
 * *"Never ship a guessed issuer list as a working default."* An installation
 * that never touches this setting simply gets no CAA records, which is the
 * status quo ante and cannot break anything.
 *
 * `issuers` populates `CAA 0 issue "<value>"`; `wildcardIssuers` populates
 * `CAA 0 issuewild "<value>"` and is separate because wildcard issuance is a
 * distinct property that a CA may or may not be authorized for. `iodef` is the
 * optional violation-report address (`CAA 0 iodef "mailto:..."`).
 *
 * The owner must confirm which certificate authorities the estate uses today,
 * **including any used indirectly** by a proxying DNS provider or a reverse
 * proxy — the indirect ones are what a hand-written CAA policy usually
 * forgets.
 */
export const caaPolicySetting = defineSetting({
  key: "infrastructure.caa_policy",
  schema: z.strictObject({
    /**
     * Must be explicitly set to `true` by the owner before ANY CAA record is
     * materialized. Not derived from a non-empty issuer list: an empty
     * reviewed policy ("no CA may issue for these names") is a legitimate,
     * deliberate stance, and it must be distinguishable from "nobody has
     * looked at this yet".
     */
    reviewed: z.boolean(),
    /** CA domains for `issue`, e.g. `letsencrypt.org`. */
    issuers: z.array(z.string().min(1)).max(32),
    /** CA domains for `issuewild`. */
    wildcardIssuers: z.array(z.string().min(1)).max(32),
    /** `mailto:` or `https:` violation-report target, or null. */
    iodef: z.string().min(1).nullable(),
  }),
  description:
    "CAA issuance policy materialized into every managed domain. Ships " +
    "DELIBERATELY EMPTY and unreviewed: a wrong CAA record breaks " +
    "certificate renewal silently, at expiry. No CAA record is materialized " +
    "until an operator sets 'reviewed' with the issuers this estate actually " +
    "uses, including any used indirectly by a proxying DNS provider or " +
    "reverse proxy",
  schemaVersion: 1,
  defaultValue: {
    reviewed: false,
    issuers: [],
    wildcardIssuers: [],
    iodef: null,
  },
});

/**
 * Inventory item media limits (M3, loxep-dgf.3) — the design's own contrast
 * with the avatar path: `MAX_AVATAR_BYTES` is a hardcoded 2 MB constant
 * because an avatar replaces ONE object per user, but an item gallery holds
 * many photos of one physical thing (a twelve-photo camera-body listing is
 * ordinary), and 2 MB is the wrong number for that case. So THIS cap is a
 * registered application setting rather than a constant, the same way
 * `EXPENSE`/receipt limits are not — receipts stayed a constant because M1
 * shipped before this pattern existed; M3 is the first surface where the
 * design explicitly calls for a setting instead.
 *
 * The MIME allowlist sits beside the size cap rather than as a separate
 * setting: the two are always read and reasoned about together (the upload
 * route's one 400/413 decision), and splitting them would let an operator's
 * install carry a size cap with no matching allowlist or vice versa.
 */
export const inventoryMediaLimitsSetting = defineSetting({
  key: "inventory.media_limits",
  schema: z.strictObject({
    /** Per-file cap, in bytes, for an item image/condition-evidence/supporting-document upload. */
    maxBytes: z.number().int().min(1).max(200 * 1024 * 1024),
    /** Accepted MIME types for an item media upload. */
    allowedMimeTypes: z.array(z.string().min(1)).min(1).max(32),
  }),
  description:
    "Per-file size cap and MIME allowlist for inventory item image/" +
    "condition-evidence/supporting-document uploads (M3) — larger than the " +
    "avatar cap on purpose: a gallery holds many photos of one physical thing",
  schemaVersion: 1,
  defaultValue: {
    maxBytes: 10 * 1024 * 1024,
    allowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "application/pdf"],
  },
});

/**
 * The `sale_mode` a newly intaken item gets when the operator does not
 * choose one — mirrors `monitorDefaultsSetting`'s "a starting point new rows
 * inherit" shape. `'unit'` is the dominant case per the design's own
 * ordering of `ITEM_SALE_MODES`, and it is the column's own database
 * `DEFAULT` too; this setting exists so an installation that deals mostly in
 * lots (a liquidation reseller, say) can change the create-time default
 * without every intake form re-selecting it by hand. `'parted_out'` is
 * excluded from the schema's own enum: it is written once by `partOut()`,
 * never chosen at intake, so it cannot be configured as a default either.
 */
export const inventoryDefaultSaleModeSetting = defineSetting({
  key: "inventory.default_sale_mode",
  schema: z.strictObject({
    saleMode: z.enum(["unit", "lot", "set", "parts_donor", "bundle_component"]),
  }),
  description:
    "The sale_mode a newly intaken inventory item gets when the operator " +
    "does not choose one explicitly",
  schemaVersion: 1,
  defaultValue: { saleMode: "unit" },
});

/**
 * Gatus outward health push (Phase 8 milestone 2, loxep-ovj.2). Design:
 * apps/docs/.../architecture/fleet-observability-design.md, "Publish Loxep's
 * own health outward".
 *
 * Gatus's only write path is `POST /api/v1/endpoints/:key/external?success=
 * &error=&duration=` against an endpoint the OPERATOR already declared in
 * their own gatus YAML under `external-endpoints` (optionally with
 * `heartbeat.interval`, so Gatus itself alerts when the push stops arriving —
 * the whole point, since Loxep cannot alert on its own outage). Gatus cannot
 * be configured remotely, so this setting carries only what an operator
 * TYPES to point Loxep at an endpoint that already exists: whether the push
 * runs at all, the base URL of their Gatus instance, and the
 * `<GROUP_NAME>_<ENDPOINT_NAME>` key their YAML declared.
 *
 * The bearer TOKEN that endpoint's YAML requires is deliberately NOT part of
 * this setting — it is secret, and settings are non-secret by definition
 * (this module's own doc comment). It is stored as the application secret
 * `infrastructure.gatus_push.default` (purpose `token`, the same generic
 * bundle `notification_endpoints` already uses for its own bearer tokens),
 * following the split every provider base-URL/credential pair in this
 * codebase already uses: `connections.config`/`ebay_keyset`,
 * `notification_endpoints.config`/`notification_endpoint:<id>`. See
 * `@loxep/app`'s `gatus-push.ts` for the read side of that secret.
 *
 * `enabled` defaults to `false` and the URL/key default to `null`: an
 * installation that has not configured a Gatus base URL, endpoint key, AND
 * token has nothing to push to, and a push job that stays a silent no-op
 * until all three are set is the "nothing configured must not look like
 * everything healthy" rule applied to the outward-push side, matching
 * `caaPolicySetting`'s "ships deliberately unreviewed rather than guessed"
 * discipline.
 */
export const gatusPushSetting = defineSetting({
  key: "infrastructure.gatus_push",
  schema: z.strictObject({
    /** The push task no-ops entirely while false — the shipped default. */
    enabled: z.boolean(),
    /** The operator's Gatus instance, e.g. `https://gatus.example.com`. */
    baseUrl: z.url().nullable(),
    /**
     * `<GROUP_NAME>_<ENDPOINT_NAME>`, exactly as declared under the
     * operator's own gatus `external-endpoints` — Loxep never derives or
     * sanitizes this; it is copied verbatim from the operator's YAML.
     */
    endpointKey: z
      .string()
      .min(3)
      .regex(
        /^[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/u,
        "must look like <GROUP_NAME>_<ENDPOINT_NAME>, matching the operator's gatus external-endpoints declaration",
      )
      .nullable(),
  }),
  description:
    "Gatus outward health push (Phase 8 milestone 2): whether it runs, the " +
    "base URL of the operator's Gatus instance, and the <GROUP>_<ENDPOINT> " +
    "key of the external endpoint declared in their own gatus YAML. The " +
    "bearer token is a secret, stored separately at " +
    "infrastructure.gatus_push.default",
  schemaVersion: 1,
  defaultValue: { enabled: false, baseUrl: null, endpointKey: null },
});

/**
 * Logical application-secret key for the Gatus push bearer token (purpose
 * `token`) — see {@link gatusPushSetting}'s doc for why the token is not
 * part of the setting itself. ONE key for the whole installation: there is
 * exactly one push target, matching the setting's own single-config shape.
 * Both `@loxep/app` (the push job, which reads it) and `apps/web` (the
 * settings form, which writes it) import this constant rather than each
 * hard-coding the string, so the two sides of the split can never drift.
 */
export const GATUS_PUSH_SECRET_KEY = "infrastructure.gatus_push.default";

/** Every definition this module registers, for diagnostics and tests. */
export const registeredApplicationSettings = [
  monitorDefaultsSetting,
  monitorObservationCapsSetting,
  ebayRateBudgetSetting,
  wooRateBudgetSetting,
  orderPayloadRetentionSetting,
  cloudflareRateBudgetSetting,
  caaPolicySetting,
  inventoryMediaLimitsSetting,
  inventoryDefaultSaleModeSetting,
  gatusPushSetting,
] as const;
