/**
 * Live eBay SANDBOX leg. Skips cleanly when the local keyset file
 * (~/.config/loxep/ebay-sandbox.env) is absent — CI has no credentials.
 *
 * ABSOLUTE RULE honored here: credential values are never printed, logged,
 * asserted-by-value, or embedded in messages. Leak checks are containment
 * comparisons done programmatically against serialized error output.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  EBAY_ERROR_KINDS,
  EbayAdapterError,
  createEbayAdapter,
  createRateBudget,
  fetchItemSnapshot,
  loadSandboxCredentialsFromEnvFile,
  snapshotToObservation,
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
