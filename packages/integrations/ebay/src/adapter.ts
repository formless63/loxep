/**
 * eBay adapter (loxep-62y.1.1): a thin Loxep-owned boundary over
 * hendt/ebay-api v10 (ADR-0009). The library provides construction
 * (`new eBayApi({appId, certId, devId, sandbox, ruName?})`), OAuth2
 * client-credentials token management (Restful calls invoke
 * `auth.getHeaderAuthorization()` → `OAuth2.getAccessToken()`, which mints
 * and caches an application access token when no user token is set), and the
 * Buy Browse API group — none of that is re-implemented here.
 *
 * Boundary rules enforced by this module:
 * - provider SDK types never appear in exported types (raw payloads cross as
 *   `Record<string, unknown>`);
 * - every API call acquires from the per-connection {@link RateBudget}
 *   BEFORE touching the network;
 * - every failure is normalized to {@link EbayAdapterError} with
 *   credential-free `detail`;
 * - token material never leaves the adapter (mint reports metadata only).
 */
import eBayApi from "ebay-api";
import {
  parseEbayAdapterConfig,
  type EbayAdapterConfigInput,
  type EbayEnvironment,
} from "./config.ts";
import { normalizeEbayError } from "./errors.ts";
import {
  createRateBudget,
  type EbayAdapterLogger,
  type RateBudget,
  type RateBudgetStats,
} from "./rate-budget.ts";

export interface EbayBrowseSearchInput {
  query?: string;
  categoryIds?: string[];
  limit?: number;
  offset?: number;
}

export interface EbayBrowseSearchResult {
  total: number | null;
  /** Raw itemSummaries payloads (provider-shaped, deliberately untyped). */
  itemSummaries: Array<Record<string, unknown>>;
}

/** Token metadata only — the access token string never leaves the adapter. */
export interface EbayApplicationTokenInfo {
  tokenType: string | null;
  expiresInSeconds: number | null;
}

export interface EbayAdapterStats {
  environment: EbayEnvironment;
  marketplaceId: string;
  rateBudget: RateBudgetStats;
}

export interface EbayAdapter {
  readonly environment: EbayEnvironment;
  readonly marketplaceId: string;
  /** Force-mint an application (client-credentials) token; Buy calls also mint lazily. */
  mintApplicationToken(): Promise<EbayApplicationTokenInfo>;
  browseSearch(input: EbayBrowseSearchInput): Promise<EbayBrowseSearchResult>;
  /** Browse getItem — RESTful item id (`v1|...|0`). */
  browseGetItem(itemId: string): Promise<Record<string, unknown>>;
  /** Browse getItemByLegacyId — numeric Trading-era item id. */
  browseGetItemByLegacyId(
    legacyItemId: string,
  ): Promise<Record<string, unknown>>;
  stats(): EbayAdapterStats;
}

/** Conservative default per-connection budget (see rate-budget.ts). */
const DEFAULT_BUDGET = { capacity: 5, refillPerSecond: 1 } as const;

export function createEbayAdapter(config: EbayAdapterConfigInput): EbayAdapter {
  const { logger, rateBudget, ...rest } = config;
  const parsed = parseEbayAdapterConfig(rest);
  const budget: RateBudget =
    rateBudget ?? createRateBudget({ ...DEFAULT_BUDGET, logger });

  const client = new eBayApi({
    appId: parsed.appId,
    certId: parsed.certId,
    devId: parsed.devId,
    ...(parsed.ruName !== undefined ? { ruName: parsed.ruName } : {}),
    sandbox: parsed.environment === "sandbox",
    marketplaceId: parsed.marketplaceId as ConstructorParameters<
      typeof eBayApi
    >[0]["marketplaceId"],
  });

  /** Rate-budget acquisition + error normalization around every call. */
  const call = async <T>(operation: string, fn: () => Promise<T>): Promise<T> => {
    await budget.acquire(1);
    try {
      return await fn();
    } catch (error) {
      const normalized = normalizeEbayError(error);
      logger?.warn?.(
        {
          operation,
          kind: normalized.kind,
          environment: parsed.environment,
        },
        "eBay API call failed",
      );
      throw normalized;
    }
  };

  const asRecord = (value: unknown): Record<string, unknown> => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    throw normalizeEbayError(
      new Error("eBay returned a non-object payload"),
    );
  };

  return {
    environment: parsed.environment,
    marketplaceId: parsed.marketplaceId,

    async mintApplicationToken() {
      return call("oauth2.mintApplicationToken", async () => {
        const token = await client.OAuth2.obtainApplicationAccessToken();
        return {
          tokenType: token.token_type ?? null,
          expiresInSeconds: token.expires_in ?? null,
        };
      });
    },

    async browseSearch(input) {
      return call("buy.browse.search", async () => {
        const response = asRecord(
          await client.buy.browse.search({
            ...(input.query !== undefined ? { q: input.query } : {}),
            ...(input.categoryIds !== undefined && input.categoryIds.length > 0
              ? { category_ids: input.categoryIds.join(",") }
              : {}),
            ...(input.limit !== undefined ? { limit: String(input.limit) } : {}),
            ...(input.offset !== undefined
              ? { offset: String(input.offset) }
              : {}),
          }),
        );
        const summaries = Array.isArray(response["itemSummaries"])
          ? (response["itemSummaries"] as unknown[])
          : [];
        return {
          total: typeof response["total"] === "number" ? response["total"] : null,
          itemSummaries: summaries.map(asRecord),
        };
      });
    },

    async browseGetItem(itemId) {
      return call("buy.browse.getItem", async () =>
        asRecord(await client.buy.browse.getItem(itemId)),
      );
    },

    async browseGetItemByLegacyId(legacyItemId) {
      return call("buy.browse.getItemByLegacyId", async () =>
        asRecord(
          await client.buy.browse.getItemByLegacyId({
            legacy_item_id: legacyItemId,
          }),
        ),
      );
    },

    stats() {
      return {
        environment: parsed.environment,
        marketplaceId: parsed.marketplaceId,
        rateBudget: budget.stats(),
      };
    },
  };
}
