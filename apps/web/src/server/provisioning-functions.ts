/**
 * Server functions for `/infrastructure/templates` — the provisioning-
 * template engine (Pangolin chain design milestone 6, `loxep-acj.6`).
 *
 * Same discipline as `infrastructure-functions.ts`: reads call `requireSession`
 * (any authenticated member); mutations call `requireAdmin` (the owner's own
 * ruling — writes are admin-only in Loxep). Handlers use dynamic imports so
 * `@/server/admin` stays out of the client bundle.
 *
 * `startProvisioningTemplateRun` and `resumeProvisioningTemplateRun` write
 * intent (or re-enqueue) and return immediately — the design's own rule,
 * restated because the temptation to await the first driven step is
 * strongest on exactly this screen: *"the wizard writes intent and
 * enqueues, then redirects — it never awaits a provider call."* Neither
 * function calls `ProvisioningDriver.advance()`; only the registered worker
 * task does.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { JsonValue } from '@/server/admin-functions';

function iso(date: Date): string;
function iso(date: Date | null | undefined): string | null;
function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/* --------------------------------------------------------------- DTOs --- */

export interface ProvisioningTemplateDto {
  id: string;
  name: string;
  description: string | null;
  version: number;
  isDefault: boolean;
  stepCount: number;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProvisioningTemplateStepDto {
  id: string;
  sequence: number;
  stepKind: string;
  provider: string | null;
  params: Record<string, JsonValue>;
  optional: boolean;
}

/** A compiled step, for the wizard's mandatory plan preview — see `previewProvisioningTemplateRun`. */
export interface CompiledStepDto {
  sequence: number;
  stepKind: string;
  provider: string | null;
  params: Record<string, JsonValue>;
  optional: boolean;
  dependsOnSequence: number | null;
}

export interface CompiledPlanDto {
  steps: CompiledStepDto[];
}

export interface ProvisioningTemplateRunSummaryDto {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface ProvisioningTemplateDetailDto extends ProvisioningTemplateDto {
  steps: ProvisioningTemplateStepDto[];
  /** Every `${placeholder}` the run wizard needs a field for. */
  inputKeys: string[];
  runs: ProvisioningTemplateRunSummaryDto[];
}

export interface ProvisioningTemplateRunStepDto {
  id: string;
  sequence: number;
  stepKind: string;
  provider: string | null;
  status: string;
  blockedReason: string | null;
  reconcileRunId: string | null;
  providerOperationKey: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  occurredAt: string;
}

export interface ProvisioningTemplateRunDto {
  id: string;
  templateId: string;
  templateName: string;
  templateVersion: number;
  status: string;
  inputs: Record<string, JsonValue>;
  startedAt: string;
  finishedAt: string | null;
  steps: ProvisioningTemplateRunStepDto[];
}

/* ------------------------------------------------------------- reads --- */

export const fetchProvisioningTemplates = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ProvisioningTemplateDto[]> => {
    const { requireSession, getProvisioningTemplatesService } = await import('@/server/admin');
    await requireSession();
    const templates = getProvisioningTemplatesService();
    const rows = await templates.list();
    const result: ProvisioningTemplateDto[] = [];
    for (const row of rows) {
      const [steps, runs] = await Promise.all([
        templates.listSteps(row.id),
        templates.listRuns(row.id)
      ]);
      result.push({
        id: row.id,
        name: row.name,
        description: row.description,
        version: row.version,
        isDefault: row.isDefault,
        stepCount: steps.length,
        runCount: runs.length,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt)
      });
    }
    return result;
  }
);

export const fetchProvisioningTemplate = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<ProvisioningTemplateDetailDto> => {
    const { requireSession, getProvisioningTemplatesService } = await import('@/server/admin');
    await requireSession();
    const { extractTemplateInputKeys } = await import('@loxep/infrastructure');
    const templates = getProvisioningTemplatesService();
    const [row, steps, runs] = await Promise.all([
      templates.get(data.id),
      templates.listSteps(data.id),
      templates.listRuns(data.id)
    ]);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      version: row.version,
      isDefault: row.isDefault,
      stepCount: steps.length,
      runCount: runs.length,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      steps: steps.map((step) => ({
        id: step.id,
        sequence: step.sequence,
        stepKind: step.stepKind,
        provider: step.provider,
        params: step.params as Record<string, JsonValue>,
        optional: step.optional
      })),
      inputKeys: extractTemplateInputKeys(
        steps.map((step) => ({
          sequence: step.sequence,
          stepKind: step.stepKind as never,
          provider: step.provider as never,
          params: step.params,
          optional: step.optional
        }))
      ),
      runs: runs
        .slice()
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        .slice(0, 20)
        .map((run) => ({
          id: run.id,
          status: run.status,
          startedAt: iso(run.startedAt),
          finishedAt: iso(run.finishedAt)
        }))
    };
  });

export const fetchProvisioningTemplateRun = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<ProvisioningTemplateRunDto> => {
    const { requireSession, getProvisioningTemplatesService } = await import('@/server/admin');
    await requireSession();
    const templates = getProvisioningTemplatesService();
    const [run, steps] = await Promise.all([
      templates.getRun(data.id),
      templates.listRunSteps(data.id)
    ]);
    const template = await templates.get(run.templateId);
    return {
      id: run.id,
      templateId: run.templateId,
      templateName: template.name,
      templateVersion: run.templateVersion,
      status: run.status,
      inputs: run.inputs as Record<string, JsonValue>,
      startedAt: iso(run.startedAt),
      finishedAt: iso(run.finishedAt),
      steps: steps.map((step) => ({
        id: step.id,
        sequence: step.sequence,
        stepKind: step.stepKind,
        provider: step.provider,
        status: step.status,
        blockedReason: step.blockedReason,
        reconcileRunId: step.reconcileRunId,
        providerOperationKey: step.providerOperationKey,
        errorCode: step.errorCode,
        errorDetail: step.errorDetail,
        occurredAt: iso(step.occurredAt)
      }))
    };
  });

/* --------------------------------------------------------- the wizard --- */

/**
 * The MANDATORY plan preview — "the tier-2 'explicit apply from a shown
 * plan' rule arriving one level up." Compiles WITHOUT writing a run row.
 */
export const previewProvisioningTemplateRun = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({
      templateId: z.uuid(),
      inputs: z.record(z.string(), z.unknown())
    })
  )
  .handler(async ({ data }): Promise<CompiledPlanDto> => {
    const { requireSession, getProvisioningTemplatesService } = await import('@/server/admin');
    await requireSession();
    const plan = await getProvisioningTemplatesService().previewRun(data.templateId, data.inputs);
    return {
      steps: plan.steps.map((step) => ({
        sequence: step.sequence,
        stepKind: step.stepKind,
        provider: step.provider,
        params: step.params as Record<string, JsonValue>,
        optional: step.optional,
        dependsOnSequence: step.dependsOnSequence
      }))
    };
  });

/**
 * Writes intent (freezes `compiled_plan`) and enqueues the driver task, in
 * one transaction, then returns — never awaits a provider call. Admin-only:
 * the owner's ruling that writes are admin-only in Loxep.
 */
export const startProvisioningTemplateRun = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({
      templateId: z.uuid(),
      inputs: z.record(z.string(), z.unknown())
    })
  )
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getProvisioningTemplatesService } = await import('@/server/admin');
    const session = await requireAdmin();
    const run = await getProvisioningTemplatesService().startRun({
      templateId: data.templateId,
      inputs: data.inputs,
      actorUserId: session.user.id
    });
    return { id: run.id };
  });

/**
 * "Resume run": re-enqueues the SAME job (`provisioningTemplateRunJobKey`,
 * `preserve_run_at`) — the driver's own re-entrant `advance()` picks up from
 * wherever the run currently stands. This function never calls `advance()`
 * itself; only the registered worker task does.
 */
export const resumeProvisioningTemplateRun = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ enqueued: true }> => {
    const [{ requireAdmin, getAdminServices, getInfrastructureEnqueue }, infrastructure] =
      await Promise.all([import('@/server/admin'), import('@loxep/infrastructure')]);
    await requireAdmin();
    const { handle } = getAdminServices();
    const enqueue = getInfrastructureEnqueue();
    await handle.db.transaction(async (tx) => {
      await enqueue(
        tx,
        infrastructure.RUN_PROVISIONING_TEMPLATE_TASK,
        { runId: data.id },
        {
          jobKey: infrastructure.provisioningTemplateRunJobKey(data.id),
          jobKeyMode: 'preserve_run_at'
        }
      );
    });
    return { enqueued: true };
  });

/**
 * "Abandon run": marks the run `'failed'` and touches nothing else — no
 * rollback, ever. The button copy on `/infrastructure/templates/runs/$id`
 * says so explicitly; this function is what makes that promise true.
 */
export const abandonProvisioningTemplateRun = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ status: string }> => {
    const { requireAdmin, getProvisioningTemplatesService } = await import('@/server/admin');
    const session = await requireAdmin();
    const run = await getProvisioningTemplatesService().abandonRun(data.id, {
      actorUserId: session.user.id
    });
    return { status: run.status };
  });

/* -------------------------------------------------- create-from-example --- */

/**
 * The "create from example" affordance — the design's own resolution of its
 * open question 10, followed exactly: `mailbox_templates` ships UNSEEDED, so
 * this ships no migration-authored row either. The 'new domain' step list
 * (Cloudflare A/AAAA at the Pangolin node -> a Pangolin resource with a
 * bypass rule -> Purelymail domain registration -> the `noreply` mailbox) is
 * created HERE, on an admin's explicit click, using the SAME placeholder
 * templating (`${domain}`, `${dnsConnectionId}`, `${hostingTargetId}`,
 * `${mailConnectionId}`) every hand-authored template uses — nothing here is
 * a special code path the compiler does not already support.
 *
 * Every provider-touching step in this shape needs a write policy the owner
 * has not granted by default (Cloudflare/Purelymail/Pangolin all default
 * `read_only`), so a run built from it blocks HONESTLY at each real gap —
 * exactly the demonstration the design asks for, never a fabricated success.
 */
export const createProvisioningTemplateFromExample = createServerFn({
  method: 'POST'
}).handler(async (): Promise<{ id: string }> => {
  const { requireAdmin, getProvisioningTemplatesService } = await import('@/server/admin');
  const session = await requireAdmin();
  const template = await getProvisioningTemplatesService().create({
    name: 'New domain',
    description:
      'Cloudflare zone + apex/wildcard records at the Pangolin node, a Pangolin resource with a bypass rule, Purelymail domain registration, and the noreply@ mailbox.',
    createdByUserId: session.user.id,
    steps: [
      {
        stepKind: 'domain.declare',
        provider: 'cloudflare',
        params: {
          name: '${domain}',
          dnsConnectionId: '${dnsConnectionId}',
          mailEnabled: true
        }
      },
      {
        stepKind: 'dns.point-at-target',
        provider: 'cloudflare',
        params: { apexTargetId: '${hostingTargetId}' }
      },
      {
        stepKind: 'proxy.ensure-resource',
        provider: 'pangolin',
        params: { hostingTargetId: '${hostingTargetId}' }
      },
      {
        stepKind: 'proxy.ensure-rules',
        provider: 'pangolin',
        params: {
          rules: [
            {
              action: 'ACCEPT',
              match: 'CIDR',
              value: '${bypassAddress}',
              priority: 100
            }
          ]
        }
      },
      {
        stepKind: 'mail.enable',
        provider: 'purelymail',
        params: { mailConnectionId: '${mailConnectionId}' }
      },
      {
        stepKind: 'mail.ensure-mailbox',
        provider: 'purelymail',
        params: { localPart: 'noreply', kind: 'mailbox' }
      }
    ]
  });
  return { id: template.id };
});
