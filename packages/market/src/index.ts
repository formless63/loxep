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
  MAX_BACKOFF_SECONDS,
  MONITOR_TARGET_TYPES,
  backoffSeconds,
  claimDueTargets,
  collectAdaptiveSignals,
  createMonitorService,
  monitorTargetConfigSchemas,
  recordPollFailure,
  recordPollSuccess,
} from "./monitors.ts";
export type {
  AdaptiveSignals,
  ClaimedTarget,
  CreateMonitorTargetInput,
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
  latestObservations,
  linkItemToMonitor,
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
} from "./observations.ts";

export {
  AVAILABILITY_IN_STOCK,
  AVAILABILITY_OUT_OF_STOCK,
  LISTING_STATE_ENDED,
  MARKET_EVENT_TYPES,
  compareDecimalStrings,
  compareObservations,
  deduplicationKeyFor,
  deriveMarketEvents,
} from "./events.ts";
export type {
  DetectedMarketEvent,
  MarketEventRow,
  MarketEventType,
  ObservationSnapshot,
} from "./events.ts";

export {
  OPPORTUNITY_PAYLOAD_KEY,
  SCORE_SCALE,
  createOpportunityRulesService,
  evaluateRule,
  evaluateRulesForEvent,
  listEnabledRulesForEvaluation,
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
  availabilityHistory,
  computePriceChangePercent,
  deriveRestockSelloutIntervals,
  itemActivitySummary,
  priceHistory,
  restockSellout,
} from "./metrics.ts";
export type {
  AvailabilityHistoryBucket,
  AvailabilityHistoryOptions,
  ItemActivitySummary,
  ItemActivitySummaryOptions,
  PriceHistoryBucket,
  PriceHistoryOptions,
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
