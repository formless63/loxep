/**
 * LIVE leg — would exercise a REAL Medusa v2 backend with a
 * read-only-intended secret API key, mirroring the shape of
 * `packages/integrations/woo/test/live-store.test.ts`.
 *
 * NO LIVE MEDUSA INSTANCE EXISTS IN THIS ENVIRONMENT. Unlike the
 * WooCommerce adapter's live leg, which runs against a real production
 * store when credentials are present, this suite has nothing to point at
 * even in principle here: ~/.config/loxep/medusa.env is not expected to
 * exist, `loadMedusaCredentialsFromEnvFile()` returns `null`, and every test
 * below skips cleanly. This is the fixtures-only gap the task explicitly
 * asked to mark — see the "Live-verify Medusa adapter against a real
 * instance" follow-up bead (parent loxep-xh9.4).
 *
 * If a real Medusa v2 backend and a secret API key ever become available in
 * this environment, populate ~/.config/loxep/medusa.env with:
 *
 *   MEDUSA_URL=https://your-backend.example.com   (required, https)
 *   MEDUSA_RO_API_TOKEN=sk_...                     (required; MEDUSA_API_TOKEN accepted)
 *
 * and this suite will start exercising `probeConnection`, `fetchOrdersPage`,
 * pagination, `fetchProducts`, and the bogus-credential auth-taxonomy check
 * against it — the same shape as the WooCommerce adapter's live leg, with
 * the same PII-scrubbing discipline (`check()`, `assertNoCredentialMaterial`,
 * structural-only assertions).
 */
import { describe, it } from "vitest";
import { loadMedusaCredentialsFromEnvFile } from "../src/index.ts";

const creds = loadMedusaCredentialsFromEnvFile();

if (creds === null) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-store] skipped: no credentials at ~/.config/loxep/medusa.env " +
      "(expected in this environment — no live Medusa instance exists here; " +
      "see the 'Live-verify Medusa adapter against a real instance' follow-up bead)",
  );
}

const describeLive = creds === null ? describe.skip : describe;

describeLive("Medusa v2 backend (live, read-only) — NOT REACHABLE HERE", () => {
  it("is a placeholder pending a real Medusa v2 backend", () => {
    // Intentionally empty: this block only runs when credentials are
    // present, which — in this environment — they never are. A future
    // agent with real credentials should replace this with the same shape
    // as woo/test/live-store.test.ts: probeConnection, fetchOrdersPage,
    // pagination consistency, fetchProducts, and the bogus-credential
    // auth-taxonomy check, all through the scrubbed `check()` helper.
  });
});
