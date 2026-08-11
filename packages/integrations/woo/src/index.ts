/**
 * @loxep/integration-woo — Loxep's WooCommerce integration boundary (ADR-0009).
 *
 * Native `fetch` against the WooCommerce REST API v3 over HTTPS Basic Auth,
 * with no client library: typed config, the same error taxonomy shape as the
 * eBay adapter, a per-connection rate budget, header-driven pagination, and
 * mapping into Loxep-owned order/product facts aligned to the Commerce Schema
 * Design.
 *
 * SCOPE: read adapters only. This package writes nothing — the Phase 3
 * commerce tables do not exist and persistence is deliberately excluded
 * pending the commerce-schema-design review. See `connection.ts` for the
 * documented (unimplemented) connection contract.
 *
 * No provider SDK type appears in any exported type below, because there is no
 * provider SDK; raw payloads cross the boundary as `Record<string, unknown>`
 * behind clearly named `WooRaw*Payload` aliases.
 */

export {
  WOO_ERROR_KINDS,
  WooAdapterError,
  isPageOutOfRangeCode,
  normalizeWooError,
  readWooErrorBody,
  wooErrorFromResponse,
  wooKindFromStatus,
} from "./errors.ts";
export type {
  WooErrorContext,
  WooErrorKind,
  WooProviderErrorBody,
} from "./errors.ts";

export { createRateBudget } from "./rate-budget.ts";
export type {
  CreateRateBudgetOptions,
  RateBudget,
  RateBudgetStats,
  WooAdapterLogger,
} from "./rate-budget.ts";

export {
  WOO_DEFAULT_NAMESPACE,
  WOO_DEFAULT_REST_ROOT,
  normalizeWooBaseUrl,
  parseWooAdapterConfig,
  wooAdapterConfigSchema,
  wooSourceAccountKey,
} from "./config.ts";
export type {
  WooAdapterConfig,
  WooAdapterConfigInput,
} from "./config.ts";

export {
  defaultWooEnvFilePath,
  loadWooCredentialsFromEnvFile,
} from "./credentials.ts";
export type { WooStoreCredentials } from "./credentials.ts";

export {
  DECIMAL_STRING,
  absDecimal,
  decimalFromNumber,
  decimalFromProvider,
  decimalFromUnknown,
  isDecimalString,
  isZeroDecimal,
  subtractDecimals,
  sumDecimals,
} from "./money.ts";

export {
  WOO_DEFAULT_PER_PAGE,
  WOO_MAX_PER_PAGE,
  createWooAdapter,
  linkHeaderHasNext,
} from "./adapter.ts";
export type {
  CreateWooAdapterInput,
  WooAdapter,
  WooAdapterStats,
  WooFetch,
  WooListPage,
  WooPageInfo,
  WooPaginateOptions,
  WooQuery,
  WooQueryValue,
  WooResponse,
} from "./adapter.ts";

export {
  WOO_FULFILLMENT_STATUSES,
  WOO_ORDER_STATUSES,
  WOO_PAYMENT_STATUSES,
  WOO_STATUS_MAP,
  WOO_UNKNOWN_STATUS_MAPPING,
  buildWooOrdersQuery,
  fetchOrders,
  fetchOrdersPage,
  isoFromWooGmt,
  iterateWooOrders,
  mapWooOrder,
  normalizeWooStatusSlug,
  redactWooOrderFact,
} from "./orders.ts";
export type {
  FetchWooOrdersInput,
  MapWooOrderOptions,
  WooFeeLineFact,
  WooFulfillmentStatus,
  WooOrderFact,
  WooOrderLineFact,
  WooOrderPage,
  WooOrderStatus,
  WooOrderTotals,
  WooPaymentStatus,
  WooRawOrderPayload,
  WooRefundRef,
  WooStatusMapping,
} from "./orders.ts";

export {
  WOO_PRODUCT_STATUSES,
  buildWooProductsQuery,
  fetchProducts,
  fetchProductsPage,
  iterateWooProducts,
  mapWooProduct,
} from "./products.ts";
export type {
  FetchWooProductsInput,
  WooProductFact,
  WooProductPage,
  WooProductStatus,
  WooRawProductPayload,
} from "./products.ts";

export { probeConnection } from "./probe.ts";
export type { WooProbeResult, WooStoreInfo } from "./probe.ts";

// Documentation-only module; imported for its module doc, exports nothing.
export * from "./connection.ts";
