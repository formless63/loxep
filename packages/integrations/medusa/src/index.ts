/**
 * @loxep/integration-medusa — Loxep's Medusa v2 integration boundary
 * (ADR-0009).
 *
 * Native `fetch` against the Medusa Admin REST API over HTTPS secret-API-key
 * auth, with no client library: typed config, the same error taxonomy shape
 * as the eBay/WooCommerce adapters, a per-connection rate budget,
 * body-driven pagination, and mapping into Loxep-owned order/product facts
 * aligned to the Commerce Schema Design.
 *
 * NO LIVE MEDUSA INSTANCE EXISTS IN THIS ENVIRONMENT. This package was built
 * fixtures-only, verified against Medusa's own GitHub source (`develop`
 * branch, fetched 2026-08-11) and the `docs.medusajs.com` narrative pages
 * that were fetchable — never against a running backend. See `orders.ts`,
 * `money.ts`, and `connection.ts` for the full citation trail, and the
 * "Live-verify Medusa adapter against a real instance" follow-up bead
 * (parent loxep-xh9.4) for the tracked gap.
 *
 * SCOPE: read adapters only. This package writes nothing — the Phase 3
 * commerce tables do not exist and persistence is deliberately excluded.
 * See `connection.ts` for the documented (unimplemented) connection
 * contract.
 *
 * No provider SDK type appears in any exported type below, because this
 * adapter uses none; raw payloads cross the boundary as
 * `Record<string, unknown>` behind clearly named `MedusaRaw*Payload`
 * aliases.
 */

export {
  MEDUSA_ERROR_KINDS,
  MedusaAdapterError,
  medusaErrorFromResponse,
  medusaKindFromStatus,
  normalizeMedusaError,
  readMedusaErrorBody,
} from "./errors.ts";
export type {
  MedusaErrorContext,
  MedusaErrorKind,
  MedusaProviderErrorBody,
} from "./errors.ts";

export { createRateBudget } from "./rate-budget.ts";
export type {
  CreateRateBudgetOptions,
  RateBudget,
  RateBudgetStats,
  MedusaAdapterLogger,
} from "./rate-budget.ts";

export {
  MEDUSA_ADMIN_PATH,
  medusaAdapterConfigSchema,
  medusaSourceAccountKey,
  normalizeMedusaBaseUrl,
  parseMedusaAdapterConfig,
} from "./config.ts";
export type {
  MedusaAdapterConfig,
  MedusaAdapterConfigInput,
} from "./config.ts";

export {
  defaultMedusaEnvFilePath,
  loadMedusaCredentialsFromEnvFile,
} from "./credentials.ts";
export type { MedusaBackendCredentials } from "./credentials.ts";

export {
  DECIMAL_STRING,
  MEDUSA_CURRENCY_DECIMAL_DIGITS,
  absDecimal,
  decimalFromNumber,
  decimalFromProvider,
  decimalFromUnknown,
  excessPrecisionDigits,
  isDecimalString,
  isZeroDecimal,
  medusaCurrencyDecimalDigits,
  normalizeMedusaCurrencyCode,
  subtractDecimals,
  sumDecimals,
} from "./money.ts";

export {
  MEDUSA_DEFAULT_LIMIT,
  MEDUSA_MAX_LIMIT,
  createMedusaAdapter,
} from "./adapter.ts";
export type {
  CreateMedusaAdapterInput,
  MedusaAdapter,
  MedusaAdapterStats,
  MedusaFetch,
  MedusaListPage,
  MedusaPageInfo,
  MedusaPaginateOptions,
  MedusaQuery,
  MedusaQueryValue,
  MedusaResponse,
} from "./adapter.ts";

export {
  MEDUSA_DEFAULT_ORDER_FIELDS,
  MEDUSA_FULFILLMENT_STATUSES,
  MEDUSA_FULFILLMENT_STATUS_MAP,
  MEDUSA_NATIVE_FULFILLMENT_STATUSES,
  MEDUSA_NATIVE_ORDER_STATUSES,
  MEDUSA_NATIVE_PAYMENT_STATUSES,
  MEDUSA_ORDER_STATUSES,
  MEDUSA_PAYMENT_STATUSES,
  MEDUSA_PAYMENT_STATUS_MAP,
  MEDUSA_STATUS_MAP,
  buildMedusaOrdersQuery,
  fetchOrders,
  fetchOrdersPage,
  isoFromMedusa,
  iterateMedusaOrders,
  mapMedusaOrder,
  redactMedusaOrderFact,
} from "./orders.ts";
export type {
  FetchMedusaOrdersInput,
  MapMedusaOrderOptions,
  MedusaFulfillmentFact,
  MedusaFulfillmentStatus,
  MedusaNativeFulfillmentStatus,
  MedusaNativeOrderStatus,
  MedusaNativePaymentStatus,
  MedusaOrderFact,
  MedusaOrderLineFact,
  MedusaOrderPage,
  MedusaOrderStatus,
  MedusaPaymentStatus,
  MedusaRawOrderPayload,
  MedusaRefundFact,
} from "./orders.ts";

export {
  MEDUSA_PRODUCT_STATUSES,
  buildMedusaProductsQuery,
  fetchProducts,
  fetchProductsPage,
  iterateMedusaProducts,
  mapMedusaProduct,
} from "./products.ts";
export type {
  FetchMedusaProductsInput,
  MedusaProductFact,
  MedusaProductPage,
  MedusaProductStatus,
  MedusaProductVariantFact,
  MedusaRawProductPayload,
  MedusaVariantPriceFact,
} from "./products.ts";

export { probeConnection } from "./probe.ts";
export type { MedusaProbeResult } from "./probe.ts";

// Documentation-only module; imported for its module doc, exports nothing.
export * from "./connection.ts";
