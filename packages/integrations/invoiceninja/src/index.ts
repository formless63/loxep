/**
 * @loxep/integration-invoiceninja — Loxep's Invoice Ninja v5 integration
 * boundary (ADR-0009).
 *
 * Native `fetch` against the self-hosted Invoice Ninja REST API over HTTPS
 * company-token auth (`X-API-TOKEN`), with no client library: typed config,
 * the same 5-kind error taxonomy shape as the eBay/WooCommerce/Medusa
 * adapters, a per-connection rate budget, page-number pagination over a
 * Fractal `ArraySerializer` envelope, and mapping to/from Loxep-owned
 * client/invoice facts aligned to the Services & Billing Schema Design.
 *
 * SOURCE-VERIFIED against `invoiceninja/invoiceninja`'s `v5-stable` branch
 * (fetched 2026-08-13) — see each module's own doc for the exact files and
 * lines cited. LIVE-PROBED, READ-ONLY AND UNAUTHENTICATED ONLY, against a
 * real self-hosted instance running on this host (`invoiceninja-web`
 * container, `X-APP-VERSION: 5.13.24`) — no write credential was available
 * in this environment, so `errors.ts`'s auth-failure taxonomy is
 * live-confirmed but every write path (`createInvoice`, `markInvoiceSent`,
 * `createClient`, …) and every money/pagination/timestamp claim rests on
 * Invoice Ninja's own PHP source rather than an observed response. Live
 * write verification is tracked as the follow-up bead (see this package's
 * `test/live-instance.test.ts`, which names the credential file it needs).
 *
 * SCOPE: this package is the adapter only. It writes to Invoice Ninja
 * (unlike the read-only Medusa/WooCommerce adapters, because the billing
 * design requires pushing invoice drafts) but persists nothing to Loxep's
 * own database — the counterparty/project/invoice tables this adapter's
 * facts would round-trip against are Services & Billing Schema Design work,
 * mostly not yet implemented (see that document's "Provisional
 * implementation decisions" section). See `connection.ts` for the
 * documented (unimplemented) connection contract, including why this
 * provider registers no `monitor_targets` target type.
 *
 * No provider SDK type appears in any exported type below, because this
 * adapter uses none; raw payloads cross the boundary as
 * `Record<string, unknown>` behind clearly named `InvoiceNinjaRaw*Payload`
 * aliases.
 */

export {
  INVOICENINJA_ERROR_KINDS,
  InvoiceNinjaAdapterError,
  invoiceNinjaErrorFromResponse,
  invoiceNinjaKindFromStatus,
  normalizeInvoiceNinjaError,
  readInvoiceNinjaErrorBody,
} from "./errors.ts";
export type {
  InvoiceNinjaErrorContext,
  InvoiceNinjaErrorKind,
  InvoiceNinjaProviderErrorBody,
} from "./errors.ts";

export { createRateBudget } from "./rate-budget.ts";
export type {
  CreateRateBudgetOptions,
  RateBudget,
  RateBudgetStats,
  InvoiceNinjaAdapterLogger,
} from "./rate-budget.ts";

export {
  INVOICENINJA_API_PATH,
  invoiceNinjaAdapterConfigSchema,
  invoiceNinjaSourceAccountKey,
  normalizeInvoiceNinjaBaseUrl,
  parseInvoiceNinjaAdapterConfig,
} from "./config.ts";
export type {
  InvoiceNinjaAdapterConfig,
  InvoiceNinjaAdapterConfigInput,
} from "./config.ts";

export {
  defaultInvoiceNinjaEnvFilePath,
  loadInvoiceNinjaCredentialsFromEnvFile,
} from "./credentials.ts";
export type { InvoiceNinjaInstanceCredentials } from "./credentials.ts";

export {
  DECIMAL_STRING,
  decimalFromNumber,
  decimalFromProvider,
  decimalFromUnknown,
  isDecimalString,
  numberFromDecimal,
} from "./money.ts";

export {
  INVOICENINJA_DEFAULT_PER_PAGE,
  INVOICENINJA_MAX_PER_PAGE,
  createInvoiceNinjaAdapter,
} from "./adapter.ts";
export type {
  CreateInvoiceNinjaAdapterInput,
  InvoiceNinjaAdapter,
  InvoiceNinjaAdapterStats,
  InvoiceNinjaFetch,
  InvoiceNinjaHttpMethod,
  InvoiceNinjaListPage,
  InvoiceNinjaPageInfo,
  InvoiceNinjaPaginateOptions,
  InvoiceNinjaQuery,
  InvoiceNinjaQueryValue,
  InvoiceNinjaResponse,
} from "./adapter.ts";

export { probeConnection } from "./probe.ts";
export type { InvoiceNinjaProbeResult } from "./probe.ts";

export {
  buildInvoiceNinjaClientPayload,
  createClient,
  fetchClient,
  fetchClientsPage,
  isoFromInvoiceNinjaTimestamp,
  mapInvoiceNinjaClient,
  redactInvoiceNinjaClientFact,
  updateClient,
} from "./clients.ts";
export type {
  FetchInvoiceNinjaClientsInput,
  InvoiceNinjaClientFact,
  InvoiceNinjaClientPage,
  InvoiceNinjaContactFact,
  InvoiceNinjaCreateClientInput,
  InvoiceNinjaRawClientPayload,
} from "./clients.ts";

export {
  INVOICENINJA_INVOICE_STATUS_MAP,
  INVOICENINJA_INVOICE_STATUSES,
  INVOICENINJA_NATIVE_INVOICE_STATUSES,
  buildInvoiceNinjaInvoicePayload,
  createInvoice,
  fetchInvoice,
  fetchInvoicesPage,
  mapInvoiceNinjaInvoice,
  markInvoiceSent,
  redactInvoiceNinjaInvoiceFact,
  updateInvoice,
} from "./invoices.ts";
export type {
  FetchInvoiceNinjaInvoicesInput,
  InvoiceNinjaCreateInvoiceInput,
  InvoiceNinjaCreateLineItemInput,
  InvoiceNinjaInvoiceFact,
  InvoiceNinjaInvoicePage,
  InvoiceNinjaInvoiceStatus,
  InvoiceNinjaLineItemFact,
  InvoiceNinjaNativeInvoiceStatus,
  InvoiceNinjaRawInvoicePayload,
} from "./invoices.ts";

// Documentation-only module; imported for its module doc, exports nothing.
export * from "./connection.ts";
