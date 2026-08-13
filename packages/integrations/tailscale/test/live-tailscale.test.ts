/**
 * The live leg. **Skips cleanly** unless `~/.config/loxep/tailscale.env`
 * exists.
 *
 * Its standing job is to confirm the `Device` field names this package reads
 * (`hostname`, `name`, `addresses`, `lastSeen`, `connectedToControl`, `os`)
 * against a real tailnet — they are read from Tailscale's own published Go
 * client rather than an UNVERIFIED guess, but this is still the only way to
 * confirm the interactive-docs-only https://tailscale.com/api surface this
 * environment could not fetch as text.
 *
 * `GET` only, plus the OAuth token exchange when the env file configures an
 * OAuth client. Nothing here authorizes, removes, or tags a device — which
 * is not a restraint this test imposes on itself but the entire exported
 * surface of the package.
 */
import { describe, expect, it } from "vitest";
import {
  createTailscaleAdapter,
  defaultTailscaleEnvFilePath,
  loadTailscaleCredentialsFromEnvFile,
} from "../src/index.ts";

const loaded = (() => {
  try {
    const credentials = loadTailscaleCredentialsFromEnvFile();
    return credentials === null ? null : { credentials };
  } catch {
    return null;
  }
})();

const describeLive = loaded === null ? describe.skip : describe;

describeLive(`live Tailscale tailnet (${defaultTailscaleEnvFilePath()})`, () => {
  const makeAdapter = () =>
    createTailscaleAdapter({
      config: {},
      credentials: loaded!.credentials,
      fetchImpl: (url, init) => fetch(url, init),
    });

  it("authenticates and answers the reachability probe", async () => {
    const probe = await makeAdapter().probe();
    expect(probe.reachable).toBe(true);
    expect(probe.authenticated).toBe(true);
  });

  it("reports which device fields the tailnet actually sends", async () => {
    const devices = await makeAdapter().listDevices();
    if (devices.length === 0) {
      // A fresh or empty tailnet is a legitimate, non-error state.
      expect(devices).toEqual([]);
      return;
    }
    const first = devices[0]!;
    // Never fails; this is the observation, printed for the next reader to
    // fold back into `src/adapter.ts`.
    console.log("[live] tailscale device fields observed:", {
      name: first.name !== null,
      hostname: first.hostname !== null,
      addressCount: first.addresses.length,
      online: first.online,
      lastSeen: first.lastSeen !== null,
      os: first.os !== null,
    });
    expect(first.externalDeviceId).toBeTruthy();
  });
});
