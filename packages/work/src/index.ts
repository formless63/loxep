/**
 * @loxep/work — projects, time, rates, and materials (the Projects and Work
 * domain of Phase 6).
 *
 * ## Why this package exists, and what it does NOT yet cover
 *
 * Migration 0011 (`loxep-nw0`) shipped the physical schema for `projects`,
 * `billing_rates`, `time_entries`, and `project_material_uses` with no
 * service package — open question 14 of
 * `apps/docs/src/content/docs/architecture/services-billing-schema-design.md`
 * names `@loxep/work` as the owner and new package scaffolding was, at the
 * time, an orchestrator-only decision. This package is that scaffolding,
 * filled in: project CRUD, time-entry recording with rate resolution,
 * material-use recording, and the unbilled-work read model.
 *
 * **`service_plans`, `subscriptions`, `subscription_items`, `service_periods`,
 * `service_period_charges`, `invoices`, `invoice_lines`,
 * `invoice_line_sources`, and `invoice_payments` remain entirely design-only.**
 * This package's own unbilled-work read model ({@link createUnbilledWorkService})
 * is explicit about the consequence: it can only ever compute the
 * time-and-materials half of the design's four-source join, and the "billed"
 * side is an injectable seam rather than a real `invoice_line_sources`
 * anti-join. See `unbilled.ts`'s module doc.
 *
 * ## Dependency boundary
 *
 * This package declares only `@loxep/db` and `zod`. It does **not** depend on
 * `@loxep/domain` (no audit-trail integration — every other Phase 6 service
 * package uses `createAuditService`; this one cannot) or `@loxep/inventory`
 * (materials recording references inventory rows by id but never writes an
 * `inventory_movements` row itself — see `materials.ts`'s module doc for what
 * a caller holding both packages is expected to compose).
 */

export {
  WorkBoundaryError,
  WorkConflictError,
  WorkError,
  WorkNotFoundError,
  WorkValidationError,
} from "./errors.ts";

export { projectReferenceCode, isUniqueViolation, withCodeRetry } from "./codes.ts";

export {
  DECIMAL_STRING,
  MONEY_SCALE,
  ZERO,
  divideByInteger,
  fromUnits,
  isDecimalString,
  isNegativeDecimal,
  multiplyDecimals,
  subtractDecimals,
  sumDecimals,
  toUnits,
} from "./decimal.ts";

export { resolveRate } from "./rates.ts";
export type { RateResolutionInput, RateResolutionResult } from "./rates.ts";

export { createBillingRatesService } from "./billing-rates.ts";
export type {
  BillingRateListFilter,
  BillingRateRow,
  BillingRatesService,
  CreateBillingRateInput,
} from "./billing-rates.ts";

export { createProjectsService } from "./projects.ts";
export type {
  CreateProjectInput,
  ProjectListFilter,
  ProjectRow,
  ProjectsService,
  UpdateProjectInput,
  UpdateProjectStatusInput,
} from "./projects.ts";

export {
  createTimeService,
  mapTimeEntryRow,
  timeEntryBillableAmount,
  timeEntryCostAmount,
} from "./time.ts";
export type {
  RecordTimeEntryInput,
  TimeEntryListFilter,
  TimeEntryRow,
  TimeService,
  UpdateTimeEntryInput,
} from "./time.ts";

export {
  applyMarkupPercent,
  createMaterialsService,
  mapMaterialUseRow,
  materialUseLineAmount,
} from "./materials.ts";
export type {
  MaterialsService,
  ProjectMaterialUseRow,
  RecordMaterialUseInput,
  UpdateMaterialUseInput,
} from "./materials.ts";

export { alwaysUnbilledResolver, createUnbilledWorkService } from "./unbilled.ts";
export type {
  BilledResolver,
  CurrencyTotal,
  SourceFactType,
  UnbilledWorkFilter,
  UnbilledWorkService,
  UnbilledWorkSummary,
} from "./unbilled.ts";
