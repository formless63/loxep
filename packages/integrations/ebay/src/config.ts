/**
 * Typed adapter configuration (zod at the boundary). The environment is
 * strictly explicit — there is no default, and nothing here reads
 * process.env (runtime credentials come from the connection model per
 * ADR-0009/ADR-0016; the env-file helper in credentials.ts is dev/test
 * only).
 */
import { z } from "zod";
import { EbayAdapterError } from "./errors.ts";
import type { EbayAdapterLogger, RateBudget } from "./rate-budget.ts";

export const EBAY_ENVIRONMENTS = ["sandbox", "production"] as const;
export type EbayEnvironment = (typeof EBAY_ENVIRONMENTS)[number];

export const ebayAdapterConfigSchema = z.strictObject({
  appId: z.string().min(1),
  certId: z.string().min(1),
  devId: z.string().min(1),
  ruName: z.string().min(1).optional(),
  /** Explicit, never defaulted: pointing at production must be deliberate. */
  environment: z.enum(EBAY_ENVIRONMENTS),
  /** REST marketplace context header; Loxep's initial vertical is EBAY_US. */
  marketplaceId: z.string().regex(/^EBAY_[A-Z_]+$/).default("EBAY_US"),
});

export type EbayAdapterConfig = z.output<typeof ebayAdapterConfigSchema>;

export type EbayAdapterConfigInput = z.input<typeof ebayAdapterConfigSchema> & {
  logger?: EbayAdapterLogger;
  /**
   * Per-connection token bucket every API call acquires from. When omitted
   * the adapter creates a conservative private default (capacity 5,
   * refill 1/s); pass a shared budget to pool several adapters onto one
   * connection's budget.
   */
  rateBudget?: RateBudget;
};

/**
 * Parse and validate adapter config. Zod issues are reported as
 * `invalid_request` with paths and codes only — never received values,
 * which may be credential material.
 */
export function parseEbayAdapterConfig(
  input: Omit<EbayAdapterConfigInput, "logger" | "rateBudget">,
): EbayAdapterConfig {
  const result = ebayAdapterConfigSchema.safeParse(input);
  if (!result.success) {
    throw new EbayAdapterError(
      "invalid_request",
      "invalid eBay adapter configuration",
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
    );
  }
  return result.data;
}
