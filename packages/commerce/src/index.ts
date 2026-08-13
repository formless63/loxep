/**
 * @loxep/commerce — Phase 3 commerce ingestion, catalog, and profitability
 * read models.
 *
 * Two domains live in this package because they ship together and share the
 * `/commerce` workspace, while remaining distinct ownership boundaries per
 * Domain Boundaries: **Commerce** (orders and their attachments) and **Catalog
 * and Listings** (catalog items, channel listings). Workspace UX is not domain
 * ownership; nothing here treats them as one thing.
 *
 * ## Everything in this package is PROVISIONAL
 *
 * It was written under an explicit owner directive to resolve every open
 * question in the Commerce Schema Design per that document's own
 * recommendation, implement it, and mark it PROVISIONAL for review. The
 * decisions and their locations:
 *
 * ```text
 * 1  fees at reported granularity, never allocated    orders.ts, schema
 *    + fee_direction, forced by the Woo findings      woo.ts, schema
 * 2  duplicates detected, not constrained             orders.ts markDuplicate
 * 3  fulfillments + per-line quantities, +'unknown'   woo.ts, schema
 * 4  no FX; every read model groups by currency       reports.ts
 * 5  no order_status_events table                     schema (absence)
 * 6  sync cursor on monitor_targets 'woo_orders'      sync.ts
 * 7  catalog SKU unique installation-wide             catalog.ts, schema
 * 8  buyer columns are id + display handle only       woo.ts, facts.ts
 * ```
 *
 * ## Providers
 *
 * ```text
 * woo.ts        WooOrderFact  → CommerceOrderFact   (live-verified)
 * ebay.ts       EbayOrderFact → CommerceOrderFact   (fixture-verified;
 *                 the Sell Fulfillment status vocabularies are design-derived
 *                 until the live sandbox leg runs)
 * ```
 *
 * Adding the second provider touched `orders.ts` only to add a four-line
 * entry point — idempotency, attachment rewriting, attribution, provenance,
 * and duplicate detection are written and tested exactly once, which is the
 * claim `facts.ts` makes and this is the evidence for it.
 *
 * ## What this package does NOT do
 *
 * No inventory, no cost basis, no COGS, no payouts, no accounting books, no
 * counterparties, no writes back to a provider. Phase 3 profitability is
 * revenue minus provider-reported fees, refunds, and discounts — **not
 * margin** — and every surface that shows a figure must say so
 * (`CONTRIBUTION_LABEL`).
 */

export {
  CommerceError,
  CommerceValidationError,
  CommerceNotFoundError,
  CommerceConflictError,
} from "./errors.ts";

export {
  DECIMAL_STRING,
  MONEY_SCALE,
  absDecimal,
  compareDecimals,
  divideDecimals,
  isDecimalString,
  isZeroDecimal,
  subtractDecimals,
  sumDecimals,
  toMoneyString,
} from "./decimal.ts";

export type {
  CommerceOrderFact,
  CommerceOrderFeeFact,
  CommerceOrderFulfillmentFact,
  CommerceOrderFulfillmentLineFact,
  CommerceOrderLineFact,
  CommerceOrderRefundFact,
  CommerceOrderRefundLineFact,
} from "./facts.ts";

export {
  WOO_COMPLETED_FULFILLMENT_ID,
  WOO_DEFAULT_CHANNEL,
  WOO_ORDER_OBJECT_TYPE,
  WOO_PROVIDER,
  wooOrderFactToCommerceFact,
} from "./woo.ts";
export type { WooTranslationOptions } from "./woo.ts";

export {
  commerceOrderFactSchema,
  createOrderIngestionService,
  resolveAttribution,
} from "./orders.ts";
export type {
  DuplicateOrderCandidate,
  IngestEbayOrderInput,
  IngestOrderFactInput,
  IngestOrderResult,
  IngestWooOrderInput,
  OrderIngestionService,
  ReattributeOrdersInput,
  SetOrderAttributionInput,
} from "./orders.ts";

export { createCatalogService } from "./catalog.ts";
export type {
  CatalogItemRow,
  CatalogService,
  ChannelLinkSuggestion,
  ChannelListingCandidate,
  ChannelListingRow,
  CreateCatalogItemInput,
  UpdateCatalogItemInput,
  UpsertChannelListingInput,
} from "./catalog.ts";

export { CONTRIBUTION_LABEL, entityAttributionReport, orderSummary } from "./reports.ts";
export type {
  EntityAttributionGroup,
  OrderSummaryFilter,
  OrderSummaryGroup,
} from "./reports.ts";

export {
  COMMERCE_SYNC_CONFIG_KEY,
  CURSOR_OVERLAP_SECONDS,
  DEFAULT_SYNC_INTERVAL_SECONDS,
  DEFAULT_SYNC_MAX_PAGES,
  DEFAULT_SYNC_PER_PAGE,
  WOO_ORDERS_TARGET_TYPE,
  commerceSyncTargetConfigSchema,
  createWooOrderSync,
  ensureOrderSyncTarget,
  ensureWooOrderSyncTarget,
  readOrderSyncCursor,
  readWooOrderSyncCursor,
  wooOrdersTargetConfigSchema,
  writeOrderSyncCursor,
  writeWooOrderSyncCursor,
} from "./sync.ts";
export type {
  CommerceOrderSyncCursor,
  EnsureWooOrderSyncTargetInput,
  SyncWooOrdersInput,
  SyncWooOrdersResult,
  WooAdapterFactory,
  WooOrderSyncCursor,
  WooOrderSyncService,
  WooOrdersTargetConfig,
} from "./sync.ts";

export {
  EBAY_DEFAULT_CHANNEL,
  EBAY_ORDER_OBJECT_TYPE,
  EBAY_PROVIDER,
  ebayOrderFactToCommerceFact,
} from "./ebay.ts";
export type {
  EbayFulfillmentFactLike,
  EbayOrderFactLike,
  EbayOrderFeeFactLike,
  EbayOrderLineFactLike,
  EbayOrderTotalsLike,
  EbayRefundFactLike,
  EbayTranslationOptions,
} from "./ebay.ts";

export {
  DEFAULT_EBAY_SYNC_PER_PAGE,
  EBAY_ORDERS_TARGET_TYPE,
  createEbayOrderSync,
  ebayOrdersTargetConfigSchema,
  ensureEbayOrderSyncTarget,
  readEbayOrderSyncCursor,
} from "./ebay-sync.ts";
export type {
  EbayOrderPageIterator,
  EbayOrderPageLike,
  EbayOrderSyncService,
  EbayOrdersTargetConfig,
  SyncEbayOrdersInput,
  SyncEbayOrdersResult,
} from "./ebay-sync.ts";

export {
  DEFAULT_REDACTION_BATCH_SIZE,
  DEFAULT_REDACTION_MAX_BATCHES,
  ORDER_PROVIDER_OBJECT_TYPES,
  runOrderPayloadRedactionSweep,
} from "./retention.ts";
export type {
  OrderPayloadRedactor,
  OrderPayloadRedactors,
  OrderPayloadRedactionSweepResult,
  RunOrderPayloadRedactionSweepOptions,
} from "./retention.ts";

export {
  REDACT_ORDER_PAYLOADS_CRON_MATCH,
  REDACT_ORDER_PAYLOADS_TASK_NAME,
  SYNC_EBAY_ORDERS_TASK_NAME,
  SYNC_WOO_ORDERS_TASK_NAME,
  createCommerceTasks,
  ebayOrderSyncJobKey,
  enqueueEbayOrderSync,
  enqueueWooOrderSync,
  wooOrderSyncJobKey,
} from "./tasks.ts";
export type {
  CommerceCronItem,
  CommerceTasks,
  RawAddJob,
  RedactOrderPayloadsTask,
  SyncEbayOrdersTask,
  SyncWooOrdersTask,
} from "./tasks.ts";
