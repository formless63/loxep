/**
 * The live leg. Requires `LOXEP_LIVE_TESTS=termix` (or `=all`) before it
 * inspects `~/.config/loxep/termix.env`; without opt-in it skips cleanly.
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

const optedIn = liveTestsEnabledFor("termix");
const credentials = optedIn
  ? (() => {
      try {
        return loadTermixCredentialsFromEnvFile();
      } catch {
        return null;
      }
    })()
  : null;

if (!optedIn) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-termix] skipped: not opted in — set " +
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

  it("lists active sessions without error, and reports which fields arrived across ALL rows", async () => {
    const sessions = await makeAdapter().listSessions();
    expect(Array.isArray(sessions)).toBe(true);
    if (sessions.length === 0) {
      // An account with no open tabs right now is a legitimate, non-error
      // state — the same posture the host-fields test above takes.
      return;
    }
    // Counts alone do NOT verify field names — `sessionSchema.safeParse`
    // parses defensively, so a field this package guessed wrong degrades to
    // `null`/a default and the read still "succeeds" with the right row
    // count. Report presence per field, across ALL rows rather than the
    // first one (dockhand's `live-dockhand.test.ts` pattern) — a single
    // session legitimately missing an optional value (its own `hostName`,
    // say) must not read as a wrong field name. This is the standing job
    // loxep-4ah's live leg exists to discharge before per-session rows ship.
    const presence = (get: (session: (typeof sessions)[number]) => unknown) =>
      sessions.some((session) => get(session) !== null);
    console.log("[live] termix session fields observed:", {
      rows: sessions.length,
      sessionId: presence((s) => s.sessionId),
      hostId: presence((s) => s.hostId),
      hostName: presence((s) => s.hostName),
      isConnected: sessions.some((s) => s.isConnected === true)
        ? true
        : sessions.some((s) => s.isConnected === false)
          ? false
          : null,
      createdAt: presence((s) => s.createdAt),
      isOwnSession: sessions.some((s) => s.isOwnSession === true)
        ? true
        : sessions.some((s) => s.isOwnSession === false)
          ? false
          : null,
      sharedByUsername: presence((s) => s.sharedByUsername),
      permissionLevel: presence((s) => s.permissionLevel),
    });
    expect(sessions.every((s) => typeof s.sessionId === "string" && s.sessionId !== "")).toBe(
      true,
    );
  });

  it("performs one login for several reads", async () => {
    const adapter = makeAdapter();
    await adapter.listHosts();
    await adapter.listSessions();
    expect(adapter.stats().authExchanges).toBe(1);
  });
});
