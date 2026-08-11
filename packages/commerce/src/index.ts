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
  resolveWooFulfillmentStatus,
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
  createWooOrderSync,
  ensureWooOrderSyncTarget,
  readWooOrderSyncCursor,
  wooOrdersTargetConfigSchema,
  writeWooOrderSyncCursor,
} from "./sync.ts";
export type {
  EnsureWooOrderSyncTargetInput,
  SyncWooOrdersInput,
  SyncWooOrdersResult,
  WooAdapterFactory,
  WooOrderSyncCursor,
  WooOrderSyncService,
  WooOrdersTargetConfig,
} from "./sync.ts";

export {
  SYNC_WOO_ORDERS_TASK_NAME,
  createCommerceTasks,
  enqueueWooOrderSync,
  wooOrderSyncJobKey,
} from "./tasks.ts";
export type { CommerceTasks, RawAddJob, SyncWooOrdersTask } from "./tasks.ts";
