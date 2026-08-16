/**
 * @loxep/domain — settings, secrets, credentials, audit, economic-entity,
 * and connection domain services (ADR-0016, ADR-0017, ADR-0019, ADR-0020).
 */

export {
  DomainError,
  SettingNotRegisteredError,
  SettingValidationError,
  SecretCipherError,
  BundleValidationError,
  UnknownPurposeError,
  SecretNotFoundError,
  SecretsServiceError,
  DomainValidationError,
  EntityNotFoundError,
  EntityHierarchyError,
  EntityInactiveError,
  ConnectionNotFoundError,
  ConnectionInUseError,
} from "./errors.ts";
export type { ConnectionReferenceCount } from "./errors.ts";

export { REDACTED, redactJson } from "./redact.ts";
export type { RedactOptions } from "./redact.ts";

export { createAuditService } from "./audit.ts";
export type {
  AuditAppendInput,
  AuditExecutor,
  AuditService,
} from "./audit.ts";

export {
  defineSetting,
  createSettingsService,
  findRegisteredSetting,
  registeredSettingKeys,
} from "./settings.ts";
export type {
  SettingDefinition,
  SettingListEntry,
  SettingsService,
  SettingWriteOptions,
} from "./settings.ts";

// Importing this module is what REGISTERS Loxep's shipped settings; every
// process that reaches the registry through `@loxep/domain` therefore sees
// the same keys (see the module doc for why they live in this package).
export {
  authOnboardingOidcPromptDismissedSetting,
  authProvisioningSetting,
  caaPolicySetting,
  cloudflareRateBudgetSetting,
  deriveGatusPushFactKey,
  documentsMediaLimitsSetting,
  documentsParserIdSetting,
  ebayRateBudgetSetting,
  GATUS_PUSH_FACT_SLUGS,
  GATUS_PUSH_SECRET_KEY,
  gatusPushFactKeys,
  gatusPushSetting,
  gatusRateBudgetSetting,
  integrationsEnabledSetting,
  inventoryDefaultSaleModeSetting,
  inventoryMediaLimitsSetting,
  ipAliasesSetting,
  monitorDefaultsSetting,
  monitorObservationCapsSetting,
  orderPayloadRetentionSetting,
  providerWritePolicySetting,
  registeredApplicationSettings,
  tailscaleIgnoredDevicesSetting,
  wooRateBudgetSetting,
} from "./settings-defaults.ts";
export type { GatusPushFactSlug } from "./settings-defaults.ts";

export {
  PROVIDER_WRITE_POLICY_TIER_DESCRIPTIONS,
  PROVIDER_WRITE_POLICY_TIER_LABELS,
  PROVIDER_WRITE_POLICY_TIERS,
  providerWritePolicyTierRank,
  providerWritePolicyTierSchema,
  resolveProviderWritePolicy,
} from "./provider-write-policy.ts";
export type { ProviderWritePolicyTier } from "./provider-write-policy.ts";

export {
  formatIpAliasReference,
  IP_ALIAS_REFERENCE_PREFIX,
  IP_ALIAS_SOURCES,
  ipAliasCidrValue,
  ipAliasEntrySchema,
  ipAliasesSchema,
  ipAliasNameSchema,
  parseIpAliasReference,
} from "./ip-aliases.ts";
export type { IpAliasEntry, IpAliasMap, IpAliasSource } from "./ip-aliases.ts";

export {
  applicationSecretAad,
  connectionCredentialAad,
  createSecretCipher,
} from "./crypto.ts";
export type { EncryptedRecord, SecretCipher } from "./crypto.ts";

export {
  isSecretPurpose,
  secretBundleSchemas,
  secretPurposes,
  validateBundle,
} from "./bundles.ts";
export type {
  SecretBundle,
  SecretPayload,
  SecretPurpose,
} from "./bundles.ts";

export { createSecretsService } from "./secrets.ts";
export type {
  SecretMetadata,
  SecretWriteResult,
  SecretsService,
} from "./secrets.ts";

export { createConnectionCredentialsService } from "./connection-credentials.ts";
export type {
  ConnectionCredentialsService,
  CredentialMetadata,
  CredentialWriteResult,
} from "./connection-credentials.ts";

export { createEconomicEntitiesService } from "./economic-entities.ts";
export type {
  EconomicEntitiesService,
  EconomicEntity,
  EconomicEntityListEntry,
  EconomicEntityTreeNode,
  EntityMutationOptions,
} from "./economic-entities.ts";

export {
  CONNECTION_REFERENCE_TABLES,
  CONNECTION_STATUSES,
  createConnectionsService,
  isConnectionArchived,
} from "./connections.ts";
export type {
  Connection,
  ConnectionDeleteResult,
  ConnectionMutationOptions,
  ConnectionReferences,
  ConnectionStatus,
  ConnectionsService,
} from "./connections.ts";

export {
  compareFleetToolPanelOrder,
  fleetDiscoveredResourcePurpose,
  FLEET_TOOL_PANEL_ORDER,
  FLEET_TOOL_PROVIDERS,
  FLEET_TOOL_REGISTRY,
  isFleetToolProvider,
  PROBEABLE_FLEET_TOOL_PROVIDERS,
} from "./fleet-tool-registry.ts";
export type {
  FleetToolProvider,
  FleetToolRegistryEntry,
} from "./fleet-tool-registry.ts";

export {
  createHealthService,
  guardHealthDetail,
  HEALTH_SOURCES,
  HEALTH_STATUSES,
  HEALTH_SUBJECT_TYPES,
} from "./health.ts";
export type {
  HealthListFilter,
  HealthRow,
  HealthService,
  HealthSource,
  HealthStatus,
  HealthSubjectType,
  UpsertHealthInput,
} from "./health.ts";

export {
  BASE_PROBE_INTERVAL_SECONDS,
  createDefaultHealthSubjectRegistry,
  DEFAULT_MAX_SUBJECTS_PER_TYPE,
  healthTransitionEventType,
  isHealthCheckDue,
  MAX_PROBE_INTERVAL_SECONDS,
  nextHealthCheckDueAt,
  runHealthSweep,
} from "./health-probes.ts";
export type {
  CreateDefaultHealthSubjectRegistryOptions,
  HealthFetch,
  HealthProbeOutcome,
  HealthSubjectCandidate,
  HealthSubjectRegistry,
  HealthSubjectRegistryEntry,
  HealthSweepResult,
  HealthTransition,
  RunHealthSweepOptions,
} from "./health-probes.ts";

// The notifiable-event ledger (ADR-0023): detection-side, so it lives here
// rather than in @loxep/notifications, which every emitting package is
// forbidden to depend on. See ./notification-events.ts.
export {
  createRecordingNotificationEnqueue,
  createTransactionalNotificationEnqueue,
  DOCUMENT_EVENT_TYPES,
  HEALTH_EVENT_TYPES,
  INFRASTRUCTURE_EVENT_TYPES,
  MARKET_EVENT_TYPES,
  NOTIFIABLE_HEALTH_SUBJECT_TYPES,
  NOTIFICATION_DELIVER_TASK,
  NOTIFICATION_EVENT_CLASSES,
  NOTIFICATION_SUBJECT_TYPES,
  notificationDeliverJobKey,
  notificationEventClasses,
  notificationEventTypeOptions,
  publishNotificationEvent,
  PURCHASE_EVENT_TYPES,
  recordNotificationEvent,
  routeNotificationEvent,
  SALE_EVENT_TYPES,
} from "./notification-events.ts";
export type {
  NotifiableHealthSubjectType,
  NotificationEnqueue,
  NotificationEventClass,
  NotificationEventClassDefinition,
  NotificationEventExecutor,
  NotificationEventRow,
  NotificationSubjectType,
  PublishNotificationEventOptions,
  RecordNotificationEventInput,
  RoutableNotificationEvent,
} from "./notification-events.ts";

export {
  diagnoseHostWitnesses,
  HOST_DIAGNOSIS_LADDER,
  HOST_DIAGNOSIS_REASONS,
} from "./host-diagnosis.ts";
export type {
  HostDiagnosisInput,
  HostDiagnosisReason,
  HostDiagnosisResult,
  HostDiagnosisWitness,
  HostDiagnosisWitnessSignal,
} from "./host-diagnosis.ts";

export {
  createResourceLinksService,
  RESOURCE_LINK_RESOURCE_TYPES,
  resourceLinkResourceTypeConfig,
} from "./resource-links.ts";
export type {
  AttachLinkInput,
  CompanionLink,
  CreateLinkInput,
  DetachLinkInput,
  ExternalResourceRow,
  RegisterExternalResourceInput,
  ResourceLinkResourceType,
  ResourceLinkRow,
  ResourceLinksService,
} from "./resource-links.ts";

// Fleet alert evidence ingestion (Phase 8 milestone 7, loxep-ovj.7): the
// ingest-only connection kind and the generic (Databasus-class) evidence
// contract. Provider-specific normalizers live at their own integration
// boundary — see fleet-evidence.ts's module doc.
export {
  EVIDENCE_INGEST_CONNECTION_KIND,
  FLEET_EVIDENCE_PROVIDERS,
  genericEvidenceWebhookSchema,
  isEvidenceIngestConnectionKind,
  isFleetEvidenceProvider,
  normalizeGenericEvidenceWebhook,
} from "./fleet-evidence.ts";
export type {
  FleetEvidenceAccepted,
  FleetEvidenceDropped,
  FleetEvidenceNormalization,
  FleetEvidenceProvider,
  GenericEvidenceWebhookPayload,
} from "./fleet-evidence.ts";
