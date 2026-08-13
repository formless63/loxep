/**
 * Connection probe: "does this keyset work at all?"
 *
 * `GET /openapi-ping` (source-verified, see `adapter.ts`'s module doc) is
 * the cheapest call this adapter has a shape for — it needs only the
 * `x-api-key` header (public auth), does no collection query, and its
 * response (`{"application_id": <int>}`) carries only Loxep's own
 * application id, not shop/listing data.
 *
 * Mirrors `@loxep/integration-invoiceninja/probe.ts`'s contract: `ok: false`
 * is returned — not thrown — when the call fails, carrying the normalized
 * taxonomy `kind`, so an integration-health surface treats a probe as data
 * rather than a stack unwind.
 */
import type { EtsyAdapter } from "./adapter.ts";
import { EtsyAdapterError, normalizeEtsyError, type EtsyErrorKind } from "./errors.ts";

export interface EtsyProbeResult {
  ok: boolean;
  /** Present only when `ok`. */
  applicationId?: number | null;
  /** Present only when `ok` is false. Message is the adapter's sanitized one. */
  error?: { kind: EtsyErrorKind; message: string };
}

export async function probeConnection(adapter: EtsyAdapter): Promise<EtsyProbeResult> {
  try {
    const { applicationId } = await adapter.ping();
    return { ok: true, applicationId };
  } catch (error) {
    const normalized =
      error instanceof EtsyAdapterError
        ? error
        : normalizeEtsyError(error, { operation: "probe.ping", path: "/openapi-ping" });
    return { ok: false, error: { kind: normalized.kind, message: normalized.message } };
  }
}
