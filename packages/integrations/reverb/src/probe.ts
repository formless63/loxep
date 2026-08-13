/**
 * Connection probe: "does this token work at all?"
 *
 * `GET /my/account` (source-verified, see `adapter.ts`'s module doc) is the
 * cheapest authenticated call this adapter has a shape for — it needs only
 * `public`-tier PAT access, does no collection query, and its response
 * carries only the token owner's own account facts, not shop/listing data.
 *
 * Mirrors `@loxep/integration-etsy/probe.ts`'s contract: `ok: false` is
 * returned — not thrown — when the call fails, carrying the normalized
 * taxonomy `kind`, so an integration-health surface treats a probe as data
 * rather than a stack unwind.
 */
import type { ReverbAdapter } from "./adapter.ts";
import { ReverbAdapterError, normalizeReverbError, type ReverbErrorKind } from "./errors.ts";

export interface ReverbProbeResult {
  ok: boolean;
  /** Present only when `ok` is false. Message is the adapter's sanitized one. */
  error?: { kind: ReverbErrorKind; message: string };
}

export async function probeConnection(adapter: ReverbAdapter): Promise<ReverbProbeResult> {
  try {
    await adapter.getAccount();
    return { ok: true };
  } catch (error) {
    const normalized =
      error instanceof ReverbAdapterError
        ? error
        : normalizeReverbError(error, { operation: "probe.account", path: "/my/account" });
    return { ok: false, error: { kind: normalized.kind, message: normalized.message } };
  }
}
