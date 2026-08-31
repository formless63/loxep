/**
 * Connection probe: "can this API token read this Invoice Ninja instance?"
 *
 * `GET /api/v1/ping` is the cheapest authenticated call this adapter has a
 * documented shape for (`App\Http\Controllers\PingController::index()`,
 * `invoiceninja/invoiceninja`, `v5-stable` branch, fetched 2026-08-13:
 * https://github.com/invoiceninja/invoiceninja/blob/v5-stable/app/Http/Controllers/PingController.php):
 * it does no collection query, and its response —
 * `{"company_name": "...", "user_name": "..."}` — carries only the
 * authenticated user's own company/display name, which this probe does not
 * even read (to avoid putting operator-identifying text where a health
 * surface might display it). `ping` and `health_check` sit in the SAME
 * `token_auth`-guarded route group as every resource endpoint (source-
 * verified: `routes/api.php`, same branch/fetch — both routes are declared
 * inside the `token_auth` middleware group, not exempted from it), and this
 * was LIVE-CONFIRMED: an unauthenticated `GET /api/v1/ping` returned the
 * same `403 {"message":"Invalid token"}` as other API endpoints — so there
 * is no unauthenticated "is the server up" shortcut to prefer instead.
 *
 * ONE strategy, matching the Medusa probe's reasoning: nothing found in the
 * source reviewed here suggests an Invoice Ninja company token can be scoped
 * narrower than the user that issued it, so there is no graceful-degradation
 * fallback to build.
 *
 * `ok: false` is returned — not thrown — when the call fails, carrying the
 * normalized taxonomy `kind`, matching `MedusaProbeResult`'s/`WooProbeResult`'s
 * contract: a probe is a diagnostic, and an integration health surface wants
 * "auth" or "provider_unavailable" as data, not as a stack unwind.
 */
import type { InvoiceNinjaAdapter } from "./adapter.ts";
import {
  InvoiceNinjaAdapterError,
  normalizeInvoiceNinjaError,
  type InvoiceNinjaErrorKind,
} from "./errors.ts";

export interface InvoiceNinjaProbeResult {
  ok: boolean;
  /** Instance root the probe used. */
  baseUrl: string;
  /** Present only when `ok` is false. Message is the adapter's sanitized one. */
  error?: { kind: InvoiceNinjaErrorKind; message: string };
}

export async function probeConnection(
  adapter: InvoiceNinjaAdapter,
): Promise<InvoiceNinjaProbeResult> {
  const base = { baseUrl: adapter.baseUrl };

  try {
    // The response body (company/user display name) is deliberately never
    // read — reachability and auth are the only facts this probe reports.
    await adapter.get("/ping", undefined, { operation: "probe.ping" });
    return { ok: true, ...base };
  } catch (error) {
    const normalized =
      error instanceof InvoiceNinjaAdapterError
        ? error
        : normalizeInvoiceNinjaError(error, {
            operation: "probe.ping",
            path: "/api/v1/ping",
          });
    return {
      ok: false,
      ...base,
      error: { kind: normalized.kind, message: normalized.message },
    };
  }
}
