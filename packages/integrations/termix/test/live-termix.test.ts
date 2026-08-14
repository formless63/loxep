/**
 * The live leg. **Skips cleanly** unless `~/.config/loxep/termix.env`
 * exists.
 *
 * Its standing job is to replace the UNVERIFIED paragraphs in
 * `src/adapter.ts` with observed fact: `GET /host/db/host` and `GET
 * /status` carry no documented response schema anywhere in Termix's own
 * OpenAPI document, so `name`/`ip` (hosts) and the connectivity/last-seen
 * keys (status entries) are plausible guesses. This test reports what a
 * real instance actually sends.
 *
 * `GET` only, plus the one login exchange (and its `/users/me/token`
 * fallback). It reads; it creates, updates, execs, and deletes nothing —
 * which is not a restraint this test imposes on itself but the entire
 * exported surface of the package.
 */
import { describe, expect, it } from "vitest";
import {
  createTermixAdapter,
  defaultTermixEnvFilePath,
  loadTermixCredentialsFromEnvFile,
} from "../src/index.ts";
import { liveTestsEnabledFor } from "./live-gate.ts";

const credentials = (() => {
  try {
    return loadTermixCredentialsFromEnvFile();
  } catch {
    return null;
  }
})();

const optedIn = liveTestsEnabledFor("termix");
if (credentials !== null && !optedIn) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-termix] skipped: credentials present but not opted in — set " +
      "LOXEP_LIVE_TESTS=termix (or =all) to run against the live instance.",
  );
}

const describeLive = credentials === null || !optedIn ? describe.skip : describe;

describeLive(`live Termix instance (${defaultTermixEnvFilePath()})`, () => {
  const makeAdapter = () =>
    createTermixAdapter({
      config: { baseUrl: credentials!.baseUrl },
      credentials: { username: credentials!.username, password: credentials!.password },
      fetchImpl: (url, init) => fetch(url, init),
    });

  it("authenticates and answers the identity probe", async () => {
    const probe = await makeAdapter().probe();
    expect(probe.reachable).toBe(true);
    expect(probe.authenticated).toBe(true);
  });

  it("reports which host fields the instance actually sends", async () => {
    const hosts = await makeAdapter().listHosts();
    if (hosts.length === 0) {
      // A fresh account with no configured hosts is a legitimate, non-error state.
      expect(hosts).toEqual([]);
      return;
    }
    const first = hosts[0]!;
    // Never fails; this is the observation, printed for the next reader to
    // fold back into `src/adapter.ts`.
    console.log("[live] termix host fields observed:", {
      name: first.name !== null,
      ip: first.ip !== null,
      online: first.online,
      lastSeenAt: first.lastSeenAt !== null,
    });
    expect(first.externalHostId).toBeTruthy();
  });

  it("lists active sessions without error (an empty list is a pass)", async () => {
    await expect(makeAdapter().listSessions()).resolves.toBeInstanceOf(Array);
  });

  it("performs one login for several reads", async () => {
    const adapter = makeAdapter();
    await adapter.listHosts();
    await adapter.listSessions();
    expect(adapter.stats().authExchanges).toBe(1);
  });
});
