/**
 * The live leg. **Skips cleanly** unless `~/.config/loxep/beszel.env` exists.
 *
 * Its standing job is to replace the UNVERIFIED paragraph in
 * `src/adapter.ts` with observed fact: Beszel publishes no schema for the
 * `systems` collection, so `name`, `host`, `port`, and `updated` are inferred
 * names. This test reports which of them a real hub actually sends.
 *
 * ## What it is allowed to do
 *
 * `GET` only, plus the one login exchange. It reads; it creates nothing,
 * updates nothing, and deletes nothing — which is not a restraint this test
 * imposes on itself but the entire exported surface of the package.
 *
 * ## Zero systems is a PASS
 *
 * The credential this file expects is a **readonly** Beszel user, and upstream
 * documents that such a user *"can view any system shared with them by an admin"*
 * (https://beszel.dev/guide/user-accounts). A fresh readonly account therefore
 * legitimately sees nothing. Failing on an empty list would push the next
 * person toward sharing the whole fleet with Loxep to make a test go green,
 * which is exactly backwards.
 *
 * Nothing here prints a credential. The reported facts are field NAMES and
 * counts, never values from a credential file.
 */
import { describe, expect, it } from "vitest";
import {
  createBeszelAdapter,
  defaultBeszelEnvFilePath,
  loadBeszelCredentialsFromEnvFile,
} from "../src/index.ts";

const credentials = (() => {
  try {
    return loadBeszelCredentialsFromEnvFile();
  } catch {
    return null;
  }
})();

const describeLive = credentials === null ? describe.skip : describe;

describeLive(`live Beszel hub (${defaultBeszelEnvFilePath()})`, () => {
  const makeAdapter = () =>
    createBeszelAdapter({
      config: { baseUrl: credentials!.baseUrl },
      credentials: {
        email: credentials!.email,
        password: credentials!.password,
      },
      fetchImpl: (url, init) => fetch(url, init),
    });

  it("answers the unauthenticated health probe", async () => {
    const health = await makeAdapter().health();
    expect(health.reachable).toBe(true);
  });

  it("authenticates as an ordinary user, not a superuser", async () => {
    // If this throws `auth`, the account in the env file is a PocketBase
    // superuser rather than a `users` row — which is the credential this
    // integration deliberately does not want.
    await expect(makeAdapter().listSystems()).resolves.toBeInstanceOf(Array);
  });

  it("reports which system fields the hub actually sends", async () => {
    const systems = await makeAdapter().listSystems();
    if (systems.length === 0) {
      // Documented as a pass — see the module doc.
      expect(systems).toEqual([]);
      return;
    }
    const first = systems[0]!;
    // Never fails; this is the observation, printed for the next reader to
    // fold back into `src/adapter.ts`.
    console.log("[live] beszel system fields observed:", {
      name: first.name !== null,
      host: first.host !== null,
      port: first.port !== null,
      status: first.status !== "",
      observedAt: first.observedAt !== null,
    });
    // `id` is the one field PocketBase guarantees, so it is the one assertion.
    expect(first.externalSystemId).toBeTruthy();
  });

  it("performs one login for several reads", async () => {
    const adapter = makeAdapter();
    await adapter.listSystems();
    await adapter.listSystems();
    expect(adapter.stats().authExchanges).toBe(1);
  });
});
