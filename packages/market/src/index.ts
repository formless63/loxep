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
  createMonitorService,
  monitorTargetConfigSchemas,
  recordPollFailure,
  recordPollSuccess,
} from "./monitors.ts";
export type {
  ClaimedTarget,
  CreateMonitorTargetInput,
  MonitorService,
  MonitorTargetRow,
  MonitorTargetType,
  UpdateMonitorTargetInput,
} from "./monitors.ts";

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
  DISPATCH_TASK_NAME,
  POLL_TARGET_TASK_NAME,
  createMarketTasks,
  defaultPollExecutor,
} from "./tasks.ts";
export type {
  DispatchTask,
  MarketCronItem,
  MarketTasks,
  PollExecutor,
  PollOutcome,
  PollTargetTask,
} from "./tasks.ts";
