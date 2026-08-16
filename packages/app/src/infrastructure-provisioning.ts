/**
 * The provisioning-template engine's ONE driver task — composition-root
 * wiring for the Pangolin chain design's milestone 6 (`loxep-acj.6`).
 *
 * `infrastructure.run-provisioning-template`, payload `{ runId }` and
 * nothing else (`tasks.ts` rule 1 — no credential ever enters a payload).
 * Every credential this run needs is resolved INSIDE the task, from the
 * frozen `compiled_plan`'s own step params, through the SAME per-connection
 * adapter factories every other reconciler in this composition already
 * uses:
 *
 * ```text
 * resolveDnsProvider     services.getCloudflareAdapterForConnection
 *                        + providerPortFromCloudflareAdapter
 *                          (infrastructure-poll-executor.ts, UNCHANGED)
 * resolveMailProvider    services.getPurelymailAdapterForConnection
 *                        + mailProviderPortFromPurelymailAdapter
 *                          (infrastructure-mail.ts, UNCHANGED)
 * resolveProxyProvider   resolveProxyProviderForHostingTarget
 *                          (infrastructure-proxy.ts, UNCHANGED) — already
 *                          resolves the port, the org id, AND the
 *                          write-authorization context in one call, exactly
 *                          the shape `@loxep/infrastructure`'s
 *                          `ProvisioningProviders.resolveProxyProvider`
 *                          needs
 * ```
 *
 * Nothing here duplicates those three functions' own logic — this module
 * only calls them, per the design's own "the engine compiles and drives, it
 * does not execute provider calls itself" rule applied one level up: this
 * composition-root wiring does not resolve a credential itself either, it
 * asks the modules that already own that resolution.
 *
 * ## `job_key_mode: 'preserve_run_at'`, and who enqueues
 *
 * `@loxep/infrastructure`'s `createProvisioningTemplatesService().startRun`
 * enqueues transactionally, in the same transaction that inserts
 * `template_runs`/`template_run_steps` — the design's own "write intent and
 * enqueue, then redirect" rule. A "Resume run" click is a plain re-enqueue
 * with the SAME job key (`provisioningTemplateRunJobKey(runId)`) from a
 * request-scoped admin action (`apps/web`'s own provisioning server
 * functions) — never from inside this task, and never from a sweep or poll.
 * `preserve_run_at` is what keeps a days-long delegation wait from being
 * reset by either of those re-enqueues.
 *
 * ## `actorIsAdmin: true`, unconditionally
 *
 * Every enqueue of this task — the wizard's initial `startRun`, or an
 * operator's "Resume run" — originates from a `requireAdmin()`-gated server
 * function (the owner's ruling: "writes are admin-only in Loxep"). Unlike
 * `infrastructure.sync-proxy-resource`, which a future drift cadence may one
 * day trigger on `'poll'`, nothing schedules this task — see
 * `provisioning.ts`'s own module doc for why every driver PASS's evidence
 * row is honestly `trigger: 'manual'`. So `actorIsAdmin: true` is safe here
 * in a way it would not be for a poll-triggered executor.
 */
import { defineTask } from "@loxep/jobs";
import type { LoxepTask } from "@loxep/jobs";
import {
  RUN_PROVISIONING_TEMPLATE_TASK,
  createProvisioningDriver,
  createProxyResourcesService,
} from "@loxep/infrastructure";
import type {
  ProvisioningDriver,
  ProvisioningProviders,
} from "@loxep/infrastructure";
import { z } from "zod";
import { providerPortFromCloudflareAdapter } from "./infrastructure-poll-executor.ts";
import { mailProviderPortFromPurelymailAdapter } from "./infrastructure-mail.ts";
import { resolveProxyProviderForHostingTarget } from "./infrastructure-proxy.ts";
import type { AppServices } from "./services.ts";

/**
 * The three provider resolvers `createProvisioningDriver` needs, built once
 * per composition — see the module doc for what each one reuses.
 */
export function buildProvisioningProviders(
  services: AppServices,
): ProvisioningProviders {
  return {
    async resolveDnsProvider(connectionId) {
      const cloudflare =
        await services.getCloudflareAdapterForConnection(connectionId);
      return providerPortFromCloudflareAdapter(cloudflare.adapter);
    },
    async resolveMailProvider(connectionId) {
      const purelymail =
        await services.getPurelymailAdapterForConnection(connectionId);
      return mailProviderPortFromPurelymailAdapter(purelymail.adapter);
    },
    async resolveProxyProvider(hostingTargetId) {
      // Already returns exactly this shape — see this module's own doc.
      return resolveProxyProviderForHostingTarget(services, hostingTargetId, {
        actorIsAdmin: true,
      });
    },
  };
}

/** Builds the ONE driver instance this composition ever needs — shared across every drive of the task below. */
export function buildProvisioningDriver(
  services: AppServices,
): ProvisioningDriver {
  const proxyResourceService = createProxyResourcesService({
    db: services.db,
    settings: services.settings,
  });
  return createProvisioningDriver({
    db: services.db,
    proxyResourceService,
    providers: buildProvisioningProviders(services),
    // Write-only mailbox-password seam — see `infrastructure-mail.ts`'s own
    // `createMailSyncForDomain`, which already passes `services.secrets`
    // structurally to the same `MailboxSecretWriter` shape.
    secrets: services.secrets,
    settings: services.settings,
  });
}

const runProvisioningTemplatePayloadSchema = z.object({
  runId: z.string().uuid(),
});

export interface InfrastructureProvisioningTasks {
  runProvisioningTemplateTask: LoxepTask<
    typeof runProvisioningTemplatePayloadSchema
  >;
  tasks: readonly LoxepTask<typeof runProvisioningTemplatePayloadSchema>[];
}

export function createInfrastructureProvisioningTasks(options: {
  services: AppServices;
}): InfrastructureProvisioningTasks {
  const { services } = options;
  const driver = buildProvisioningDriver(services);

  const runProvisioningTemplateTask = defineTask({
    name: RUN_PROVISIONING_TEMPLATE_TASK,
    payloadSchema: runProvisioningTemplatePayloadSchema,
    handler: async (payload, { logger }) => {
      // "Advance as far as you currently can, record exactly where you
      // stopped, return." Never throws for a classified step failure — see
      // `provisioning.ts`'s own `advance()` doc for the one exception (a
      // genuinely unexpected error, which SHOULD fail this job and get
      // Graphile Worker's retry/backoff).
      const result = await driver.advance(payload.runId, {
        actorIsAdmin: true,
      });
      logger.info(
        { runId: payload.runId, status: result.status },
        "provisioning template run advanced",
      );
    },
  });

  return {
    runProvisioningTemplateTask,
    tasks: [runProvisioningTemplateTask],
  };
}
