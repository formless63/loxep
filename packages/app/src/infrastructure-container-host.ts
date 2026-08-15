/**
 * `infrastructure.reconcile-container-host` — composition-root wiring for
 * loxep-hb7 Milestone C's host-registration reconciler.
 *
 * `@loxep/infrastructure`'s `container-hosts.ts` owns the whole read -> diff
 * -> apply -> record flow and takes no dependency on
 * `@loxep/integration-dockhand`; this module is the one place that holds
 * both. Three things happen here that `container-hosts.ts` cannot do for
 * itself:
 *
 *   1. resolve the target's Dockhand CONNECTION (the reconciler is told a
 *      `hostingTargetId` alone, per Configuration & Secrets rule 1 — no
 *      connection id in the job payload — so this module reads it off the
 *      target's own dockhand/environment companion link, exactly the way
 *      `apps/web`'s `fetchDockhandHostView` already does for the read-only
 *      containers panel);
 *   2. build the real `ContainerHostProviderPort` from that connection's
 *      cached `DockhandAdapter` (`fleet.ts`'s `containerHostPortFromDockhandAdapter`
 *      wrapping `services.getDockhandAdapterForConnection`);
 *   3. inject `readSecret`/`writeSecret` against the real `SecretsService`
 *      (`services.secrets` for the read; a fresh transaction-scoped one for
 *      the write — mirroring `infrastructure-token.ts`'s
 *      `TransactionalDnsTokenSecretWriter` injection exactly).
 *
 * `declareIntent` — the request-scoped half — is NOT called from here. It is
 * a request-scoped admin action (`apps/web/src/server/infrastructure-functions.ts`),
 * the same split `infrastructure-token.ts`'s own module doc draws between
 * `mint`/`roll` (request-scoped) and `syncPolicy` (this file's kind of task).
 * `apps/web` builds its OWN `ContainerHostsService` instance (with its own
 * `readSecret`/`writeSecret`/`enqueue`) for that call — two composition
 * roots, one shared `@loxep/infrastructure` service definition, exactly as
 * `admin.ts`'s `dnsProviderTokens` and this file's `infrastructureTokens`
 * both wrap `createDnsProviderTokensService`.
 */
import { defineTask } from "@loxep/jobs";
import type { LoxepTask } from "@loxep/jobs";
import {
  RECONCILE_CONTAINER_HOST_TASK,
  createContainerHostsService,
  createTransactionalEnqueue,
} from "@loxep/infrastructure";
import type {
  ContainerHostProviderPort,
  ContainerHostsService,
  ReconcileContainerHostResult,
  ResponseRedactor,
} from "@loxep/infrastructure";
import { createResourceLinksService, createSecretsService } from "@loxep/domain";
import { z } from "zod";
import {
  DOCKHAND_CONNECTION_PROVIDER,
  containerHostPortFromDockhandAdapter,
} from "./fleet.ts";
import { AppConfigurationError } from "./errors.ts";
import type { AppServices } from "./services.ts";

/** `resource_links.purpose` for a Dockhand host registration — the fleet design's own vocabulary row. */
const CONTAINER_HOST_LINK_PURPOSE = "container_console";
const CONTAINER_HOST_EXTERNAL_TYPE = "environment";

/**
 * The `reconcile_run_steps` redactor for this reconciler. Mirrors
 * `infrastructure-poll-executor.ts`'s `cloudflareApplyResultRedactor`: the
 * value handed to a `ResponseRedactor` here is never a raw Dockhand envelope
 * — `container-hosts.ts` calls it only on an already-normalized
 * `ContainerHostApplyResult` (`{kind, name, status, externalHostId}`), which
 * is Loxep-owned and entirely scalar. The REQUEST side (the host payload,
 * which CAN carry `tlsCa`/`tlsCert`/`tlsKey`/`hawserToken`) never reaches a
 * `ResponseRedactor` at all — `container-hosts.ts` redacts its own request
 * summaries with `redactDockhandHostPayload`-shaped scalar picks before this
 * function ever sees them (see that module's `errorKind`/step-recording
 * code), so this redactor only ever needs to handle the result shape.
 */
export const dockhandResultRedactor: ResponseRedactor = (value) => {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    kind: typeof record["kind"] === "string" ? record["kind"] : null,
    name: typeof record["name"] === "string" ? record["name"] : null,
    status: typeof record["status"] === "string" ? record["status"] : null,
    externalHostId:
      typeof record["externalHostId"] === "string" ? record["externalHostId"] : null,
  };
};

/**
 * Builds a `ContainerHostsService` wired against this composition's real
 * `SecretsService` and transactional enqueue. Exported so Milestone D's
 * drift cadence (`fleet-health.ts`, piggybacked on `health.sweep`) can share
 * this SAME construction rather than growing a second one — its own caller
 * already knows the connection and its adapter (from the connection health
 * probe it just ran), so it only ever calls `.reconcile()`/
 * `.listDeclaredTargets()`, never `.declareIntent()`.
 */
export function createInfrastructureContainerHostsService(
  services: AppServices,
): ContainerHostsService {
  return createContainerHostsService({
    db: services.db,
    readSecret: async (secretKey) => {
      const secret = await services.secrets.getSecretPayload(
        secretKey,
        "container_host_secret",
      );
      return secret.payload;
    },
    writeSecret: (tx, input) =>
      createSecretsService({ db: tx, keyring: services.config.keyring }).setSecret(input),
    // Never actually called from THIS composition — `declareIntent` is a
    // request-scoped `apps/web` action, and this file only ever calls
    // `.reconcile()`/`.listDeclaredTargets()` (see the module doc). Still
    // required to satisfy `createContainerHostsService`'s constructor, and
    // takes no `@loxep/config` dependency to build, unlike `writeSecret`.
    enqueue: createTransactionalEnqueue(),
  });
}

/**
 * Resolves the `ContainerHostProviderPort` a `hostingTargetId` alone implies
 * — the target's dockhand/environment/container_console link's own
 * `connectionId`, per this module's doc. Throws `AppConfigurationError` when
 * no such link exists (nothing declared yet, or the link's connection was
 * removed) so the task fails loudly and visibly rather than silently no-op'ing.
 */
export async function resolveContainerHostProvider(
  services: AppServices,
  hostingTargetId: string,
): Promise<ContainerHostProviderPort> {
  const resourceLinks = createResourceLinksService({ db: services.db });
  const links = await resourceLinks.listLinksFor("hosting_target", hostingTargetId);
  const link = links.find(
    (candidate) =>
      candidate.provider === DOCKHAND_CONNECTION_PROVIDER &&
      candidate.externalType === CONTAINER_HOST_EXTERNAL_TYPE &&
      candidate.purpose === CONTAINER_HOST_LINK_PURPOSE,
  );
  if (link === undefined || link.connectionId === null) {
    throw new AppConfigurationError(
      `hosting target ${hostingTargetId} has no Dockhand host-registration link with a connection to reconcile against`,
    );
  }
  const { adapter } = await services.getDockhandAdapterForConnection(link.connectionId);
  return containerHostPortFromDockhandAdapter(adapter);
}

const reconcileContainerHostPayloadSchema = z.object({
  hostingTargetId: z.string().uuid(),
  mode: z.enum(["apply", "check"]).optional(),
  trigger: z.enum(["intent_change", "manual", "poll"]).optional(),
});

export interface InfrastructureContainerHostTasks {
  reconcileContainerHostTask: LoxepTask<typeof reconcileContainerHostPayloadSchema>;
  tasks: readonly LoxepTask<typeof reconcileContainerHostPayloadSchema>[];
}

export function createInfrastructureContainerHostTasks(options: {
  services: AppServices;
}): InfrastructureContainerHostTasks {
  const { services } = options;
  const containerHosts = createInfrastructureContainerHostsService(services);

  const reconcileContainerHostTask = defineTask({
    name: RECONCILE_CONTAINER_HOST_TASK,
    payloadSchema: reconcileContainerHostPayloadSchema,
    handler: async (payload, { logger }) => {
      const provider = await resolveContainerHostProvider(services, payload.hostingTargetId);

      // `reconcile()` already records a failed run and stamps
      // `provider_operations` where relevant on any thrown error; Graphile's
      // own retry backoff is the right response here, matching every other
      // reconciler task in this file (`infrastructure-poll-executor.ts`).
      // Unlike that executor, this task does not invalidate a cached adapter
      // on an `auth`-class failure — the connection id is resolved fresh
      // from the link on every run (never cached here), so the next attempt
      // already re-reads current state rather than a stale adapter.
      const result: ReconcileContainerHostResult = await containerHosts.reconcile(
        payload.hostingTargetId,
        {
          mode: payload.mode ?? "check",
          trigger: payload.trigger ?? "manual",
          provider,
          redact: dockhandResultRedactor,
        },
      );

      logger.info(
        {
          hostingTargetId: payload.hostingTargetId,
          runId: result.runId,
          status: result.status,
          mode: result.mode,
          operationCount: result.operationCount,
          applied: result.applied,
          unmatchedObservedCount: result.unmatchedObservedCount,
        },
        "infrastructure container-host reconcile complete",
      );
    },
  });

  return { reconcileContainerHostTask, tasks: [reconcileContainerHostTask] };
}
