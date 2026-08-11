/**
 * Connection probe: "can these credentials read this store, and what is it?"
 *
 * Two strategies, tried in order, because what a key pair may read depends on
 * the WordPress ROLE of the user the key belongs to, not on the key's own
 * read/write permission:
 *
 * 1. `GET /wc/v3/system_status` — needs `manage_woocommerce`, i.e. a key
 *    issued to a Shop Manager or Administrator. Verified live: a READ-ONLY key
 *    pair on the production store returns HTTP 200 with
 *    `environment.version` (the **WooCommerce** version, `10.9.3`) and
 *    `environment.wp_version` (the **WordPress** version, `6.9.6`).
 *    The response also enumerates plugins, theme, and settings, so this
 *    module extracts exactly two strings and discards the rest.
 * 2. `GET /wc/v3/orders?per_page=1&_fields=id,version` — the graceful
 *    degradation. Any key that can do order ingestion at all can do this, and
 *    the order payload's own `version` field carries the WooCommerce version,
 *    so `wcVersion` survives even without `manage_woocommerce`. `_fields`
 *    (a WordPress REST core parameter, verified working on the live store)
 *    keeps the probe from pulling customer PII across the wire at all.
 *
 * `ok: false` is returned — not thrown — when both strategies fail, carrying
 * the normalized taxonomy `kind`. A probe is a diagnostic: an integration
 * health surface wants "auth" or "provider_unavailable" as data, not as a
 * stack unwind. Bogus credentials therefore produce
 * `{ ok: false, error: { kind: "auth" } }`.
 */
import type { WooAdapter } from "./adapter.ts";
import { normalizeWooError, WooAdapterError, type WooErrorKind } from "./errors.ts";

export interface WooStoreInfo {
  /** WordPress version (`environment.wp_version`). */
  wpVersion: string | null;
  /** WooCommerce version (`environment.version`, or an order's `version`). */
  wcVersion: string | null;
}

export interface WooProbeResult {
  ok: boolean;
  storeInfo: WooStoreInfo;
  /** Which strategy answered. `null` when neither did. */
  probe: "system_status" | "orders" | null;
  /** Store root and REST namespace the probe used. */
  baseUrl: string;
  namespace: string;
  /** `X-WP-Total` from the orders fallback, when that path ran. */
  visibleOrderCount: number | null;
  /** Present only when `ok` is false. Message is the adapter's sanitized one. */
  error?: { kind: WooErrorKind; message: string };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export async function probeConnection(
  adapter: WooAdapter,
): Promise<WooProbeResult> {
  const base = {
    baseUrl: adapter.baseUrl,
    namespace: adapter.namespace,
  };

  try {
    const response = await adapter.get("/system_status", undefined, {
      operation: "probe.system_status",
    });
    const environment = asRecord(asRecord(response.data)?.["environment"]);
    if (environment !== null) {
      return {
        ok: true,
        ...base,
        probe: "system_status",
        storeInfo: {
          wpVersion: asText(environment["wp_version"]),
          // `environment.version` is the WooCommerce plugin version. Older
          // shapes also expose `wc_version`; accept either.
          wcVersion:
            asText(environment["version"]) ?? asText(environment["wc_version"]),
        },
        visibleOrderCount: null,
      };
    }
    // 200 but not the documented shape — fall through to the orders probe
    // rather than reporting a store we cannot describe.
  } catch (error) {
    const normalized =
      error instanceof WooAdapterError
        ? error
        : normalizeWooError(error, {
            operation: "probe.system_status",
            path: "/system_status",
          });
    // An auth failure HERE may only mean "this key's user lacks
    // manage_woocommerce", which is survivable — the orders probe decides.
    if (
      normalized.kind !== "auth" &&
      normalized.kind !== "not_found" &&
      normalized.kind !== "invalid_request"
    ) {
      return {
        ok: false,
        ...base,
        probe: null,
        storeInfo: { wpVersion: null, wcVersion: null },
        visibleOrderCount: null,
        error: { kind: normalized.kind, message: normalized.message },
      };
    }
  }

  try {
    const result = await adapter.list(
      "/orders",
      { per_page: 1, status: "any", _fields: "id,version" },
      { operation: "probe.orders" },
    );
    const first = result.items[0];
    return {
      ok: true,
      ...base,
      probe: "orders",
      storeInfo: {
        wpVersion: null,
        wcVersion: first === undefined ? null : asText(first["version"]),
      },
      visibleOrderCount: result.page.total,
    };
  } catch (error) {
    const normalized =
      error instanceof WooAdapterError
        ? error
        : normalizeWooError(error, {
            operation: "probe.orders",
            path: "/orders",
          });
    return {
      ok: false,
      ...base,
      probe: null,
      storeInfo: { wpVersion: null, wcVersion: null },
      visibleOrderCount: null,
      error: { kind: normalized.kind, message: normalized.message },
    };
  }
}
