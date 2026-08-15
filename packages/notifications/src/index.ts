/**
 * @loxep/notifications — notification endpoints/rules, transport-neutral
 * delivery, and the ntfy transport skeleton (Phase 0 foundation; event
 * detection and delivery are separate concepts).
 */

export {
  NotificationNotFoundError,
  NotificationTransportError,
  NotificationValidationError,
  NotificationsError,
} from "./errors.ts";

export {
  MARKET_EVENT_TYPES,
  NTFY_PRIORITIES,
  ruleEventTypesForClass,
  createNotificationService,
  endpointConfigSchemas,
  endpointSecretKey,
  matchRules,
  ntfyEndpointConfigSchema,
} from "./endpoints.ts";
export type {
  CreateEndpointInput,
  CreateRuleInput,
  NotificationEndpointRow,
  NotificationProvider,
  NotificationRuleRow,
  NotificationService,
  NtfyEndpointConfig,
  NtfyPriority,
  RuleMatchEvent,
  UpdateEndpointInput,
  UpdateRuleInput,
} from "./endpoints.ts";

export { createNtfyTransport } from "./transport.ts";
export type {
  FetchLike,
  NotificationMessage,
  NotificationTransport,
  TransportSendInput,
  TransportSendResult,
} from "./transport.ts";

export {
  DELIVERY_STATUSES,
  DELIVER_TASK_NAME,
  createDeliveryPipeline,
  deliveryJobKey,
  renderMarketEventMessage,
} from "./deliver.ts";

// The notifiable-event renderers (ADR-0023). Pure functions over a recorded
// row, so the same code renders the outbound message and the in-app feed.
export {
  marketEventFromNotificationEvent,
  renderNotificationEventMessage,
  renderMarketEventMessage as renderEnrichedMarketEventMessage,
} from "./render.ts";
export type {
  RenderableListingItem,
  RenderableMarketEvent,
} from "./render.ts";
export type {
  DeliverableMarketEvent,
  DeliverTask,
  DeliveryPipeline,
  DeliveryRow,
  DeliveryStatus,
} from "./deliver.ts";
