/**
 * The live leg. **Skips cleanly** unless `~/.config/loxep/dockhand.env` exists.
 *
 * Its standing job is to replace the UNVERIFIED note in `src/adapter.ts` with
 * observed fact. Dockhand publishes no OpenAPI document — the
 * fleet-observability design records the open, unanswered request for one — so
 * every field name in this package is transcribed from a rendered
 * documentation site and none has been seen on a wire.
 *
 * ## What it is allowed to do
 *
 * **Reads only, and no host writes.** The adapter can create and update a
 * managed host, and this test deliberately does not, because a live test that
 * registered a host would be writing into the operator's real Dockhand
 * inventory to prove a point. The `applyHost` path is covered by the stub
 * suite; confirming it against a live instance is a deliberate manual step, not
 * something a `bun test` run should do on its own.
 *
 * ## What it is watching for
 *
 * 1. **Which list envelope this instance actually sends.** The documentation
 *    contradicts itself — the overview says list endpoints *"return arrays
 *    directly without wrapping"*, the containers page documents a wrapping
 *    `containers` field. The adapter accepts both; this test reports which one
 *    is real.
 * 2. **Whether TLS material comes back at all.** If a live environment record
 *    returns `tlsKey`, the presence-bit design is load-bearing rather than
 *    precautionary, and that is worth knowing.
 *
 * Nothing here prints a credential. The reported facts are field names, shapes,
 * and counts.
 */
import { describe, expect, it } from "vitest";
import {
  createDockhandAdapter,
  defaultDockhandEnvFilePath,
  loadDockhandCredentialsFromEnvFile,
} from "../src/index.ts";

const credentials = (() => {
  try {
    return loadDockhandCredentialsFromEnvFile();
  } catch {
    return null;
  }
})();

const describeLive = credentials === null ? describe.skip : describe;

describeLive(`live Dockhand instance (${defaultDockhandEnvFilePath()})`, () => {
  const makeAdapter = () =>
    createDockhandAdapter({
      config: { baseUrl: credentials!.baseUrl },
      credentials: {
        username: credentials!.username,
        password: credentials!.password,
      },
      fetchImpl: (url, init) => fetch(url, init),
    });

  it("reports which authentication mode the instance is in", async () => {
    const session = await makeAdapter().probeSession();
    console.log("[live] dockhand session:", session);
    expect(typeof session.authenticationEnabled).toBe("boolean");
  });

  it("lists managed hosts and reports which fields arrived", async () => {
    const hosts = await makeAdapter().listHosts();
    expect(Array.isArray(hosts)).toBe(true);
    if (hosts.length === 0) return;
    const first = hosts[0]!;
    console.log("[live] dockhand environment fields observed:", {
      connectionType: first.connectionType,
      host: first.host !== null,
      port: first.port !== null,
      protocol: first.protocol !== null,
      socketPath: first.socketPath !== null,
      // If this is true, upstream returns PEM material on a read.
      tlsConfigured: first.tlsConfigured,
      hawserConfigured: first.hawserConfigured,
      updatedAt: first.updatedAt !== null,
    });
    expect(first.externalHostId).toBeTruthy();
    expect(first.name).toBeTruthy();
  });

  it("lists containers and stacks for the configured environment", async () => {
    const envId = credentials!.testEnvironmentId;
    if (envId === undefined) {
      console.log(
        "[live] set DOCKHAND_TEST_ENVIRONMENT_ID to exercise the per-host reads",
      );
      return;
    }
    const adapter = makeAdapter();
    const containers = await adapter.listContainers({ externalHostId: envId });
    const stacks = await adapter.listStacks({ externalHostId: envId });
    console.log("[live] dockhand read counts:", {
      containers: containers.length,
      stacks: stacks.length,
      stackStatuses: [...new Set(stacks.map((s) => s.status))],
      containerStates: [...new Set(containers.map((c) => c.state))],
    });
    expect(Array.isArray(containers)).toBe(true);
    expect(Array.isArray(stacks)).toBe(true);

    // Counts alone do NOT verify field names, and that distinction is the
    // whole reason this block exists. `containerSchema`/`stackSchema` parse
    // defensively, so a field this package guessed WRONG degrades to `null`
    // and the read still "succeeds" with the right row count. The session
    // cookie was exactly that failure: 62 stub tests green, and no live login
    // could ever have worked. So report presence per field, across ALL rows
    // rather than the first one — a single container legitimately missing an
    // optional value must not read as a wrong field name.
    const presence = <T,>(rows: readonly T[], get: (row: T) => unknown) =>
      rows.length === 0 ? "no rows" : rows.some((row) => get(row) !== null);
    console.log("[live] dockhand container fields observed:", {
      externalContainerId: presence(containers, (c) => c.externalContainerId),
      externalHostId: presence(containers, (c) => c.externalHostId),
      name: presence(containers, (c) => c.name),
      image: presence(containers, (c) => c.image),
      state: presence(containers, (c) => c.state),
      status: presence(containers, (c) => c.status),
    });
    console.log("[live] dockhand stack fields observed:", {
      name: presence(stacks, (s) => s.name),
      externalHostId: presence(stacks, (s) => s.externalHostId),
      status: presence(stacks, (s) => s.status),
      sourceType: presence(stacks, (s) => s.sourceType),
      // Numbers, not nullable — a wrong field name surfaces as a constant 0
      // rather than a null, so report the observed spread instead of presence.
      containerCountRange: stacks.length === 0
        ? "no rows"
        : `${Math.min(...stacks.map((s) => s.containerCount))}..${Math.max(...stacks.map((s) => s.containerCount))}`,
      runningContainerCountRange: stacks.length === 0
        ? "no rows"
        : `${Math.min(...stacks.map((s) => s.runningContainerCount))}..${Math.max(...stacks.map((s) => s.runningContainerCount))}`,
    });
  });

  it("performs one login for several reads", async () => {
    const adapter = makeAdapter();
    await adapter.listHosts();
    await adapter.listHosts();
    expect(adapter.stats().authExchanges).toBe(1);
  });
});
