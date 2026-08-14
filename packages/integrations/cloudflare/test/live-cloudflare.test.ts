/**
 * LIVE leg — a REAL Cloudflare account, READ-ONLY credentials.
 *
 * Skips cleanly when `~/.config/loxep/cloudflare.env` is absent, which is the
 * state today: **the owner has not created a token yet, and every live
 * verification in this milestone is owner-gated.** Nothing in this file runs
 * in CI or on a machine without that file.
 *
 * ABSOLUTE RULES honored here, and how:
 *
 * - **Read-only.** Every call is a GET through `listZones` / `getZone` /
 *   `read`. `apply()` is never called, so no zone, record, or token is created,
 *   changed, or deleted. The token this file expects needs only `Zone:Read`
 *   and `DNS:Read`.
 * - **No credential material anywhere.** The token is never printed, asserted
 *   by value, or interpolated into a message. Leak checks are containment
 *   comparisons run programmatically over serialized output.
 * - **Failure output is scrubbed.** {@link check} runs each assertion group
 *   inside a try/catch and re-throws a message built only from the label, so a
 *   vitest diff can never print a payload.
 * - **Polite volume.** At most four requests, one page each, through a budget
 *   deliberately far below Cloudflare's 1200-per-five-minutes per-USER limit —
 *   which the operator's own dashboard shares.
 *
 * ## What this leg is for
 *
 * Seven facts are marked UNVERIFIED in `errors.ts`, `config.ts`, and
 * `adapter.ts`. This file confirms the ones a read-only token can reach:
 *
 *   1. the bearer scheme and base URL actually work;
 *   2. the zone `status` vocabulary the account really returns;
 *   3. that `ttl: 1` is what an "Auto" record carries;
 *   4. that `proxiable` is present per record;
 *   5. the `result_info` pagination shape on both endpoints.
 *
 * The three it CANNOT confirm without writes or a token-create permission are
 * left unverified on purpose: the DELETE response shape, whether a 200 can
 * carry `success: false`, and whether a token policy PUT replaces or merges.
 */
import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_ZONE_STATUSES,
  createCloudflareAdapter,
  createRateBudget,
  defaultCloudflareEnvFilePath,
  loadCloudflareCredentialsFromEnvFile,
} from "../src/index.ts";
import { liveTestsEnabledFor } from "./live-gate.ts";

const creds = loadCloudflareCredentialsFromEnvFile();
const optedIn = liveTestsEnabledFor("cloudflare");

if (creds === null) {
  // eslint-disable-next-line no-console
  console.info(
    `[live-cloudflare] skipped: no credentials at ${defaultCloudflareEnvFilePath()}`,
  );
} else if (!optedIn) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-cloudflare] skipped: credentials present but not opted in — set " +
      "LOXEP_LIVE_TESTS=cloudflare (or =all) to run against the live instance.",
  );
}

const describeLive = creds === null || !optedIn ? describe.skip : describe;

function makeAdapter() {
  if (creds === null) throw new Error("unreachable: creds checked by skip");
  return createCloudflareAdapter({
    apiToken: creds.apiToken,
    ...(creds.accountId === undefined ? {} : { accountId: creds.accountId }),
    // Deliberately gentle against an account whose budget the operator's own
    // dashboard shares.
    rateBudget: createRateBudget({ capacity: 4, refillPerSecond: 0.5 }),
  });
}

function assertNoCredentialMaterial(text: string): void {
  if (creds === null) return;
  expect(text.includes(creds.apiToken)).toBe(false);
  expect(text.includes(`Bearer ${creds.apiToken}`)).toBe(false);
}

/**
 * Run an assertion group with scrubbed failure output: on failure, only the
 * label escapes, never a diff over provider data.
 */
function check(label: string, assertions: () => void): void {
  try {
    assertions();
  } catch {
    throw new Error(`live assertion failed: ${label}`);
  }
}

describeLive("Cloudflare live account (read-only)", () => {
  it("authenticates with a bearer token and lists zones", async () => {
    const adapter = makeAdapter();
    const zones = await adapter.listZones({ maxPages: 1 });

    check("zones are Loxep facts with an id, a name, and nameservers", () => {
      expect(Array.isArray(zones)).toBe(true);
      for (const zone of zones) {
        expect(zone.externalZoneId.length).toBeGreaterThan(0);
        expect(zone.name.length).toBeGreaterThan(0);
        expect(Array.isArray(zone.nameservers)).toBe(true);
      }
    });

    check("no credential material reaches stats or facts", () => {
      assertNoCredentialMaterial(JSON.stringify(adapter.stats()));
      assertNoCredentialMaterial(JSON.stringify(zones));
    });

    // Reported, not asserted: the documented enum has four members and
    // `deleted`/`deactivated` are not among them. If a real account returns a
    // fifth value, that is a finding for `CLOUDFLARE_ZONE_STATUSES`, not a
    // failure — the column keeps the provider's string verbatim either way.
    const unknown = zones
      .map((zone) => zone.status)
      .filter(
        (status) =>
          !(CLOUDFLARE_ZONE_STATUSES as readonly string[]).includes(status),
      );
    if (unknown.length > 0) {
      // eslint-disable-next-line no-console
      console.info(
        `[live-cloudflare] zone statuses outside the documented enum: ${[...new Set(unknown)].join(", ")}`,
      );
    }
  });

  it("reads one zone's records as Loxep facts with translated TTLs", async () => {
    if (creds === null) return;
    const adapter = makeAdapter();

    const zone =
      creds.testZone === undefined
        ? (await adapter.listZones({ maxPages: 1 }))[0]
        : await adapter.findZoneByName(creds.testZone);
    if (zone === undefined || zone === null) {
      // eslint-disable-next-line no-console
      console.info("[live-cloudflare] no zone available to read; skipping");
      return;
    }

    const records = await adapter.read({
      externalZoneId: zone.externalZoneId,
      zoneName: zone.name,
      maxPages: 1,
    });

    check("every record is a Loxep fact with a relative name", () => {
      for (const record of records) {
        expect(record.externalRecordId.length).toBeGreaterThan(0);
        expect(record.type.length).toBeGreaterThan(0);
        // The zone name never survives into the natural key's `name`.
        expect(record.name === zone.name).toBe(false);
        expect(record.name.endsWith(`.${zone.name}`)).toBe(false);
      }
    });

    check("the provider TTL sentinel never crosses the boundary", () => {
      for (const record of records) {
        expect(record.ttlSeconds === 1).toBe(false);
        if (record.ttlSeconds !== null) {
          expect(record.ttlSeconds).toBeGreaterThanOrEqual(30);
        }
      }
    });

    check("proxied implies proxiable, and only on A/AAAA/CNAME", () => {
      for (const record of records) {
        if (record.proxied) {
          expect(record.proxiable).toBe(true);
          expect(["A", "AAAA", "CNAME"]).toContain(record.type);
        }
      }
    });

    check("no credential material reaches the facts", () => {
      assertNoCredentialMaterial(JSON.stringify(records));
    });
  });

  it("reports capabilities that match what the account actually allows", async () => {
    const capabilities = makeAdapter().capabilities();
    check("capabilities are the honest-degradation contract", () => {
      expect(capabilities.provider).toBe("cloudflare");
      expect(capabilities.proxiableTypes).toEqual(["A", "AAAA", "CNAME"]);
      expect(capabilities.automaticTtl).toBe(true);
    });
    // `proxiedWildcards: true` is documented for all plans as of 2026-08-13.
    // If a real account refuses a proxied wildcard, that default must flip to
    // false rather than remain a toggle that silently does nothing — the
    // design's own instruction. Verifying it requires a WRITE, so it stays an
    // owner-gated manual check rather than an assertion here.
    expect(capabilities.proxiedWildcards).toBe(true);
  });
});
