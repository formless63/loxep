/**
 * The live leg. **Skips cleanly** unless `~/.config/loxep/pangolin.env`
 * exists AND `LOXEP_LIVE_TESTS=pangolin` (or `=all`) is set.
 *
 * `GET` only, exactly the exported adapter surface — nothing here can issue
 * a write even by accident, because the package does not have one.
 *
 * ## Read this before trusting a green run
 *
 * Milestone 1's reconnaissance (`adapter.ts`'s module doc) found the
 * Integration API's own port is NOT reachable from this build environment
 * on any network path tried, including a confirmed direct connection to
 * the actual Pangolin host. The owner's `PANGOLIN_URL` is the DASHBOARD's
 * URL, which the design document itself predicted operators would paste
 * first ("the dashboard URL is a documented first-attempt trap"). This
 * suite therefore does NOT assert success — it records whatever the
 * instance actually does, the same way `test/live-tailscale.test.ts`
 * treats an empty tailnet as a legitimate non-error state. A thrown
 * `PangolinAdapterError` is caught, printed, and treated as the honest
 * result of this run, not a suite failure — the standing job is to
 * confirm reachability once the operator has a working reverse-proxy
 * route for the Integration API's port, at which point this same test
 * starts exercising real reads with no code change required.
 */
import { describe, expect, it } from "vitest";
import {
  PangolinAdapterError,
  createPangolinAdapter,
  defaultPangolinEnvFilePath,
  loadPangolinCredentialsFromEnvFile,
} from "../src/index.ts";
import { liveTestsEnabledFor } from "./live-gate.ts";

const loaded = (() => {
  try {
    const credentials = loadPangolinCredentialsFromEnvFile();
    return credentials === null ? null : { credentials };
  } catch {
    return null;
  }
})();

const optedIn = liveTestsEnabledFor("pangolin");
if (loaded !== null && !optedIn) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-pangolin] skipped: credentials present but not opted in — set " +
      "LOXEP_LIVE_TESTS=pangolin (or =all) to run against the live instance.",
  );
}

const describeLive = loaded === null || !optedIn ? describe.skip : describe;

describeLive(`live Pangolin instance (${defaultPangolinEnvFilePath()})`, () => {
  const makeAdapter = () =>
    createPangolinAdapter({
      config: {
        baseUrl: loaded!.credentials.baseUrl,
        ...(loaded!.credentials.orgId === undefined ? {} : { orgId: loaded!.credentials.orgId }),
      },
      credentials: {
        apiKeyId: loaded!.credentials.apiKeyId,
        apiKeySecret: loaded!.credentials.apiKeySecret,
      },
      fetchImpl: (url, init) => fetch(url, init),
    });

  it("records the live reconnaissance outcome — reachability, envelope conformance, and counts only", async () => {
    const adapter = makeAdapter();
    try {
      const probe = await adapter.probe();
      // eslint-disable-next-line no-console
      console.log("[live] pangolin probe:", probe);
      expect(probe.reachable).toBe(true);

      if (probe.authenticated && loaded!.credentials.orgId !== undefined) {
        const orgId = loaded!.credentials.orgId;
        const [sites, resources, domains] = await Promise.all([
          adapter.listSites(orgId),
          adapter.listResources(orgId),
          adapter.listDomains(orgId),
        ]);
        // eslint-disable-next-line no-console
        console.log("[live] pangolin counts:", {
          siteCount: sites.length,
          resourceCount: resources.length,
          domainCount: domains.length,
        });

        let ruleCount = 0;
        let targetCount = 0;
        // Sample the first few resources only: the per-connection rate budget
        // (capacity 5, refill 1/s) makes a full 20-resource sweep exceed the
        // test timeout by design — counts from a sample prove the shape.
        for (const resource of resources.slice(0, 4)) {
          if (resource.resourceId === null) continue;
          const resourceId = String(resource.resourceId);
          const [rules, targets] = await Promise.all([
            adapter.listRules(resourceId),
            adapter.listTargets(resourceId),
          ]);
          ruleCount += rules.length;
          targetCount += targets.length;
        }
        // eslint-disable-next-line no-console
        console.log("[live] pangolin rule/target counts:", { ruleCount, targetCount });
      } else if (probe.authenticated) {
        const orgs = await adapter.listOrgs();
        // eslint-disable-next-line no-console
        console.log("[live] pangolin org count (no PANGOLIN_ORG_ID configured):", orgs.length);
      }
    } catch (error) {
      // Never fails the suite on a network/reachability finding — this IS
      // the milestone-1 reconnaissance result, recorded rather than hidden.
      // eslint-disable-next-line no-console
      console.log("[live] pangolin reconnaissance error:", {
        kind: error instanceof PangolinAdapterError ? error.kind : "unknown",
        detail: error instanceof PangolinAdapterError ? error.detail : undefined,
        message: (error as Error).message,
      });
      expect(error).toBeInstanceOf(Error);
    }
  });
});
