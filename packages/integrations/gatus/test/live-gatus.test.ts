/**
 * The live leg. Requires `LOXEP_LIVE_TESTS=gatus` (or `=all`) before it
 * inspects `~/.config/loxep/gatus.env`; without opt-in it skips cleanly.
 *
 * Its standing job is to observe a real Gatus instance's auth-mode branch in
 * practice — `probeConfig()`'s `{oidc, authenticated}` shape and the bulk
 * `/api/v1/endpoints/statuses` read are verified here against Go SOURCE, not
 * a live instance (gatus.io/docs renders client-side and is unusable), so
 * this file is what upgrades "verified against source" to "observed fact"
 * for whichever auth mode the configured instance actually runs.
 *
 * ## What it is allowed to do
 *
 * `GET` only — the entire exported surface of this package. It reads; it
 * creates, updates, and deletes nothing, which is not a restraint this file
 * imposes on itself but the whole package's exported surface.
 *
 * ## An instance with no endpoints, or an OIDC-secured one, is a PASS
 *
 * A freshly stood-up Gatus with zero declared endpoints legitimately reports
 * an empty `endpoints/statuses` array, and an OIDC-secured instance
 * legitimately refuses `listEndpointStatuses()` with `kind: "auth"` — see
 * `src/adapter.ts`'s module doc for why that refusal is correct behavior,
 * not a bug to chase. Neither is failed here.
 *
 * Nothing here prints a credential. What is logged is response SHAPE and
 * mode, never a stored username, password, or Authorization header value.
 */
import { describe, expect, it } from "vitest";
import {
  createGatusAdapter,
  defaultGatusEnvFilePath,
  loadGatusCredentialsFromEnvFile,
} from "../src/index.ts";
import { liveTestsEnabledFor } from "./live-gate.ts";

const optedIn = liveTestsEnabledFor("gatus");
const credentials = optedIn
  ? (() => {
      try {
        return loadGatusCredentialsFromEnvFile();
      } catch {
        return null;
      }
    })()
  : null;

if (!optedIn) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-gatus] skipped: not opted in — set " +
      "LOXEP_LIVE_TESTS=gatus (or =all) to run against the live instance.",
  );
}

const describeLive = credentials === null || !optedIn ? describe.skip : describe;

describeLive(`live Gatus instance (${defaultGatusEnvFilePath()})`, () => {
  const makeAdapter = () =>
    createGatusAdapter({
      config: { baseUrl: credentials!.baseUrl },
      ...(credentials!.username !== undefined && credentials!.password !== undefined
        ? {
            credentials: {
              username: credentials!.username,
              password: credentials!.password,
            },
          }
        : {}),
      fetchImpl: (url, init) => fetch(url, init),
    });

  it("answers the unauthenticated health probe", async () => {
    const health = await makeAdapter().health();
    expect(health.reachable).toBe(true);
  });

  it("answers the unauthenticated config probe with the documented shape", async () => {
    const probe = await makeAdapter().probeConfig();
    expect(typeof probe.oidc).toBe("boolean");
    expect(typeof probe.authenticated).toBe("boolean");
    console.log("[live] gatus auth mode observed:", probe.mode);
  });

  it("reads endpoint statuses when direct, or refuses cleanly when oidc_degraded", async () => {
    const adapter = makeAdapter();
    const probe = await adapter.probeConfig();
    if (probe.mode === "oidc_degraded") {
      await expect(adapter.listEndpointStatuses()).rejects.toMatchObject({
        kind: "auth",
      });
      return;
    }
    const statuses = await adapter.listEndpointStatuses();
    expect(Array.isArray(statuses)).toBe(true);
    if (statuses.length > 0) {
      console.log("[live] gatus endpoint status fields observed:", {
        name: statuses[0]!.name !== null,
        group: statuses[0]!.group !== null,
        success: statuses[0]!.success !== null,
        observedAt: statuses[0]!.observedAt !== null,
      });
    }
  });

  it("performs exactly one probe per capabilities() call", async () => {
    const adapter = makeAdapter();
    await adapter.capabilities();
    expect(adapter.stats().configProbes).toBe(1);
  });
});
