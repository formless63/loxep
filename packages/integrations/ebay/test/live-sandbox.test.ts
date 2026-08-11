/**
 * Live eBay SANDBOX leg. Skips cleanly when the local keyset file
 * (~/.config/loxep/ebay-sandbox.env) is absent — CI has no credentials.
 *
 * TWO tiers of live coverage:
 *
 * - keyset only (`ebay-sandbox.env`): application-token, Browse, snapshot,
 *   and consent-URL construction. Building the consent URL needs no browser
 *   and no network — it proves the RuName/scope/state wiring is real.
 * - user token (`ebay-sandbox-user-token.json`): the Trading watchlist call.
 *   That file is produced by a one-off manual consent (see
 *   `defaultSandboxUserTokenFilePath` in src/credentials.ts) and is absent
 *   until then, so this tier skips cleanly on its own.
 *
 * ABSOLUTE RULE honored here: credential values are never printed, logged,
 * asserted-by-value, or embedded in messages. Leak checks are containment
 * comparisons done programmatically against serialized error output.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  EBAY_BASE_SCOPE,
  EBAY_ERROR_KINDS,
  EbayAdapterError,
  buildConsentState,
  buildConsentUrl,
  createEbayAdapter,
  createRateBudget,
  fetchItemSnapshot,
  fetchWatchlist,
  loadSandboxCredentialsFromEnvFile,
  loadSandboxUserTokenFromFile,
  refreshTokenBundleIfNeeded,
  snapshotToObservation,
  verifyConsentState,
} from "../src/index.ts";

const creds = loadSandboxCredentialsFromEnvFile();

if (creds === null) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-sandbox] skipped: no keyset at ~/.config/loxep/ebay-sandbox.env",
  );
}

const describeLive = creds === null ? describe.skip : describe;

function makeAdapter() {
  if (creds === null) throw new Error("unreachable: creds checked by skip");
  return createEbayAdapter({
    ...creds,
    // Generous budget for the live leg; still exercises the acquire path.
    rateBudget: createRateBudget({ capacity: 10, refillPerSecond: 2 }),
  });
}

function assertNoCredentialMaterial(text: string): void {
  if (creds === null) return;
  expect(text).not.toContain(creds.appId);
  expect(text).not.toContain(creds.certId);
  expect(text).not.toContain(creds.devId);
  if (creds.ruName !== undefined) {
    expect(text).not.toContain(creds.ruName);
  }
}

describeLive("eBay sandbox (live)", () => {
  it("mints an application (client-credentials) token", async () => {
    const adapter = makeAdapter();
    const token = await adapter.mintApplicationToken();
    expect(token.expiresInSeconds).toBeGreaterThan(0);
    expect(token.tokenType).toBe("Application Access Token");
    // Metadata only — the adapter must not expose the token string.
    expect(Object.keys(token).sort()).toEqual([
      "expiresInSeconds",
      "tokenType",
    ]);
    const stats = adapter.stats();
    expect(stats.rateBudget.acquired).toBe(1);
  });

  it("searches sandbox inventory and snapshots an item (or proves not_found taxonomy on a bogus id)", async () => {
    const adapter = makeAdapter();
    const result = await adapter.browseSearch({ query: "iphone", limit: 5 });
    expect(Array.isArray(result.itemSummaries)).toBe(true);

    const firstId = result.itemSummaries
      .map((summary) => summary["itemId"])
      .find((id): id is string => typeof id === "string");

    if (firstId !== undefined) {
      const snapshot = await fetchItemSnapshot(adapter, { itemId: firstId });
      expect(snapshot.externalItemId).toBe(firstId);
      expect(typeof snapshot.marketplace).toBe("string");
      expect(snapshot.listingState).toMatch(/^(active|ended)$/);
      if (snapshot.price !== null) {
        expect(snapshot.price.value).toMatch(/^-?\d+(\.\d+)?$/);
        expect(snapshot.price.currency).toMatch(/^[A-Z]{3}$/);
      }
      // Snapshot feeds the observation mapping end to end.
      const observation = snapshotToObservation(snapshot, {
        observationBatchId: "3b241101-e2bb-4255-8caf-4136c566a962",
        observedAt: new Date(),
        source: "ebay:live-test",
      });
      expect(observation.observation.rawStateHash).toMatch(/^[0-9a-f]{64}$/);
    } else {
      // Sparse sandbox inventory: prove the getItem call path + taxonomy
      // with an id that cannot exist.
      const error = await fetchItemSnapshot(adapter, {
        itemId: "v1|000000000000|0",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EbayAdapterError);
      const kind = (error as EbayAdapterError).kind;
      expect(["not_found", "invalid_request"]).toContain(kind);
    }

    // Every live call above went through the rate budget.
    expect(adapter.stats().rateBudget.acquired).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("never leaks credential material into normalized errors", async () => {
    if (creds === null) throw new Error("unreachable");
    // Deliberately wrong cert (fully fake — NOT derived by printing the real
    // one) forces an auth-ish failure against the real token endpoint.
    const adapter = createEbayAdapter({
      ...creds,
      certId: "SBX-00000000000-completely-wrong-cert-0000",
    });
    const error = await adapter.mintApplicationToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EbayAdapterError);
    const adapterError = error as EbayAdapterError;
    expect(["auth", "invalid_request"]).toContain(adapterError.kind);
    expect(EBAY_ERROR_KINDS).toContain(adapterError.kind);
    const serialized =
      JSON.stringify({
        message: adapterError.message,
        kind: adapterError.kind,
        detail: adapterError.detail,
      }) + inspect(adapterError, { depth: 12 });
    assertNoCredentialMaterial(serialized);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Consent URL against the real sandbox keyset — no browser, no network.
// ---------------------------------------------------------------------------

const describeConsent =
  creds === null || creds.ruName === undefined ? describe.skip : describe;

if (creds !== null && creds.ruName === undefined) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-sandbox] consent URL skipped: keyset file has no LOXEP_EBAY_RU_NAME",
  );
}

describeConsent("eBay sandbox consent URL (live config)", () => {
  it("builds a sandbox authorize URL bound to the real RuName and a fresh state", () => {
    const adapter = makeAdapter();
    const connectionId = "3b241101-e2bb-4255-8caf-4136c566a962";
    const state = buildConsentState(connectionId);
    const consent = buildConsentUrl(adapter, { state: state.state });
    const url = new URL(consent.url);

    expect(url.origin + url.pathname).toBe(
      "https://auth.sandbox.ebay.com/oauth2/authorize",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(EBAY_BASE_SCOPE);
    expect(url.searchParams.get("state")).toBe(state.state);
    // The keyset's real appId/ruName ARE in this URL by construction (eBay
    // requires them); assert their presence structurally, never by value.
    expect(url.searchParams.get("client_id")).toHaveLength(creds!.appId.length);
    expect(url.searchParams.get("redirect_uri")).toHaveLength(
      creds!.ruName!.length,
    );
    // The nonce must NOT be in the URL — only its hash, inside `state`.
    expect(consent.url).not.toContain(state.nonce);
    expect(verifyConsentState(state.state, state.nonce).connectionId).toBe(
      connectionId,
    );
    // Pure construction: no provider call, no rate-budget spend.
    expect(adapter.stats().rateBudget.acquired).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Trading watchlist — needs a user token from a completed manual consent.
// ---------------------------------------------------------------------------

const userBundle = creds === null ? null : loadSandboxUserTokenFromFile();

if (creds !== null && userBundle === null) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-sandbox] watchlist skipped: no user token at " +
      "~/.config/loxep/ebay-sandbox-user-token.json (run the manual consent first)",
  );
}

const describeWatchlist =
  creds === null || userBundle === null ? describe.skip : describe;

describeWatchlist("eBay sandbox watchlist (live, user token)", () => {
  it("refreshes the token when needed and reads the watch list", async () => {
    if (userBundle === null) throw new Error("unreachable");
    const adapter = makeAdapter();

    // Refresh first: a dev artifact captured hours ago has a dead access
    // token, and this exercises the real refresh_token grant.
    const { bundle, refreshed } = await refreshTokenBundleIfNeeded({
      bundle: userBundle,
      adapter,
    });
    expect(typeof refreshed).toBe("boolean");
    expect(Date.parse(bundle.accessTokenExpiresAt)).toBeGreaterThan(Date.now());

    const userAdapter = adapter.withUserToken(bundle);
    const page = await fetchWatchlist(userAdapter, { entriesPerPage: 25 });

    // A sandbox test user's watch list is legitimately empty until items are
    // watched there — shape is what this asserts, not content.
    expect(page.page).toBe(1);
    expect(Array.isArray(page.entries)).toBe(true);
    for (const entry of page.entries) {
      expect(entry.externalItemId).toMatch(/^\d+$/);
      expect(entry.raw).toBeTypeOf("object");
    }
    if (page.totalEntries !== null) {
      expect(page.totalEntries).toBeGreaterThanOrEqual(0);
    }
  }, 90_000);

  it("never leaks token material into a normalized Trading error", async () => {
    if (userBundle === null) throw new Error("unreachable");
    const adapter = makeAdapter();
    const userAdapter = adapter.withUserToken({
      ...userBundle,
      accessToken: "v^1.1#i^1#COMPLETELY-FAKE-EXPIRED-TOKEN",
      refreshToken: "v^1.1#i^1#COMPLETELY-FAKE-REFRESH",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const error = await fetchWatchlist(userAdapter).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EbayAdapterError);
    expect(EBAY_ERROR_KINDS).toContain((error as EbayAdapterError).kind);
    const serialized = inspect(error, { depth: 12 });
    assertNoCredentialMaterial(serialized);
    expect(serialized).not.toContain(userBundle.accessToken);
    expect(serialized).not.toContain(userBundle.refreshToken);
  }, 90_000);
});
