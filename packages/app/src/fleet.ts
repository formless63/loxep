/**
 * Composition-root wiring for the fleet-observability providers (Phase 8,
 * loxep-9j6): Beszel and Dockhand.
 *
 * Two providers, two very different shapes, and the difference is the point:
 *
 * ```text
 * beszel     READ ONLY. No port, because there is nothing to reconcile —
 *            Beszel is authoritative about host status and Loxep records the
 *            latest observation. Wiring is a future projection into
 *            integration_health; see the TODO below.
 *
 * dockhand   READ + HOST INTENT. Gets a port, because the owner's 2026-08-13
 *            rule-13 carve-out makes host registration desired state, and
 *            desired state in Loxep goes through a reconciler.
 * ```
 *
 * ## What is deliberately NOT here yet
 *
 * **No adapter factories, and no tasks.** `cloudflare.ts` and `purelymail.ts`
 * each build their adapter from a `connections` row plus a decrypted ADR-0019
 * bundle, with a cached per-connection rate budget. The equivalents for these
 * two providers need a connection provider value that the `/settings` surface
 * creates, and that surface is being built separately. Adding half of it here
 * would mean guessing at the config shape the form will write.
 *
 * What this module DOES pin down is the part that must not be guessed: the
 * provider and credential-purpose identifiers, and the structural port
 * adapter whose assignability test is the only thing standing between
 * `@loxep/infrastructure`'s re-declared `ContainerHostProviderPort` and
 * `@loxep/integration-dockhand`'s real adapter shape.
 *
 * ## `integration_health`: half of the projection is already free, half is not
 *
 * Milestone 1 (loxep-ovj.1) has landed — migration `0014_integration_health`,
 * `@loxep/domain`'s `createHealthService`, and the `health.sweep` job. That
 * splits the projection question cleanly in two, and only one half needs code:
 *
 * - **connection-level health is already covered, with nothing added here.**
 *   The default registry's `connection` subject derives status from
 *   `connections.last_success_at` / `last_error_at` with no network call, so
 *   the moment a `beszel` or `dockhand` connection row exists it gets an
 *   `integration_health` row like every other provider's. That is the right
 *   answer for "can Loxep reach this tool", which is the question this phase's
 *   fleet-health summary actually asks first.
 * - **per-subject health — one row per Beszel system, one per Dockhand managed
 *   host — is still a seam**, and what blocks it is not the table. It is the
 *   LINK. The design is explicit that there is *"no provider-specific column
 *   anywhere… no `hosting_targets.beszel_system_id`"*; a per-host row keys on
 *   `subject_type = 'hosting_target'` and needs `external_resources` /
 *   `resource_links` to say which target a given provider subject is. Those
 *   tables have not shipped.
 *
 * When they do, the shape each provider projects is already decided:
 *
 * ```text
 * subject_type     status                      observed_at
 * ---------------  --------------------------  ----------------------------
 * hosting_target   Beszel's own status string  the system record's own
 *                                              `updated` time
 * hosting_target   derived from Dockhand's     LOXEP'S READ CLOCK — Dockhand
 *                  host record                 reports no per-host timestamp
 * ```
 *
 * The one rule that must survive that wiring is the design's: *"Every status
 * renders its provenance… A status with no visible age is a status an operator
 * will over-trust."* Both providers carry an observation time, and Dockhand's
 * is Loxep's read clock rather than the provider's — a difference that has to
 * stay visible in the projection, not be smoothed over into a single column
 * that means two things.
 */
import type {
  ContainerHostApplyResult,
  ContainerHostOperation,
  ContainerHostProviderCapabilities,
  ContainerHostProviderPort,
  ObservedContainerHost,
} from "@loxep/infrastructure";
import type {
  DockhandAdapter,
  DockhandHostOperation,
} from "@loxep/integration-dockhand";

/**
 * The slice of the real {@link DockhandAdapter} the port wrapper consumes.
 *
 * Stated as a `Pick` over the imported adapter type — not a re-declared
 * structural interface — so this file carries the same guarantee as its
 * siblings (`mailProviderPortFromPurelymailAdapter` takes a `PurelymailAdapter`,
 * `providerPortFromCloudflareAdapter` takes a `CloudflareAdapter`): if the
 * Dockhand adapter's `readHosts`/`applyHost`/`capabilities` drift from what
 * `@loxep/infrastructure`'s port expects, the wrapper below stops compiling
 * and the assignability test in this package's suite fails.
 */
export type ContainerHostAdapterLike = Pick<
  DockhandAdapter,
  "readHosts" | "applyHost" | "capabilities"
>;

/**
 * `connections.provider` value the Beszel reader accepts.
 *
 * The fleet design's schema sketch names both providers in one line —
 * `connections.provider = 'gatus' | 'beszel'` — and this is that value.
 */
export const BESZEL_CONNECTION_PROVIDER = "beszel";

/**
 * Registered credential purpose holding the Beszel hub login (ADR-0019).
 *
 * **The connection form must label this a readonly USER, not an API token.**
 * The design warned against the opposite dishonesty — *"A form field labelled
 * 'API token' over a superuser password is the kind of small dishonesty that
 * later gets someone to reuse a password"* — and the correction found while
 * building the adapter does not retire that warning, it redirects it: Beszel
 * has no token at all, and what Loxep stores is an email and a password for a
 * purpose-made readonly account.
 */
export const BESZEL_CREDENTIAL_TYPE = "beszel_credentials";

/** `connections.provider` value the Dockhand adapter accepts. */
export const DOCKHAND_CONNECTION_PROVIDER = "dockhand";

/**
 * Registered credential purpose holding the Dockhand login (ADR-0019).
 *
 * Dockhand publishes no API key — its API reference documents HTTP-only session
 * cookies and nothing else — so this is a real username/password, and the
 * account behind it should hold `environments:view`, `environments:edit`,
 * `containers:view`, and `stacks:view` and nothing more.
 */
export const DOCKHAND_CREDENTIAL_TYPE = "dockhand_credentials";

/**
 * Adapt a {@link DockhandAdapter} to `@loxep/infrastructure`'s
 * `ContainerHostProviderPort`.
 *
 * The two shapes are structurally compatible by design
 * (`container-host-port.ts`'s module doc: "re-declared structurally rather than
 * imported"), so this is a thin forward rather than a translation — but it is
 * written as explicit method calls, never destructured, so an adapter method
 * that calls a sibling through `this` keeps its binding.
 * `providerPortFromCloudflareAdapter` and
 * `mailProviderPortFromPurelymailAdapter` both learned that the same way.
 *
 * ## `read` forwards to `readHosts`, and the naming is deliberate
 *
 * The adapter exposes `listHosts` and `readHosts` as the same function under
 * two names: one reads as a fleet query, the other as the reconciler's read
 * half. This wrapper uses `readHosts`, so that the reconciler's call site says
 * what it is doing.
 *
 * ## What this wrapper structurally cannot forward
 *
 * There is no lifecycle member to forward, on either side. The port has
 * `read`/`apply`/`capabilities`; the adapter has no start, stop, exec, or
 * redeploy method at all (asserted in the integration package's
 * `forbidden-verbs.test.ts`). So the rule-13 boundary is not maintained by this
 * file's restraint — there is nothing here that could be widened without first
 * widening two other packages and failing their tests.
 *
 * ## `apply` narrows before it forwards
 *
 * The port's payload is deliberately provider-agnostic — `connectionType` is a
 * plain string there — while the adapter accepts only the connection types
 * Dockhand documents. The wrapper checks intent against the adapter's own
 * advertised `capabilities().connectionTypes` and refuses anything outside it,
 * so an unsupported value becomes a loud apply failure the reconciler records
 * instead of an unchecked cast crossing the boundary.
 */
export function containerHostPortFromDockhandAdapter(
  adapter: ContainerHostAdapterLike,
): ContainerHostProviderPort {
  return {
    read: (): Promise<ObservedContainerHost[]> => adapter.readHosts(),
    apply: (
      operation: ContainerHostOperation,
    ): Promise<ContainerHostApplyResult> => {
      if (operation.kind === "create" || operation.kind === "update") {
        const connectionType = operation.host.connectionType;
        const allowed: readonly string[] =
          adapter.capabilities().connectionTypes;
        if (
          connectionType !== undefined &&
          connectionType !== null &&
          !allowed.includes(connectionType)
        ) {
          throw new Error(
            `dockhand: connection type ${JSON.stringify(connectionType)} is not supported by this provider (supported: ${allowed.join(", ")})`,
          );
        }
      }
      return adapter.applyHost(operation as DockhandHostOperation);
    },
    capabilities: (): ContainerHostProviderCapabilities =>
      adapter.capabilities(),
  };
}
