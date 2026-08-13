/**
 * The container-host provider port: the shapes this domain needs from a
 * container-management adapter, **re-declared structurally rather than
 * imported**, plus the planner that turns desired state into provider
 * operations.
 *
 * `@loxep/infrastructure` takes NO dependency on
 * `@loxep/integration-dockhand`, exactly as it takes none on
 * `@loxep/integration-cloudflare` or `@loxep/integration-purelymail`. The
 * composition root holds both and passes an adapter in. The consequence is the
 * intended one: a second container manager needs a new integration package and
 * no change here, and this package's tests run against a stub with no provider
 * code in the graph at all.
 *
 * The duplication is guarded the way every other structural re-declaration in
 * Loxep is — by a compile-time assignability test in the composition root's
 * suite, so a drift between the two shapes fails a test rather than a
 * production sync.
 *
 * ## What this seam is, and the rule-13 carve-out that permits it
 *
 * [Rule 13](../../../apps/docs/src/content/docs/architecture/domain-boundaries.md)
 * forbids Loxep calling a companion's mutating endpoints. The owner granted one
 * carve-out on 2026-08-13: **host registration and configuration are Phase
 * 7-style desired state.** Registering a machine writes a row in the container
 * manager's own inventory; it does not run anything on that machine. Container
 * lifecycle verbs — start, stop, restart, exec, deploy, redeploy — remain
 * forbidden without exception, and the integration adapter enforces that with
 * its own test rather than relying on this port to stay small.
 *
 * So this port has `read`, `apply`, and `capabilities`, matching
 * `DnsProviderPort`'s triple — and `apply` accepts exactly two operation kinds.
 *
 * ## Why there is no `delete`
 *
 * Deliberate, and worth stating so the gap does not read as an oversight.
 * Removing a host from the container manager's inventory is not Loxep's
 * decision to make: an operator who decommissions a machine says so in
 * `hosting_targets`, and Loxep's correct response is to stop reconciling it,
 * not to delete somebody else's record. The operation union is closed so that
 * adding a delete requires an owner ruling rather than a one-line union member.
 *
 * ## The join key is the NAME, and that is what makes this migration-free
 *
 * Loxep never stores a provider identifier for a managed host. The
 * fleet-observability design forbids exactly that — *"No provider-specific
 * column anywhere. There is no `hosting_targets.beszel_system_id`"* — and the
 * general mechanism it prescribes (`external_resources` + `resource_links`)
 * has not shipped.
 *
 * It does not need to have shipped for this seam to work, because both sides
 * already carry a unique name: `hosting_targets_name_uq` on Loxep's side, and
 * *"unique display name for the environment"* on the provider's. Matching on
 * the name is therefore sound today and needs **no new table and no new
 * column**.
 *
 * **The limitation this accepts, recorded rather than discovered:** renaming a
 * host on either side breaks the correspondence and the next plan reads as
 * "create a new host". Until link rows exist, a rename is an operator action
 * that must be made on both sides, and a caller should refuse to apply a plan
 * whose creates exceed what the operator expected. See
 * {@link ContainerHostPlan.unmatchedObserved}, which exists so that condition
 * is visible rather than silent.
 */

/**
 * One managed host as observed at the provider, in Loxep's vocabulary.
 *
 * **No secret material appears here, by construction.** A container manager's
 * host record can carry TLS PEM bundles and agent tokens; an adapter reduces
 * each to a presence bit before it crosses this boundary, because the
 * reconciler compares that material by PRESENCE and never by value. A port that
 * accepted a private key would put one into every diff and every run-step
 * summary that touched it.
 */
export interface ObservedContainerHost {
  externalHostId: string;
  /** The join key. Unique at the provider. */
  name: string;
  /** `socket`, `direct`, `hawser-standard`, `hawser-edge`, … Verbatim. */
  connectionType: string;
  host: string | null;
  port: number | null;
  protocol: string | null;
  socketPath: string | null;
  /** Whether the provider holds any TLS material. Never the material. */
  tlsConfigured: boolean;
  tlsSkipVerify: boolean | null;
  labels: string[];
  publicIp: string | null;
  /** Whether an agent token is configured. Never the token. */
  hawserConfigured: boolean;
  hawserLastSeen: string | null;
  updatedAt: string | null;
}

/**
 * Desired state for one managed host — the payload an apply carries.
 *
 * The four secret fields are **write-only**: they can be sent and are never
 * read back, which is the asymmetry {@link ObservedContainerHost} encodes with
 * presence bits. A planner therefore cannot diff them by value, and
 * {@link planContainerHostOperations} does not try.
 */
export interface ContainerHostPayload {
  name: string;
  connectionType: string;
  host?: string | null;
  port?: number | null;
  protocol?: string | null;
  socketPath?: string | null;
  tlsSkipVerify?: boolean | null;
  labels?: string[];
  publicIp?: string | null;
  /** Write-only. */
  tlsCa?: string;
  /** Write-only. */
  tlsCert?: string;
  /** Write-only. */
  tlsKey?: string;
  /** Write-only. */
  hawserToken?: string;
}

export type ContainerHostOperation =
  | { kind: "create"; host: ContainerHostPayload }
  | {
      kind: "update";
      externalHostId: string;
      host: Partial<ContainerHostPayload> & { name?: string };
    };

export interface ContainerHostApplyResult {
  kind: ContainerHostOperation["kind"];
  name: string;
  status: "applied";
  externalHostId: string;
}

export interface ContainerHostProviderCapabilities {
  provider: string;
  /** Always true for a port that has `apply`; stated so a UI can read it. */
  hostRegistration: boolean;
  /** Must be `false`. Rule 13. A port implementation reporting true is a bug. */
  containerLifecycle: boolean;
  metricHistory: boolean;
  bearerTokenAuth: boolean;
  connectionTypes: readonly string[];
}

/**
 * The minimal contract that makes the container-host reconciler
 * provider-agnostic — the design's `read` / `apply` / `capabilities` triple,
 * matching `DnsProviderPort`.
 */
export interface ContainerHostProviderPort {
  read(): Promise<ObservedContainerHost[]>;
  apply(operation: ContainerHostOperation): Promise<ContainerHostApplyResult>;
  capabilities(): ContainerHostProviderCapabilities;
}

/**
 * Loxep's desired state for one host, as a caller assembles it from a
 * `hosting_targets` row plus whatever connection detail the operator supplied.
 *
 * This is deliberately NOT `hosting_targets` itself. That table models Loxep's
 * fleet — addresses, fronting relationships, decommissioning — and only a
 * subset of it is meaningful to a container manager. Keeping the two apart is
 * why no migration is needed: the mapping happens in the caller, in memory.
 */
export interface DesiredContainerHost extends ContainerHostPayload {
  /** The `hosting_targets.id` this desired host came from, for attribution. */
  hostingTargetId: string;
}

export interface ContainerHostPlan {
  operations: ContainerHostOperation[];
  /**
   * Hosts present at the provider that no desired record matched.
   *
   * **Never turned into deletes.** They are surfaced so a caller can show "the
   * container manager knows about three machines Loxep does not", which is
   * useful information and not a drift to correct — the provider may legitimately
   * manage hosts Loxep has no opinion about. This is also where a rename shows
   * up (see the module doc), which is why it is on the plan rather than dropped.
   */
  unmatchedObserved: ObservedContainerHost[];
}

/** Comparable fields only: the write-only secrets are excluded on purpose. */
function differs(
  desired: DesiredContainerHost,
  observed: ObservedContainerHost,
): Partial<ContainerHostPayload> | null {
  const changes: Partial<ContainerHostPayload> = {};

  if (desired.connectionType !== observed.connectionType) {
    changes.connectionType = desired.connectionType;
  }
  const compare = <K extends "host" | "protocol" | "socketPath" | "publicIp">(
    key: K,
  ): void => {
    const want = desired[key];
    if (want === undefined) return;
    if ((want ?? null) !== observed[key]) changes[key] = want;
  };
  compare("host");
  compare("protocol");
  compare("socketPath");
  compare("publicIp");

  if (desired.port !== undefined && (desired.port ?? null) !== observed.port) {
    changes.port = desired.port;
  }
  if (
    desired.tlsSkipVerify !== undefined &&
    (desired.tlsSkipVerify ?? null) !== observed.tlsSkipVerify
  ) {
    changes.tlsSkipVerify = desired.tlsSkipVerify;
  }
  if (desired.labels !== undefined) {
    const want = [...desired.labels].sort();
    const have = [...observed.labels].sort();
    if (want.length !== have.length || want.some((l, i) => l !== have[i])) {
      changes.labels = desired.labels;
    }
  }

  return Object.keys(changes).length === 0 ? null : changes;
}

/**
 * Turn desired state plus an observed inventory into the operations that
 * converge them.
 *
 * Pure — no I/O, no clock — so the reconciler's decision is testable without a
 * provider, matching how the DNS diff is tested.
 *
 * ## Secret material is sent on create and never diffed on update
 *
 * A create carries whatever TLS or agent material the desired record holds,
 * because the provider needs it to connect at all. An update does **not** carry
 * it unless the desired record explicitly supplies it, and its absence is never
 * read as "remove it" — the observed side reports presence, not value, so
 * "differs" is unanswerable for those fields and guessing would either
 * re-transmit a private key on every sweep or silently clear one.
 */
export function planContainerHostOperations(input: {
  desired: readonly DesiredContainerHost[];
  observed: readonly ObservedContainerHost[];
}): ContainerHostPlan {
  const byName = new Map<string, ObservedContainerHost>();
  for (const host of input.observed) byName.set(host.name, host);

  const operations: ContainerHostOperation[] = [];
  const matched = new Set<string>();

  for (const desired of input.desired) {
    const observed = byName.get(desired.name);
    if (observed === undefined) {
      const { hostingTargetId: _attribution, ...payload } = desired;
      operations.push({ kind: "create", host: payload });
      continue;
    }
    matched.add(observed.name);

    const changes = differs(desired, observed);
    // Secret material is applied only when the caller deliberately supplied it.
    const secrets: Partial<ContainerHostPayload> = {};
    if (desired.tlsCa !== undefined) secrets.tlsCa = desired.tlsCa;
    if (desired.tlsCert !== undefined) secrets.tlsCert = desired.tlsCert;
    if (desired.tlsKey !== undefined) secrets.tlsKey = desired.tlsKey;
    if (desired.hawserToken !== undefined) {
      secrets.hawserToken = desired.hawserToken;
    }

    if (changes === null && Object.keys(secrets).length === 0) continue;

    operations.push({
      kind: "update",
      externalHostId: observed.externalHostId,
      host: { ...(changes ?? {}), ...secrets },
    });
  }

  return {
    operations,
    unmatchedObserved: input.observed.filter((host) => !matched.has(host.name)),
  };
}
