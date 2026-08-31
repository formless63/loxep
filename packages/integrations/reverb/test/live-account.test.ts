/**
 * Live Reverb leg. Requires `LOXEP_LIVE_TESTS=reverb` (or `=all`) before it
 * inspects the local dev credentials file. An opted-in run also requires:
 *
 * 1. Sign in to the Reverb account Loxep should observe.
 * 2. Open Settings -> API tokens (or the equivalent path in Reverb's
 *    current account settings) and create a Personal Access Token granting
 *    at minimum the `public` and `read_listings` scopes.
 * 3. Write it to ~/.config/loxep/reverb.env as
 *    LOXEP_REVERB_PERSONAL_ACCESS_TOKEN (see `credentials.ts`'s module
 *    doc).
 *
 * UNLIKE Etsy, there is no approval wait and no sandbox distinction to
 * caveat — "live" here means a real PAT calling real Reverb endpoints
 * read-only (account whoami + listing/my-listings reads). This leg is
 * deliberately read-only and runs only after explicit opt-in.
 *
 * ABSOLUTE RULE honored here: credential values are never printed, logged,
 * asserted-by-value, or embedded in messages. Leak checks are containment
 * comparisons done programmatically against serialized output.
 */
import { describe, expect, it } from "vitest";
import {
  createRateBudget,
  createReverbAdapter,
  loadDevCredentialsFromEnvFile,
  probeConnection,
} from "../src/index.ts";
import { liveTestsEnabledFor } from "./live-gate.ts";

const optedIn = liveTestsEnabledFor("reverb");
const creds = optedIn ? loadDevCredentialsFromEnvFile() : null;

if (!optedIn) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-account] skipped: not opted in — set " +
      "LOXEP_LIVE_TESTS=reverb (or =all) to run against the live instance.",
  );
} else if (creds === null) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-account] skipped: no Reverb dev credentials at " +
      "~/.config/loxep/reverb.env — owner step: mint a Personal Access " +
      "Token in the Reverb account's own settings (public + read_listings " +
      "scopes) and write it to that env file. See this file's module doc.",
  );
}

const describeLive = creds === null || !optedIn ? describe.skip : describe;

function makeAdapter() {
  if (creds === null) throw new Error("unreachable: creds checked by skip");
  return createReverbAdapter({
    ...creds,
    rateBudget: createRateBudget({ capacity: 5, refillPerSecond: 1 }),
  });
}

function assertNoCredentialMaterial(text: string): void {
  if (creds === null) return;
  expect(text).not.toContain(creds.personalAccessToken);
}

describeLive("Reverb live leg (real Personal Access Token)", () => {
  it("probes the token with GET /my/account", async () => {
    const result = await probeConnection(makeAdapter());
    expect(result.ok).toBe(true);
    assertNoCredentialMaterial(JSON.stringify(result));
  });

  it("reads the token owner's own listings", async () => {
    const adapter = makeAdapter();
    const page = await adapter.getMyListings({ state: "all" });
    expect(Array.isArray(page.results)).toBe(true);
    assertNoCredentialMaterial(JSON.stringify(page));
  });
});
