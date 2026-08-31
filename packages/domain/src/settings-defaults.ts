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
import { providerWritePolicyTierSchema } from "./provider-write-policy.ts";
import { ipAliasesSchema } from "./ip-aliases.ts";

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
    intervalSeconds: z
      .number()
      .int()
      .min(5)
      .max(86_400)
      .describe("Baseline cadence, in seconds, for newly created monitor targets"),
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
    watchlistItemsPerPoll: z
      .number()
      .int()
      .min(1)
      .max(200)
      .describe("Watchlist member snapshots per poll — one provider call each"),
    /** Search/seller summaries observed per poll — no extra provider call. */
    searchItemsPerPoll: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .describe("Search/seller summaries observed per poll — no extra provider call"),
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
    capacity: z.number().int().min(1).max(1000).describe("Burst size, in provider calls"),
    /** Sustained provider calls per second. */
    refillPerSecond: z
      .number()
      .positive()
      .max(100)
      .describe("Sustained provider calls per second"),
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
    capacity: z.number().int().min(1).max(1000).describe("Burst size, in provider calls"),
    /** Sustained provider calls per second. */
    refillPerSecond: z
      .number()
      .positive()
      .max(100)
      .describe("Sustained provider calls per second"),
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
    mode: z
      .enum(["redact", "keep"])
      .describe("redact runs the sweep and replaces the payload with its redacted form; keep makes the sweep a no-op — there is no hard-delete mode"),
    /** Age, in days, at which a stored order payload becomes eligible. */
    afterDays: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .describe("Age, in days, at which a stored order payload becomes eligible for the sweep"),
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
    capacity: z.number().int().min(1).max(1000).describe("Burst size, in provider calls"),
    /** Sustained provider calls per second. */
    refillPerSecond: z
      .number()
      .positive()
      .max(100)
      .describe("Sustained provider calls per second"),
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
    reviewed: z
      .boolean()
      .describe(
        "Must be explicitly set to true by the owner before any CAA record is materialized — distinguishes \"nobody has reviewed this yet\" from a deliberate empty policy",
      ),
    /** CA domains for `issue`, e.g. `letsencrypt.org`. */
    issuers: z
      .array(z.string().min(1))
      .max(32)
      .describe("CA domains authorized to issue certificates, e.g. letsencrypt.org"),
    /** CA domains for `issuewild`. */
    wildcardIssuers: z
      .array(z.string().min(1))
      .max(32)
      .describe("CA domains authorized to issue wildcard certificates"),
    /** `mailto:` or `https:` violation-report target, or null. */
    iodef: z
      .string()
      .min(1)
      .nullable()
      .describe("Optional mailto: or https: violation-report target"),
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
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(200 * 1024 * 1024)
      .describe(
        "Per-file cap, in bytes, for an item image/condition-evidence/supporting-document upload",
      ),
    /** Accepted MIME types for an item media upload. */
    allowedMimeTypes: z
      .array(z.string().min(1))
      .min(1)
      .max(32)
      .describe("Accepted MIME types for an item media upload"),
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
 * Documents-domain upload media limits (loxep-cd3.2, M2 —
 * `expense-entry-design.md`, "Upload limits become a registered setting").
 * Mirrors {@link inventoryMediaLimitsSetting} exactly (`{maxBytes,
 * allowedMimeTypes}`, schemaVersion 1, same defaults) — the design's own
 * observation that `@/server/receipt-media.ts` and
 * `@/server/documents-media.ts` both hardcode `10 * 1024 * 1024` and a
 * four-member MIME allowlist, and both note in their own comments that they
 * decline the registered-setting pattern `inventory-media.ts` established in
 * M3. A page whose headline feature is dropping many files at once
 * (`/finance/expenses/new`'s evidence pane) is the moment that stops being
 * acceptable: three upload routes with two different policies was already a
 * coin-flip for the fourth.
 *
 * ONE setting for both routes rather than one per route: `receipt-media.ts`
 * and `documents-media.ts` write the SAME media-object shape (a
 * `media_objects` row with a `metadata.purpose` tag) through the same
 * `MediaService.upload`, and the evidence pane and `/finance/import` are
 * explicitly "the same pipeline entered from two directions" per the
 * design — a split limit between them would contradict that.
 */
export const documentsMediaLimitsSetting = defineSetting({
  key: "documents.media_limits",
  schema: z.strictObject({
    /** Per-file cap, in bytes, for a receipt/invoice/document upload through either upload route. */
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(200 * 1024 * 1024)
      .describe(
        "Per-file cap, in bytes, for a receipt/invoice/document upload through either upload route",
      ),
    /** Accepted MIME types for a receipt/document upload. */
    allowedMimeTypes: z
      .array(z.string().min(1))
      .min(1)
      .max(32)
      .describe("Accepted MIME types for a receipt/document upload"),
  }),
  description:
    "Per-file size cap and MIME allowlist for expense-receipt and document " +
    "uploads (M2) — shared by /api/expenses/receipt and " +
    "/api/documents/upload, which write the same media-object shape",
  schemaVersion: 1,
  defaultValue: {
    maxBytes: 10 * 1024 * 1024,
    allowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "application/pdf"],
  },
});

/**
 * The registered-parser selection for `@loxep/documents` (loxep-cd3.4, M4 —
 * `expense-entry-design.md` section 3, "Deployment shape" / "selection an
 * `application_settings` key (`documents.parser_id`)"). Until this
 * milestone there was only one backend (`manual`, `manual-parser.ts`'s
 * structural placeholder) so there was nothing to select; `ocr_tesseract`
 * (`tesseract-parser.ts`) is the first real alternative, and any future
 * backend (the tier A+ neural sidecar, loxep-cd3.7; the PP-OCR/RapidOCR
 * class) is "a SETTING, not a rewrite" per the design's own words — this
 * key is where that setting lives.
 *
 * Default is `'ocr_tesseract'` (accepted product decision, superseding M4's
 * original opt-in `'manual'` default): the original caution guarded a
 * runtime-weight tradeoff that the M4 addendum dissolved — the WASM engine
 * and its traineddata ship inside the image regardless of this setting, so
 * defaulting to "extraction on" costs a fresh installation nothing it has
 * not already paid for, while preserving searchable receipts out of the box.
 * out of the box. `'manual'` remains one settings-write away for an
 * installation that wants no automatic extraction. The schema
 * intentionally does NOT enumerate valid parser ids (unlike, say,
 * {@link inventoryDefaultSaleModeSetting}'s closed `saleMode` union) —
 * `@loxep/documents`' `ParserRegistry` is the source of truth for which ids
 * exist, and it lives in a package `@loxep/domain` does not (and must not)
 * depend on; validating "is this id actually registered" is the READER's
 * job (the settings surface / the extraction runner), not this schema's.
 */
export const documentsParserIdSetting = defineSetting({
  key: "documents.parser_id",
  schema: z.strictObject({
    /** A `ReceiptParser.id` from `@loxep/documents`' registry — `'manual'` or `'ocr_tesseract'` as of this milestone. */
    parserId: z
      .string()
      .min(1)
      .describe(
        "A registered @loxep/documents ReceiptParser backend id — 'manual' or 'ocr_tesseract' as of this milestone",
      ),
  }),
  description:
    "Which registered @loxep/documents ReceiptParser backend extracts text " +
    "from newly uploaded receipts/invoices — 'ocr_tesseract' by default " +
    "(in-process WASM, M4); set 'manual' to disable automatic extraction",
  schemaVersion: 1,
  defaultValue: { parserId: "ocr_tesseract" },
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
    /** The sale_mode a newly intaken item gets when the operator does not choose one explicitly. */
    saleMode: z
      .enum(["unit", "lot", "set", "parts_donor", "bundle_component"])
      .describe(
        "The sale_mode a newly intaken item gets when the operator does not choose one explicitly",
      ),
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
/**
 * The five OQ9 candidate facts (fleet-observability-design.md's open
 * question 9: *"which facts should be published — worker backlog, sync
 * freshness, drift count, readiness"*, plus the fifth named in the
 * question's own recommendation prose, notification delivery success),
 * accepted in loxep-4ah as the `mode: 'facts'` expansion of
 * the single worst-status rollup milestone 2 shipped. Ordered here exactly
 * as `computeGatusPushFacts` (`@loxep/app`'s `gatus-push.ts`) iterates them,
 * so the derived-key list and the push order can never drift apart.
 */
export const GATUS_PUSH_FACT_SLUGS = [
  "worker-backlog",
  "sync-freshness",
  "notifications",
  "drift",
  "readiness",
] as const;

export type GatusPushFactSlug = (typeof GATUS_PUSH_FACT_SLUGS)[number];

/**
 * Derive one fact's own Gatus `external-endpoints` key from the base
 * `endpointKey` an operator configured — `<baseKey>-<slug>`, e.g.
 * `core_loxep-worker-backlog` from a base key of `core_loxep`. A plain
 * suffix rather than trying to split `<GROUP>_<ENDPOINT>` and re-join: the
 * base key's OWN group/endpoint boundary is ambiguous by design (Loxep
 * never parses it, only echoes it — see this setting's own `endpointKey`
 * doc), so the derivation appends to the whole string instead of guessing
 * where that boundary falls. The operator's own gatus YAML must declare a
 * matching `external-endpoints` entry per fact (see the `gatus-health-push`
 * guide for the exact five-entry block) — Loxep never creates one.
 */
export function deriveGatusPushFactKey(
  baseEndpointKey: string,
  slug: GatusPushFactSlug,
): string {
  return `${baseEndpointKey}-${slug}`;
}

/** Every derived key for a base `endpointKey`, in `GATUS_PUSH_FACT_SLUGS` order — what the read-side quarantine (fleet-health.ts) and discovery exclusion both walk. */
export function gatusPushFactKeys(baseEndpointKey: string): string[] {
  return GATUS_PUSH_FACT_SLUGS.map((slug) => deriveGatusPushFactKey(baseEndpointKey, slug));
}

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
     * sanitizes this; it is copied verbatim from the operator's YAML. In
     * `mode: 'facts'`, this is the DERIVATION SEED for the five fact keys
     * ({@link deriveGatusPushFactKey}) rather than a key Loxep pushes to
     * directly.
     */
    endpointKey: z
      .string()
      .min(3)
      .regex(
        /^[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/u,
        "must look like <GROUP_NAME>_<ENDPOINT_NAME>, matching the operator's gatus external-endpoints declaration",
      )
      .nullable(),
    /**
     * PROVISIONAL default `'single'` (loxep-4ah compatibility decision): an
     * installation that has never touched this field keeps EXACTLY
     * milestone 2's shipped behavior — one push, the overall
     * `integration_health` rollup, to `endpointKey` itself. `'facts'` opts
     * into OQ9's five-fact expansion — one push per fact, to
     * {@link deriveGatusPushFactKey}'s five derived keys, none of them
     * `endpointKey` itself. An operator must both flip this AND declare the
     * five matching `external-endpoints` entries in their own gatus YAML
     * (see the `gatus-health-push` guide) before `'facts'` does anything
     * more than `'single'` did — Gatus's own missing-endpoint 404 already
     * makes a mismatch visible, the same way it does for the single-key
     * heartbeat mirror today.
     */
    mode: z.enum(["single", "facts"]).default("single"),
  }),
  description:
    "Gatus outward health push (Phase 8 milestone 2, expanded loxep-4ah): " +
    "whether it runs, the base URL of the operator's Gatus instance, the " +
    "<GROUP>_<ENDPOINT> key of the external endpoint (or, in 'facts' mode, " +
    "the derivation seed for five fact-specific keys) declared in their " +
    "own gatus YAML, and the push mode itself. The bearer token is a " +
    "secret, stored separately at infrastructure.gatus_push.default",
  schemaVersion: 1,
  defaultValue: { enabled: false, baseUrl: null, endpointKey: null, mode: "single" },
});

/**
 * The per-connection Gatus token bucket (Phase 8 milestone 4, loxep-ovj.4),
 * the fleet-observability sibling of `integration.cloudflare.rate_budget`.
 *
 * `@loxep/integration-gatus` spends this budget on the `GET
 * /api/v1/config` probe, the bulk `endpoints/statuses` read (direct mode),
 * and the per-endpoint `uptimes`/`response-times` reads (the OIDC-degraded
 * fallback — TWO calls per known endpoint key per poll, more than the direct
 * path's one bulk call). `github.com/TwiN/gatus` v5.36.0's `api/api.go`
 * registers no request-limiter middleware at all (only `recover`/`compress`)
 * and documents no rate limit anywhere in its route table, so — matching
 * `cloudflareRateBudgetSetting`'s and the adapter package's own
 * `GATUS_SUGGESTED_CAPACITY`/`GATUS_SUGGESTED_REFILL_PER_SECOND` reasoning —
 * this ceiling is a promise about Loxep's own politeness toward a process
 * the operator is also using interactively, not a guess at a provider limit
 * that does not exist.
 *
 * (These values mirror the adapter's own suggested default in
 * `packages/integrations/gatus/src/rate-budget.ts`; this module cannot
 * import an integration package, so they are duplicated as literals exactly
 * the way `ebayRateBudgetSetting`'s and `cloudflareRateBudgetSetting`'s are.)
 */
export const gatusRateBudgetSetting = defineSetting({
  key: "integration.gatus.rate_budget",
  schema: z.strictObject({
    /** Burst size, in provider calls. */
    capacity: z.number().int().min(1).max(1000).describe("Burst size, in provider calls"),
    /** Sustained provider calls per second. */
    refillPerSecond: z
      .number()
      .positive()
      .max(100)
      .describe("Sustained provider calls per second"),
  }),
  description:
    "Per-connection Gatus rate budget (token-bucket capacity and refill " +
    "per second). Gatus documents no rate limit of its own; this is Loxep's " +
    "own politeness ceiling toward a process the operator also uses directly",
  schemaVersion: 1,
  defaultValue: { capacity: 10, refillPerSecond: 2 },
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

/**
 * Per-integration catalog visibility (loxep-dgg): whether each entry in
 * `apps/web`'s integrations catalog (`integrations-catalog.ts`) shows on
 * `/settings/integrations`, is offered as an "Add account" choice on
 * `/settings/connections`, and appears anywhere else the catalog is
 * enumerated. With 14+ providers, showing every entry by default makes both
 * surfaces hard to scan; this setting lets an operator curate what they see.
 *
 * This is a DISPLAY preference, never a kill switch — the load-bearing rule
 * the design insists on. `integrations-catalog.ts` stays the single source
 * of what a provider IS; this setting is state layered on top of it. Toggling
 * a provider off here does NOT touch its `connections` rows, its worker
 * polling/sync jobs, or its data: an already-connected provider's existing
 * connections keep syncing and its jobs keep running exactly as before. The
 * operator-facing surfaces are expected to say so — a chip/badge on the
 * connection rather than a silent stop — because "disabled" here means
 * "hidden from the picker," not "turned off."
 *
 * Map semantics: a key ABSENT from the map, or explicitly `true`, means
 * shown; only an explicit `false` hides that integration. This id-level
 * "absence means visible" rule is deliberate, not just a convenience for the
 * empty-map default below — it also means a FUTURE catalog addition is
 * visible by default even against an installation that has already
 * customized this setting, without requiring a migration of the stored map.
 *
 * Keys are `IntegrationServiceId` values from `apps/web`'s catalog (`'ebay'`,
 * `'etsy'`, `'woocommerce'`, …), but this module cannot import an `apps/web`
 * type without inverting the dependency direction, so the schema accepts any
 * non-empty string key. A key that does not match a current catalog entry is
 * simply inert (nothing reads it) until a future catalog id reuses it.
 *
 * DEFAULT (PROVISIONAL, loxep-dgg): all-on, i.e. an EMPTY map.
 * The bead deliberately left "sensible minimal set" vs. "all-on" open; this
 * ships all-on because an ABSENT setting must not hide a provider an
 * operator already uses — the safe default for an upgrade-in-place
 * installation is everything visible, exactly like `orderPayloadRetentionSetting`
 * and `gatusPushSetting` above ship toward "never surprise an existing
 * install" rather than a guessed ideal. A curated, minimal-by-default catalog
 * is a fresh-install nicety, not a safety requirement, and it can be revisited
 * once real operators have actually lived with the messy 14+-entry catalog
 * this bead exists to fix. Do not change this default silently; if it is
 * revisited, update this comment, the bead, and the docs together.
 */
export const integrationsEnabledSetting = defineSetting({
  key: "integrations.enabled",
  schema: z.record(z.string().min(1), z.boolean()),
  description:
    "Per-integration catalog visibility: which entries in the integrations " +
    "catalog show on /settings/integrations, connection-add surfaces, and " +
    "any other place the catalog is enumerated. A key absent from this map, " +
    "or mapped true, is shown; only an explicit false hides it. Display " +
    "preference only, never a kill switch — a disabled provider's existing " +
    "connections keep syncing and its jobs keep running unchanged. DEFAULT " +
    "(PROVISIONAL, loxep-dgg): all-on (empty map), because an absent " +
    "setting must not hide a provider an existing operator already uses",
  schemaVersion: 1,
  defaultValue: {},
});

/**
 * Ignored tailnet devices for the fleet LIST page's unmatched-devices
 * candidates panel (loxep-50t §4, item 3 — "so a phone does not reappear
 * every sweep").
 *
 * **PROVISIONAL, and a deliberate deviation from the design's own FIRST
 * choice.** loxep-50t §4 recommends homing "ignore" on
 * `external_resources.metadata.ignoredAt` — a Loxep-owned annotation on the
 * device's own row — and names this settings map only as an "acceptable
 * alternative ... Recommend the first; record the second so the choice is
 * visible." This setting IS that alternative, chosen instead of the
 * recommendation because the first choice does not actually persist:
 * `projectTailscaleDevices` (`packages/app/src/fleet-health.ts`, outside
 * this change's scope) overwrites a tailscale device's `metadata` WHOLESALE
 * on every connection probe/sweep (`{ observedAt, online, lastSeen,
 * addresses, magicDnsName, os, authorized }`, no merge, by its own doc
 * comment — "overwritten wholesale on every refresh"). An `ignoredAt` key
 * stashed in that same object would be silently wiped by the very next
 * sweep, which defeats the one property "ignore" exists to have. If
 * `projectTailscaleDevices` ever starts merging `metadata` instead of
 * replacing it, prefer the design's original recommendation and retire this
 * setting.
 *
 * Keyed by the device's own tailnet node id (`TailscaleDeviceFact.
 * externalDeviceId`, `external_resources.external_id` for a tailscale
 * device) rather than Loxep's internal `external_resources.id` — the id
 * survives the row being re-upserted and, per §1.1, survives a device
 * rename on either side. Value is the ISO instant the operator ignored it,
 * matching `dns_drift_findings`' un-optimistic-resolve posture: ignoring
 * hides a row from the default view, it does not delete the candidate or
 * touch anything at the provider.
 */
export const tailscaleIgnoredDevicesSetting = defineSetting({
  key: "integration.tailscale.ignored_devices",
  schema: z.record(z.string().min(1), z.string().min(1)),
  description:
    "Tailnet devices dismissed from the fleet list's unmatched-devices " +
    "candidates panel, keyed by the device's own tailnet node id and " +
    "mapped to the ISO instant it was ignored. PROVISIONAL fallback " +
    "mechanism — see this setting's own doc comment for why " +
    "external_resources.metadata.ignoredAt (the design's first choice) " +
    "was not used",
  schemaVersion: 1,
  defaultValue: {},
});

/**
 * Who may become a Loxep user, and what an OIDC claim may say about their
 * role (ADR-0024, loxep-x2s).
 *
 * Before this setting existed, Loxep auto-provisioned: any address that could
 * receive a magic-link email and any identity the OIDC issuer would
 * authenticate became a `member` on first sign-in, with no policy in between.
 * `member` is not a spectator role — it reads ordinary product data across the
 * whole installation — so that stance only held while every deployment sat
 * behind a network bypass.
 *
 * This setting governs **account creation only**. It never affects a user who
 * already exists: an existing member always keeps their sign-in path, whatever
 * the policy says and whatever their email domain is. That one rule is what
 * makes the feature lockout-proof, and it is why the domain allowlist below is
 * a provisioning control rather than a send filter.
 *
 * ## Enforcement lives in `@loxep/auth`, and reads this row directly
 *
 * `@loxep/auth` cannot import `@loxep/domain` (its dependencies are
 * `@loxep/config`, `@loxep/db`, `better-auth`, `nodemailer` — and no Zod), so
 * it reads `application_settings` itself through a hand-written TOTAL parser
 * (`provisioning-policy.ts`) that substitutes the defaults below for anything
 * it cannot make sense of. **The shape is therefore stated twice.** This
 * definition is authoritative; that parser is a defensive mirror. Change one
 * and change the other — the same trade `ebayRateBudgetSetting` and
 * `cloudflareRateBudgetSetting` already make when they duplicate an adapter's
 * literals rather than invert a package dependency. Because the parser is
 * total and conservative, drift can only ever make the auth layer *more*
 * restrictive than this value, never less.
 *
 * ## The default, and why a closed default does not brick a new install
 *
 * The shipped default is CLOSED for both methods. A brand-new installation has
 * nobody to open it, so `@loxep/auth` force-opens provisioning while the
 * installation has **no `admin` user at all**, and applies this stored policy
 * from the moment one exists. Every path that produces a first administrator —
 * `LOXEP_BOOTSTRAP_ADMIN_EMAIL`, `loxep admin promote`, or the claim mapping
 * below — closes that window behind itself.
 *
 * DEFAULT (CONFIRMED by `loxep-yk8`, resolving the
 * question `loxep-x2s` was filed to ask): closed-after-bootstrap ships exactly
 * as built. The recommendation held because the failure modes are asymmetric —
 * an install that was open when it should have been closed has already handed
 * out accounts, while an install that was closed when it should have been open
 * costs an administrator one switch. It is nonetheless a behavior change for an
 * upgrade in place (a colleague added next week is declined until an admin
 * opens the method or creates the account), and it runs against this module's
 * own "an absent setting must not surprise an existing install" habit — see
 * {@link integrationsEnabledSetting}. The sub-question was whether `oidc`
 * should default to `'open'` while `magicLink` stays `'closed'`, since with
 * SSO the operator's identity provider is already the gate; the accepted decision keeps
 * that split rejected — one coherent default is easier to reason about than a
 * two-speed one — and instead addresses the discoverability gap with a
 * dismissible onboarding card on `/dashboard/overview` (shown once an admin
 * exists, only while OIDC is bootstrap-configured and `newUsers.oidc` is still
 * `closed`) offering to flip `newUsers.oidc` open. See
 * {@link authOnboardingOidcPromptDismissedSetting}. Do not change this default
 * silently; update this comment, ADR-0024, the bead, and the docs together.
 *
 * ## Claim mapping precedence (also CONFIRMED, same ruling)
 *
 * `applyOn: 'create'` — the default — runs the mapping once, when the OIDC
 * account row is first written, and can only ever GRANT admin; every later
 * sign-in leaves the role exactly as Loxep last set it, so a deliberate
 * promotion or demotion inside Loxep is permanent. This mirrors the existing
 * `overrideUserInfo: false` stance in `@loxep/auth`'s OIDC provider config:
 * the provider seeds a user at creation and never re-syncs after.
 * `applyOn: 'every_sign_in'` declares the IdP authoritative and both grants and
 * revokes admin — guarded so it never demotes the only remaining administrator
 * and never runs in the same session as a first-admin bootstrap grant. The
 * accepted decision ships this default as built, unchanged; it is unrelated to
 * `LOXEP_OIDC_EMAIL_CLAIM` (`@loxep/config`, `configuration-and-secrets.md`),
 * a separate bootstrap override for which claim seeds the email address.
 */
export const authProvisioningSetting = defineSetting({
  key: "auth.provisioning",
  schema: z.strictObject({
    /** Whether each sign-in method may CREATE a new user. Per-method and nowhere else: "signups are closed" is the derived `magicLink === 'closed' && oidc === 'closed'`, not a third stored flag. */
    newUsers: z.strictObject({
      magicLink: z.enum(["open", "closed"]),
      oidc: z.enum(["open", "closed"]),
    }),
    /**
     * Bare domains (`example.com`) whose addresses may create an account
     * through a magic link. EMPTY = no restriction. Matched case-insensitively
     * against the part after the last `@`, EXACT match only — `example.com`
     * does not cover `sub.example.com`, because a silent subdomain wildcard in
     * a security allowlist is generosity nobody asked for.
     */
    magicLinkEmailDomains: z.array(z.string().min(1)).max(64),
    /** Optional IdP-claim → `admin` mapping. Only `admin` is ever mapped: ADR-0017's two roles make this a predicate, not a role table. */
    oidcAdminClaim: z.strictObject({
      /** Dotted path into the id_token claims (`groups`, `realm_access.roles`). `null` disables the mapping. */
      claim: z.string().min(1).nullable(),
      /** Claim values that mean "administrator", matched case-insensitively. */
      adminValues: z.array(z.string().min(1)).max(64),
      /** `create`: grant once at account creation, never re-sync. `every_sign_in`: the IdP is authoritative, both directions. */
      applyOn: z.enum(["create", "every_sign_in"]),
    }),
  }),
  description:
    "Who may become a Loxep user (ADR-0024): whether each sign-in method may " +
    "create a new account, an optional magic-link email-domain allowlist, and " +
    "an optional OIDC claim that maps to the admin role. Governs account " +
    "CREATION only — an existing user always keeps their sign-in path, so " +
    "nothing here can lock anybody out. While the installation has no admin " +
    "user at all, provisioning is force-open so a new deployment can bootstrap " +
    "itself. DEFAULT (CONFIRMED, owner ruling loxep-yk8): closed for both methods",
  schemaVersion: 1,
  defaultValue: {
    newUsers: { magicLink: "closed", oidc: "closed" },
    magicLinkEmailDomains: [],
    oidcAdminClaim: { claim: null, adminValues: [], applyOn: "create" },
  },
});

/**
 * Whether the admin has dismissed the `/dashboard/overview` onboarding card
 * offering to open OIDC auto-provisioning (ADR-0024 §2, `loxep-yk8`).
 *
 * The card exists because the accepted decision that kept `auth.provisioning`'s
 * closed-for-both default (above) rejected splitting `oidc` to `open` by
 * default — SSO-gated installs still start closed, and instead learn the
 * option exists via this one-time surface right after their first
 * administrator is bootstrapped. This setting is what makes the surface
 * ONE-TIME: without it, a card with no persisted "seen it" state would
 * either reappear on every visit to `/dashboard/overview` or have to be
 * silently hidden by some other heuristic.
 *
 * DEFAULT: `false` (not dismissed) — an absent row means the card has never
 * been dismissed, so a fresh installation sees it exactly once, the same
 * "unset means the fresh-install behavior" rule `authProvisioningSetting`
 * itself follows for the bootstrap window.
 *
 * Deliberately its OWN setting rather than a field folded into
 * `auth.provisioning`: dismissal is UI state about a prompt, not part of the
 * provisioning policy itself, and keeping it separate means a future prompt
 * (or a policy reset) never has to reason about the other's shape. Additive:
 * registering it does not change `authProvisioningSetting`'s schema or
 * default.
 */
export const authOnboardingOidcPromptDismissedSetting = defineSetting({
  key: "auth.onboarding_oidc_prompt_dismissed",
  schema: z.boolean(),
  description:
    "Whether the admin has dismissed the /dashboard/overview onboarding " +
    "card offering to open OIDC auto-provisioning (ADR-0024, loxep-yk8). " +
    "DEFAULT: false — an installation that has never dismissed it sees the " +
    "card once, the first time its conditions are met.",
  schemaVersion: 1,
  defaultValue: false,
});

/**
 * The per-connection write-authorization policy (Pangolin chain design
 * milestone 3, `loxep-acj.3`, "The write-risk model", six binding rules —
 * rule 1). Keyed by `connections.id`; a key absent from the map is
 * `'read_only'` ({@link resolveProviderWritePolicy}'s own fallback), so a
 * fresh install cannot write to ANY provider connection without an explicit,
 * audited flip. See `provider-write-policy.ts`'s module doc for the tier
 * vocabulary and why it is a four-value ordinal rather than a binary switch.
 *
 * Applies to every connection, not only Pangolin's: provider credentials can
 * be broadly scoped, and some providers offer no narrower token scope at all.
 * This setting is where Loxep's explicit per-connection write policy lives for
 * every provider wired to check it.
 *
 * Flipping one connection's tier is an ADMIN-ONLY server function
 * (`setConnectionWritePolicy`, `apps/web/src/server/admin-functions.ts`)
 * that writes an `audit_events` row in the SAME transaction, via
 * `SettingsService.set`'s own discipline (`settings.ts`'s `write()` — every
 * setting write is already audited that way; nothing bespoke is added here).
 */
export const providerWritePolicySetting = defineSetting({
  key: "infrastructure.provider_write_policy",
  schema: z.record(z.string().min(1), providerWritePolicyTierSchema),
  description:
    "Per-connection write-authorization tier: 'read_only' (default), " +
    "'additive', 'access_affecting', or 'lockout_class' — keyed by " +
    "connection id. A connection absent from this map is read_only. " +
    "Applies to every write-capable provider connection this policy is " +
    "wired to check (Pangolin, Cloudflare, Purelymail, and Dockhand as of " +
    "the estate-browser program, loxep-47o.10 — Invoice Ninja stays " +
    "deliberately ungated for now) — see infrastructure.provider_write_policy's " +
    "own design section for the tier meanings",
  schemaVersion: 1,
  defaultValue: {},
});

/**
 * Named dynamic-IP aliases (Pangolin chain design milestone 5,
 * `loxep-acj.5`, "Where the address comes from"). Keyed by alias name (see
 * `ip-aliases.ts`'s own doc for why the name lives in the map key rather
 * than duplicated in the value); a key absent from the map simply does not
 * exist as an alias — there is no "default alias".
 *
 * Deliberately NOT a table. Milestone 2's own migration (`0027`) already
 * shipped `proxy_resource_rules.owner`'s `dynamic_ip` value in anticipation
 * of this milestone, and this milestone re-reads the design's own schema
 * section rather than assuming a table follows: "One registered setting,
 * `infrastructure.ip_aliases`, holding a small list" is the design's own
 * words. A handful of named aliases per installation has no per-row
 * ownership, no independent lifecycle, and no query shape a settings map
 * cannot answer — unlike `proxy_resource_rules` itself, which earned its own
 * table for exactly the reasons open question 7 states (multi-row,
 * per-row-owned). No migration ships with this milestone.
 */
export const ipAliasesSetting = defineSetting({
  key: "infrastructure.ip_aliases",
  schema: ipAliasesSchema,
  description:
    "Named dynamic-IP aliases (e.g. 'home'): the current address, where it " +
    "comes from (manual / dns / pangolin_site), and whether a detected " +
    "change may auto-apply the ADD half of an add-then-retire fan-out. A " +
    "proxy_resource_rules row with owner='dynamic_ip' references one by " +
    "storing 'alias:<name>' as its value, resolved at materialization time.",
  schemaVersion: 1,
  defaultValue: {},
});

/** Every definition this module registers, for diagnostics and tests. */
export const registeredApplicationSettings = [
  monitorDefaultsSetting,
  monitorObservationCapsSetting,
  ebayRateBudgetSetting,
  wooRateBudgetSetting,
  orderPayloadRetentionSetting,
  providerWritePolicySetting,
  ipAliasesSetting,
  cloudflareRateBudgetSetting,
  caaPolicySetting,
  documentsMediaLimitsSetting,
  documentsParserIdSetting,
  inventoryMediaLimitsSetting,
  inventoryDefaultSaleModeSetting,
  gatusPushSetting,
  gatusRateBudgetSetting,
  integrationsEnabledSetting,
  tailscaleIgnoredDevicesSetting,
  authProvisioningSetting,
  authOnboardingOidcPromptDismissedSetting,
] as const;
