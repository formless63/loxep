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
  renderMarketEventMessage,
} from "./deliver.ts";
export type {
  DeliverableMarketEvent,
  DeliverTask,
  DeliveryPipeline,
  DeliveryRow,
  DeliveryStatus,
} from "./deliver.ts";
