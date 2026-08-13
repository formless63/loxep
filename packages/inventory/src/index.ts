/**
 * @loxep/inventory — Phase 4 inventory, acquisition, allocation, shipping, and
 * realized-profitability read models.
 *
 * Two domains live in this package because they ship together in Phase 4 while
 * remaining distinct ownership boundaries per Domain Boundaries: **Inventory
 * and Acquisition** (acquisitions, items, locations, movements, allocations,
 * cost basis) and **Shipping and Fulfillment** (shipments, packages, actual
 * postage). The design records the package question as an open tension; it is
 * resolved PROVISIONALLY here in favour of one package, because splitting a
 * four-table shipping domain out of the package that owns the items it ships
 * would create a circular dependency for no boundary anybody enforces yet.
 * Nothing here treats the two as one thing, and extracting `@loxep/shipping`
 * later is a file move.
 *
 * ## Everything in this package is PROVISIONAL
 *
 * It was written under an explicit owner directive to resolve every open
 * question in the Inventory & Acquisition Schema Design per that document's own
 * recommendation, implement it, and mark it PROVISIONAL for review. The
 * decisions and their locations:
 *
 * ```text
 *  1  no per-SKU costing policy anywhere              (absence)
 *  2  append-only enforced by a DB trigger            migration 0005
 *  3  quantity_on_hand cached, single writer          movements.ts
 *  4  location on the item; partial move = row split  items.ts
 *  5  basis freezes at first depletion_sale           movements.ts, acquisitions.ts
 *  6  shipments authoritative; order_fee_id links     shipments.ts, profitability.ts
 *  7  pro rata by line_total, largest remainder,      profitability.ts
 *     computed in the read model and never stored
 *  8  no FX; mixed currency reported, not converted   profitability.ts
 *  9  consignment excluded by explicit predicate      profitability.ts
 * 10  non-capitalized costs kept and reported         acquisitions.ts
 * ```
 *
 * ## What this package does NOT do
 *
 * No valuation, no revaluation, no lower-of-cost-or-market, no aging cost, no
 * write-down policy, no vendors, no purchase orders, no accounts payable, no
 * receiving against an expected PO, no accounting books, no COGS journal
 * entries, and no counterparties. **Cost basis is not valuation**: this package
 * stores the historical fact of what was paid, and Phase 5 forms the judgement
 * of what stock is worth. `inventory_items.estimated_value_amount` is the
 * operator's target resale price, is the input to `relative_value` allocation,
 * and must never be summed into a balance-sheet figure.
 *
 * Phase 4 realized profitability is revenue minus refunds, seller fees, actual
 * shipping, and cost basis — **not profit**. Every surface that shows the
 * figure must say {@link CONTRIBUTION_LABEL}.
 */

export {
  InventoryError,
  InventoryValidationError,
  InventoryNotFoundError,
  InventoryConflictError,
  InventoryImmutableFactError,
  InventoryAllocationError,
} from "./errors.ts";

export {
  DECIMAL_STRING,
  MONEY_SCALE,
  ZERO,
  absDecimal,
  clampNonNegative,
  compareDecimals,
  distributeByWeights,
  divideDecimals,
  fromUnits,
  isDecimalString,
  isNegative,
  isZeroDecimal,
  multiplyDecimals,
  negateDecimal,
  subtractDecimals,
  sumDecimals,
  toMoneyString,
  toUnits,
} from "./decimal.ts";

export {
  DEFAULT_ALLOCATION_BASIS_SETTING_KEY,
  DEFAULT_ENTITY_SETTING_KEY,
  DEFAULT_LOCATION_SETTING_KEY,
  INVENTORY_SETTINGS_PREFIX,
  REATTRIBUTABLE_SOURCES,
  resolveAcquisitionAttribution,
  resolveItemAttribution,
} from "./attribution.ts";
export type { ResolvedAttribution } from "./attribution.ts";

export {
  acquisitionReferenceCode,
  isUniqueViolation,
  itemCode,
  randomCode,
} from "./codes.ts";

export {
  createMovementsService,
  deriveItemStatus,
  movementKeys,
  recordMovement,
  reconcileQuantityOnHand,
  refreshItemBalance,
} from "./movements.ts";
export type {
  Executor,
  MovementRow,
  MovementsService,
  QuantityDrift,
  ReconcileResult,
  RecordMovementInput,
  RecordMovementResult,
} from "./movements.ts";

export { createLocationsService } from "./locations.ts";
export type {
  CreateLocationInput,
  InventoryLocationRow,
  LocationsService,
} from "./locations.ts";

export { createAcquisitionsService } from "./acquisitions.ts";
export type {
  AcquisitionCostRow,
  AcquisitionRow,
  AcquisitionsService,
  AddCostInput,
  AllocationOutcome,
  CreateAcquisitionInput,
  LandedCostGroup,
} from "./acquisitions.ts";

export {
  DEFAULT_PURCHASE_SYNC_ENTRIES_PER_PAGE,
  DEFAULT_PURCHASE_SYNC_INTERVAL_SECONDS,
  DEFAULT_PURCHASE_SYNC_MAX_PAGES,
  EBAY_PURCHASES_TARGET_TYPE,
  PURCHASE_SYNC_CONFIG_KEY,
  createEbayPurchaseSync,
  createPurchaseIngestionService,
  ensurePurchaseSyncTarget,
  purchaseSyncStateSchema,
  purchaseSyncTargetConfigSchema,
  readPurchaseSyncCursor,
  writePurchaseSyncCursor,
} from "./purchase-sync.ts";
export type {
  EbayPurchaseFactLike,
  EbayPurchasePageIterator,
  EbayPurchaseSyncService,
  EnsurePurchaseSyncTargetInput,
  IngestEbayPurchaseInput,
  IngestEbayPurchaseResult,
  PurchaseIngestionService,
  PurchaseSyncCursor,
  PurchaseSyncState,
  PurchaseSyncTargetConfig,
  SyncEbayPurchasesInput,
  SyncEbayPurchasesResult,
} from "./purchase-sync.ts";

export { createItemsService } from "./items.ts";
export type {
  CreateItemInput,
  InventoryItemRow,
  ItemsService,
  PartOutInput,
  PartOutResult,
  SetConditionInput,
  SetSaleModeInput,
  TransferResult,
  UpdateItemInput,
} from "./items.ts";

export { createSpecificsService } from "./specifics.ts";
export type {
  ItemSpecificRow,
  SetSpecificInput,
  SpecificsService,
} from "./specifics.ts";

export { createInventoryMediaService } from "./media.ts";
export type {
  AttachInventoryMediaInput,
  InventoryMediaLinkRow,
  InventoryMediaService,
} from "./media.ts";

export { createAllocationsService } from "./allocations.ts";
export type {
  AllocationsService,
  DepleteOnFulfillmentInput,
  DepletionResult,
  InventoryAllocationRow,
  ReserveInput,
} from "./allocations.ts";

export { createShipmentsService, netShipmentCost } from "./shipments.ts";
export type {
  RecordShipmentInput,
  ShipmentItemRow,
  ShipmentRow,
  ShipmentsService,
} from "./shipments.ts";

export { createOpportunityLinksService } from "./opportunity-links.ts";
export type {
  LinkOpportunityInput,
  OpportunityLinkRow,
  OpportunityLinksService,
} from "./opportunity-links.ts";

export {
  CONTRIBUTION_LABEL,
  acquisitionRoi,
  costReconciliation,
  inventoryAging,
  inventoryOnHandAtCost,
  itemRealizedContribution,
  openLots,
  orderRealizedContribution,
  oversells,
  sourcingChannelPerformance,
  unmatchedDepletions,
} from "./profitability.ts";
export type {
  AcquisitionRoiRow,
  ItemContributionRow,
  OnHandAtCostRow,
  OrderContributionRow,
  ProfitabilityFilter,
  SourcingChannelRow,
} from "./profitability.ts";
