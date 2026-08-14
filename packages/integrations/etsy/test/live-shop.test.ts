/**
 * Live Etsy leg. Skips cleanly when the local dev keyset file
 * (~/.config/loxep/etsy-sandbox.env) is absent — CI has no credentials, and
 * NEITHER DOES THIS ENVIRONMENT until the owner completes the OWNER
 * PREREQUISITE this bead names explicitly:
 *
 * 1. Register an Etsy app in the Etsy Developer Portal
 *    (https://www.etsy.com/developers/register) as a Personal App — requires
 *    2FA on the Etsy account first, plus a captcha identity-verification
 *    step.
 * 2. Wait for Etsy's app approval (~24-48h). The API key is inactive until
 *    approved — this blocks ALL calls, including public/observation-only
 *    ones (`ping` included).
 * 3. Record the approved app's keystring + shared secret into
 *    ~/.config/loxep/etsy-sandbox.env as LOXEP_ETSY_KEYSTRING /
 *    LOXEP_ETSY_SHARED_SECRET (see `credentials.ts`'s module doc).
 *
 * UNLIKE eBay, Etsy has NO sandbox at all (confirmed in the binding design's
 * "Owner-action prerequisites", item 6) — "live" here means a real approved
 * app calling real Etsy endpoints read-only (ping + public listing/shop
 * reads), never an isolated test environment. This leg is deliberately
 * read-only and safe to run against a real app the moment credentials exist.
 *
 * ABSOLUTE RULE honored here: credential values are never printed, logged,
 * asserted-by-value, or embedded in messages. Leak checks are containment
 * comparisons done programmatically against serialized error output.
 */
import { describe, expect, it } from "vitest";
import {
  buildConsentState,
  buildConsentUrl,
  createEtsyAdapter,
  createRateBudget,
  generatePkcePair,
  loadDevKeysetFromEnvFile,
  probeConnection,
  verifyConsentState,
} from "../src/index.ts";
import { liveTestsEnabledFor } from "./live-gate.ts";

const creds = loadDevKeysetFromEnvFile();
const optedIn = liveTestsEnabledFor("etsy");

if (creds === null) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-shop] skipped: no Etsy dev keyset at ~/.config/loxep/etsy-sandbox.env " +
      "— owner prerequisite: register + wait for approval of an Etsy Developer " +
      "Portal Personal App (see this file's module doc), then write the keyset " +
      "to that env file. Etsy has no sandbox, so nothing here can run until then.",
  );
} else if (!optedIn) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-shop] skipped: credentials present but not opted in — set " +
      "LOXEP_LIVE_TESTS=etsy (or =all) to run against the live instance.",
  );
}

const describeLive = creds === null || !optedIn ? describe.skip : describe;

function makeAdapter() {
  if (creds === null) throw new Error("unreachable: creds checked by skip");
  return createEtsyAdapter({
    ...creds,
    rateBudget: createRateBudget({ capacity: 10, refillPerSecond: 2 }),
  });
}

function assertNoCredentialMaterial(text: string): void {
  if (creds === null) return;
  expect(text).not.toContain(creds.keystring);
  expect(text).not.toContain(creds.sharedSecret);
}

describeLive("Etsy live leg (real approved app, no sandbox)", () => {
  it("probes the keyset with openapi-ping", async () => {
    const result = await probeConnection(makeAdapter());
    expect(result.ok).toBe(true);
    assertNoCredentialMaterial(JSON.stringify(result));
  });

  it("builds a real PKCE consent URL with no network call", () => {
    if (creds === null) return;
    const { codeChallenge } = generatePkcePair();
    const state = buildConsentState("11111111-1111-1111-1111-111111111111");
    const consent = buildConsentUrl({
      keystring: creds.keystring,
      redirectUri: "http://127.0.0.1:3020/api/integrations/etsy/callback",
      state: state.state,
      scopes: ["shops_r", "listings_r"],
      codeChallenge,
    });
    expect(consent.url).toContain("https://www.etsy.com/oauth/connect");
    expect(verifyConsentState(state.state, state.nonce).connectionId).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
    assertNoCredentialMaterial(consent.url);
  });
});
