/**
 * @loxep/market — monitor scheduling, marketplace observations, and derived
 * market events (Phase 0 foundation: schema-in-use, dispatcher pattern, NO
 * provider API calls; ADR-0003, ADR-0009).
 */

export {
  MarketError,
  MarketNotFoundError,
  MarketValidationError,
} from "./errors.ts";

export {
  COMMERCE_SYNC_CONFIG_KEY,
  MAX_BACKOFF_SECONDS,
  MONITOR_TARGET_TYPES,
  backoffSeconds,
  claimDueTargets,
  collectAdaptiveSignals,
  commerceSyncStateSchema,
  createMonitorService,
  ebaySearchFiltersSchema,
  monitorTargetConfigSchemas,
  recordPollFailure,
  recordPollSuccess,
} from "./monitors.ts";
export type {
  AdaptiveSignals,
  ClaimedTarget,
  CommerceSyncState,
  CreateMonitorTargetInput,
  EbaySearchFiltersConfig,
  MonitorService,
  MonitorTargetRow,
  MonitorTargetType,
  PollSuccessResult,
  RecordPollSuccessOptions,
  UpdateMonitorTargetInput,
} from "./monitors.ts";

export {
  ACTIVITY_HOT_COUNT,
  ACTIVITY_WARM_COUNT,
  ADAPTIVE_CONFIG_KEY,
  ADAPTIVE_TIERS,
  ADAPTIVE_TIER_FACTORS,
  AUCTION_APPROACHING_END_SECONDS,
  AUCTION_ENDGAME_SECONDS,
  AUCTION_NEAR_END_SECONDS,
  DEFAULT_ADAPTIVE_MAX_SECONDS,
  DEFAULT_ADAPTIVE_MIN_SECONDS,
  DEFAULT_ADAPTIVE_SIGNAL_WINDOW_SECONDS,
  IDLE_STREAK_LONG,
  IDLE_STREAK_RELAXED,
  IDLE_STREAK_VERY_LONG,
  MAX_STEP_FACTOR,
  adaptiveConfigSchema,
  adaptiveStatePatch,
  computeAdaptiveInterval,
  evaluateAdaptiveInterval,
  nextUnchangedStreak,
  readAdaptiveState,
  selectAdaptiveTier,
} from "./adaptive.ts";
export type {
  AdaptiveBounds,
  AdaptiveConfig,
  AdaptiveDecision,
  AdaptiveIntervalInput,
  AdaptiveState,
  AdaptiveTier,
} from "./adaptive.ts";

export {
  WATCHED_ITEM_SORT_KEYS,
  deactivateAbsentMonitorItems,
  latestObservations,
  linkItemToMonitor,
  listWatchedItemIds,
  marketplaceItemInputSchema,
  observationBatchSchema,
  observationItemSchema,
  recordObservationBatch,
  upsertMarketplaceItem,
} from "./observations.ts";
export type {
  MarketplaceItemInput,
  MarketplaceItemRecord,
  ObservationBatchInput,
  ObservationItemInput,
  ObservationRow,
  WatchedItemIdRow,
  WatchedItemIdsOptions,
  WatchedItemSortKey,
} from "./observations.ts";

export {
  AVAILABILITY_IN_STOCK,
  AVAILABILITY_OUT_OF_STOCK,
  ITEM_EVENTS_SORT_KEYS,
  LISTING_STATE_ENDED,
  MARKET_EVENT_TYPES,
  NEW_LISTING_EVENT_TYPE,
  compareDecimalStrings,
  compareObservations,
  deduplicationKeyFor,
  deriveMarketEvents,
  listItemEventsPage,
} from "./events.ts";
export type {
  DetectedMarketEvent,
  ItemEventsPageOptions,
  ItemEventsPageResult,
  ItemEventsSortKey,
  MarketEventRow,
  MarketEventType,
  ObservationSnapshot,
} from "./events.ts";

export {
  deriveNewListingEvents,
  diffDiscoveredItems,
  knownExternalItemIds,
} from "./discovery.ts";
export type {
  DeriveNewListingEventsInput,
  DeriveNewListingEventsResult,
  DiffDiscoveredItemsInput,
  DiffDiscoveredItemsResult,
  DiscoveredSummary,
  NewlyLinkedItem,
} from "./discovery.ts";

export {
  OPPORTUNITY_EVENTS_SORT_KEYS,
  OPPORTUNITY_PAYLOAD_KEY,
  SCORE_SCALE,
  createOpportunityRulesService,
  evaluateRule,
  evaluateRulesForEvent,
  listEnabledRulesForEvaluation,
  listOpportunityEventsPage,
  opportunityConditionsSchema,
  opportunityRuleSnapshot,
  scoreWeightSchema,
} from "./opportunities.ts";
export type {
  CreateOpportunityRuleInput,
  EvaluableMarketEvent,
  EvaluateRulesForEventOptions,
  EvaluateRulesForEventResult,
  OpportunityConditions,
  OpportunityConditionsInput,
  OpportunityContext,
  OpportunityEvaluation,
  OpportunityEventContext,
  OpportunityEventRow,
  OpportunityEventsPageOptions,
  OpportunityEventsPageResult,
  OpportunityEventsSortKey,
  OpportunityMatch,
  OpportunityRuleDefinition,
  OpportunityRuleMutation,
  OpportunityRuleRow,
  OpportunityRuleSnapshot,
  OpportunityRulesService,
  UpdateOpportunityRuleInput,
} from "./opportunities.ts";

export {
  DEFAULT_HISTORY_BUCKET_SECONDS,
  DEFAULT_PRICE_MOVERS_LIMIT,
  availabilityHistory,
  biggestPriceMovers,
  computePriceChangePercent,
  deriveRestockSelloutIntervals,
  itemActivitySummary,
  priceHistory,
  restockSellout,
} from "./metrics.ts";
export type {
  AvailabilityHistoryBucket,
  AvailabilityHistoryOptions,
  BiggestPriceMoversOptions,
  ItemActivitySummary,
  ItemActivitySummaryOptions,
  PriceHistoryBucket,
  PriceHistoryOptions,
  PriceMoverRow,
  RestockSelloutEvent,
  RestockSelloutInterval,
  RestockSelloutOptions,
  RestockSelloutResult,
  StockState,
} from "./metrics.ts";

export {
  DISPATCH_TASK_NAME,
  POLL_TARGET_TASK_NAME,
  createMarketTasks,
  defaultPollExecutor,
} from "./tasks.ts";
export type {
  AdaptivePollFacts,
  DispatchTask,
  MarketCronItem,
  MarketTasks,
  PollExecutor,
  PollOutcome,
  PollTargetTask,
} from "./tasks.ts";
