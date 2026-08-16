/**
 * The provisioning-template engine (Pangolin chain design milestone 6,
 * `loxep-acj.6`, "The template engine") — a COMPILER and a DRIVER, never a
 * second workflow engine. The design's own two constraints, restated here
 * because everything below exists only to hold to them:
 *
 * > A template is a strictly ordered list of idempotent steps, each of which
 * > writes intent into a table that already exists and enqueues a task that
 * > already exists.
 * >
 * > The engine compiles and drives. It does not execute provider calls
 * > itself.
 *
 * ## The compiler: `compileTemplate`
 *
 * PURE, deterministic, no I/O: `(templateVersion, steps, inputs)` always
 * compiles to the same {@link CompiledPlan}. Its output is FROZEN into
 * `template_runs.compiled_plan` at run start — "makes a run reproducible
 * after a template edit, makes 'resume' mean the same thing three days
 * later, and lets the UI show the whole ladder — including steps not yet
 * reached." Placeholder substitution (`${inputKey}`) is the ENTIRE
 * templating language, deliberately: no conditionals, no loops, no
 * expressions. "The moment a template needs a conditional, the answer is a
 * second template, not an expression language."
 *
 * ## The driver: `createProvisioningDriver().advance()`
 *
 * `mail-sync.ts`'s shape, generalized to seven step kinds and three
 * providers:
 *
 * ```text
 * load the run and its frozen plan
 * for each step in sequence:
 *     already succeeded (or optional+skipped)?   continue
 *     its structural prerequisite not yet
 *       succeeded (the nearest earlier step this
 *       kind depends on)?                        leave 'pending', continue
 *     otherwise:                                  attempt it, record status
 * mark the run succeeded / partial and return
 * ```
 *
 * "Advance as far as you currently can, record exactly where you stopped,
 * return." A step's own attempt NEVER halts the loop — the design's own
 * worked example shows an unrelated, later step (`mail.enable`) evaluated
 * and correctly `blocked` on the SAME pass that an earlier, independent step
 * (`proxy.ensure-resource`) is `failed`, because the two sit on different
 * provider tracks and neither structurally depends on the other. What DOES
 * stop a step from being attempted is its OWN track's prerequisite not yet
 * having succeeded (`proxy.ensure-rules` cannot run before
 * `proxy.ensure-resource` has) — {@link STEP_DEPENDENCY_PARENT_KIND} encodes
 * exactly that graph, computed once at compile time as
 * `CompiledStep.dependsOnSequence`.
 *
 * ## No step here invents its own evidence
 *
 * Every step_kind dispatches to a service `@loxep/infrastructure` ALREADY
 * ships, and that service's own ordinary `reconcile_runs` row — identical to
 * one an operator's manual action would produce — becomes
 * `template_run_steps.reconcile_run_id`. `mail.enable`'s step IS
 * `runMailDomainSync`; `mail.ensure-mailbox`'s step IS `runMailboxSync`;
 * `dns.point-at-target`/`dns.manual-record` write intent through
 * `ManagedDomainsService` and then drive `RecordSyncService.run()` — the
 * exact call an operator's own "sync now" button makes; `proxy.ensure-
 * resource`/`proxy.ensure-rules` write intent directly into
 * `proxy_resources`/`proxy_resource_rules` (this module's own tables — see
 * "Why this module writes proxy intent directly" below) and drive
 * `ProxyResourcesService.reconcile()`, completely UNCHANGED. `domain.declare`
 * is the one deliberate exception — see its own dispatcher's doc for why it
 * carries no `reconcile_run_id`.
 *
 * ## Why this module writes proxy intent directly, rather than adding a
 * `ProxyResourcesService.declare*` method
 *
 * `proxy.ts` ships NO intent-writing method today (M2/M4 shipped the
 * reconciler and the tier-1 apply leg; declaring a NEW `proxy_resources`
 * row was never built). Milestone 7 (`loxep-acj.7`, retirement-by-disable)
 * is concurrently extending `proxy.ts` and `write-policy.ts` in this same
 * tree. Rather than widen a file under active, unrelated construction, this
 * module writes `proxy_resources`/`proxy_resource_rules` intent rows
 * directly (plain inserts against tables `@loxep/db/schema` already ships)
 * and calls `ProxyResourcesService.reconcile()` — a stable, already-shipped,
 * read-mostly entry point — exactly as an operator's own action would. This
 * satisfies the design's own words precisely: "writes intent into a table
 * that already exists and enqueues [here: drives] a task that already
 * exists" says nothing about which module performs the write.
 *
 * ## Every provider-touching step is TIER 1 (additive) — always
 *
 * The closed seven step kinds compile to creates only: a domain declaration,
 * an apex/manual DNS record, a Pangolin resource, a Pangolin rule, a mail
 * domain registration, a mailbox. No step_kind updates or retires anything,
 * so no template step is ever tier 2 — consistent with "no rollback, ever":
 * every step this design permits is additive or convergent. A future
 * tier-2-capable step_kind would need the typed-confirmation treatment M7
 * builds for retirement; none exists here, and none should be added without
 * that owner-reviewed ceremony.
 *
 * ## `blocked`, not `failed`, and never a silent skip
 *
 * Three prerequisite-absence reasons name a real, upstream gap this design
 * inherited rather than invented — `@loxep/integration-cloudflare` has no
 * zone-create verb, Pangolin's own domain-create endpoint is unstable and
 * undocumented, and a hosting target may simply have no linked proxy
 * connection yet:
 *
 * ```text
 * zone_not_found        no Cloudflare zone resolved for this domain name
 * org_domain_not_found   no Pangolin org-domain id resolved for this resource
 * no_proxy_connection    the hosting target has no linked proxy connection
 * ```
 *
 * Every write-policy-tier refusal — across all three providers, following
 * the design's own framing of the owner's real credentials as uniformly
 * "full-account" rather than narrowly scoped — blocks with `credential_scope`
 * (this module's own `checkTierOnePolicy`, checked BEFORE any provider call,
 * ahead of and in addition to each underlying service's own redundant gate —
 * defense in depth, never a single point of failure for the write-risk
 * model's central promise). Mail's delegation/ownership waits carry their own
 * named reasons (`awaiting_delegation`, `ownership_not_yet_provable`),
 * copied straight from `mail-sync.ts`'s own outcome vocabulary. Every
 * blocked step's `error_detail` names the exact remedy — never a bare code —
 * matching rule 2's own words: *"'credential_scope' alone is useless."*
 *
 * ## No rollback, ever
 *
 * `abandonRun` (a request-scoped admin action, never a worker task — the
 * same "never re-derive an action from within a job" discipline
 * `tokens.ts`'s mint/roll already follow) marks a run `'failed'` and touches
 * NOTHING else: every `template_run_steps` row, every `proxy_resources` row,
 * every mailbox this run created stays exactly as it was. There is no delete
 * path anywhere in this module, because there is no delete verb anywhere in
 * the services it calls.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { LoxepDb } from "@loxep/db";
import {
  PROVISIONING_STEP_KINDS,
  PROVISIONING_STEP_PROVIDERS,
  managedDomains,
  proxyResourceRules,
  proxyResources,
  provisioningTemplateSteps,
  provisioningTemplates,
  reconcileRuns,
  templateRunSteps,
  templateRuns,
  type ProvisioningStepKind,
  type ProvisioningStepProvider,
  type TemplateRunStatus,
} from "@loxep/db/schema";
import {
  createSettingsService,
  providerWritePolicySetting,
  providerWritePolicyTierRank,
  resolveProviderWritePolicy,
} from "@loxep/domain";
import type { SettingsService } from "@loxep/domain";
import {
  createManagedDomainsService,
  type ManagedDomainsService,
  type TransactionalEnqueue,
} from "./domains.ts";
import {
  InfrastructureNotFoundError,
  InfrastructureValidationError,
  ProviderCallError,
} from "./errors.ts";
import { createMailDomainsService, type MailDomainsService } from "./mail.ts";
import {
  createMailSyncService,
  defaultPasswordMinter,
  type MailDomainSyncResult,
  type MailSyncService,
} from "./mail-sync.ts";
import type {
  MailProviderPort,
  MailboxSecretWriter,
  PasswordMinter,
} from "./mail-port.ts";
import type { DnsProviderPort } from "./port.ts";
import { createRecordSyncService, type RunRecordSyncResult } from "./sync.ts";
import type { ProxyProviderPort } from "./proxy-port.ts";
import type {
  ProxyResourcesService,
  ProxyWriteAuthorizationContext,
  ReconcileProxyResourceResult,
} from "./proxy.ts";
import {
  RUN_PROVISIONING_TEMPLATE_TASK,
  provisioningTemplateRunJobKey,
} from "./tasks.ts";

export {
  PROVISIONING_STEP_KINDS,
  PROVISIONING_STEP_PROVIDERS,
} from "@loxep/db/schema";
export type {
  ProvisioningStepKind,
  ProvisioningStepProvider,
  TemplateRunStatus,
  TemplateRunStepStatus,
} from "@loxep/db/schema";

export type ProvisioningTemplateRow = typeof provisioningTemplates.$inferSelect;
export type ProvisioningTemplateStepRow =
  typeof provisioningTemplateSteps.$inferSelect;
export type TemplateRunRow = typeof templateRuns.$inferSelect;
export type TemplateRunStepRow = typeof templateRunSteps.$inferSelect;

/** `reconcile_runs.kind` for one driver PASS's own evidence row — see the module doc's "no step here invents its own evidence" section. */
export const RUN_PROVISIONING_TEMPLATE_RUN_KIND = "run-provisioning-template";

/** `reconcile_runs.subject_type` for that row. */
export const TEMPLATE_RUN_SUBJECT_TYPE = "template_run";

/* =========================================================================
 * The closed step-kind registry: one zod schema per kind.
 * ========================================================================= */

const uuidField = z.string().uuid();

const domainDeclareParamsSchema = z.strictObject({
  name: z.string().trim().min(1).max(253),
  dnsConnectionId: uuidField,
  registrar: z.string().trim().min(1).nullish(),
  mailEnabled: z.boolean().optional(),
});
export type DomainDeclareParams = z.infer<typeof domainDeclareParamsSchema>;

const dnsPointAtTargetParamsSchema = z.strictObject({
  apexTargetId: uuidField,
  apexProxied: z.boolean().optional(),
  wildcardProxied: z.boolean().optional(),
});
export type DnsPointAtTargetParams = z.infer<
  typeof dnsPointAtTargetParamsSchema
>;

const dnsManualRecordParamsSchema = z.strictObject({
  type: z.string().trim().min(1).max(16),
  name: z.string().trim().min(1),
  content: z.string().trim().min(1),
  ttlSeconds: z.number().int().positive().nullish(),
  priority: z.number().int().nonnegative().nullish(),
  proxied: z.boolean().optional(),
});
export type DnsManualRecordParams = z.infer<
  typeof dnsManualRecordParamsSchema
>;

const PROXY_RESOURCE_MODE_VALUES = [
  "http",
  "ssh",
  "rdp",
  "vnc",
  "tcp",
  "udp",
] as const;

const proxyEnsureResourceParamsSchema = z.strictObject({
  /** `null`/absent = the domain's apex, matching `proxy_resources.subdomain`'s own convention. */
  subdomain: z.string().trim().min(1).max(63).nullish(),
  hostingTargetId: uuidField,
  mode: z.enum(PROXY_RESOURCE_MODE_VALUES).optional(),
  proxyPort: z.number().int().min(1).max(65535).nullish(),
  ssl: z.boolean().optional(),
  /**
   * Pangolin's own org-scoped domain id, pre-resolved by the operator —
   * `PUT /org/{orgId}/domain` is undocumented, unspecced, and edition-
   * restricted (the design's own verdict), so this module never resolves
   * one itself. Absent/`null` BLOCKS the step, matching the Cloudflare-zone
   * precedent exactly: no create verb exists, so the step resolves and
   * blocks rather than guessing.
   */
  externalDomainId: z.string().trim().min(1).nullish(),
});
export type ProxyEnsureResourceParams = z.infer<
  typeof proxyEnsureResourceParamsSchema
>;

const PROXY_RULE_ACTION_VALUES = ["ACCEPT", "DROP", "PASS"] as const;
const PROXY_RULE_MATCH_VALUES = [
  "CIDR",
  "IP",
  "PATH",
  "COUNTRY",
  "COUNTRY_IS_NOT",
  "ASN",
  "REGION",
] as const;

const proxyRuleParamsSchema = z.strictObject({
  action: z.enum(PROXY_RULE_ACTION_VALUES),
  match: z.enum(PROXY_RULE_MATCH_VALUES),
  value: z.string().trim().min(1),
  priority: z.number().int().nonnegative(),
});

const proxyEnsureRulesParamsSchema = z.strictObject({
  /** Which `proxy.ensure-resource` step's resource these rules belong to — must match its `subdomain`. */
  subdomain: z.string().trim().min(1).max(63).nullish(),
  rules: z.array(proxyRuleParamsSchema).min(1),
});
export type ProxyEnsureRulesParams = z.infer<
  typeof proxyEnsureRulesParamsSchema
>;

const mailEnableParamsSchema = z.strictObject({
  mailConnectionId: uuidField,
});
export type MailEnableParams = z.infer<typeof mailEnableParamsSchema>;

const mailboxKindSchema = z.enum(["mailbox", "alias", "catchall"]);

const mailEnsureMailboxParamsSchema = z.strictObject({
  localPart: z.string().trim().min(1).max(64),
  kind: mailboxKindSchema,
  forwardTo: z.string().trim().min(3).nullish(),
});
export type MailEnsureMailboxParams = z.infer<
  typeof mailEnsureMailboxParamsSchema
>;

/**
 * One zod schema per {@link ProvisioningStepKind} — the monitor-target
 * discipline (`@loxep/market`'s `MONITOR_TARGET_TYPES` +
 * `monitorTargetConfigSchemas`) applied to this closed union. `satisfies`
 * makes the compiler enforce totality: adding an eighth `step_kind` to the
 * database `CHECK` without adding its schema here fails to typecheck, never
 * silently reaches a runtime `switch` with no `default` arm.
 */
export const provisioningStepParamsSchemas = {
  "domain.declare": domainDeclareParamsSchema,
  "dns.point-at-target": dnsPointAtTargetParamsSchema,
  "dns.manual-record": dnsManualRecordParamsSchema,
  "proxy.ensure-resource": proxyEnsureResourceParamsSchema,
  "proxy.ensure-rules": proxyEnsureRulesParamsSchema,
  "mail.enable": mailEnableParamsSchema,
  "mail.ensure-mailbox": mailEnsureMailboxParamsSchema,
} as const satisfies Record<ProvisioningStepKind, z.ZodType>;

/**
 * The nearest EARLIER step kind each step_kind structurally depends on —
 * `null` means "an independent track, no dependency". Closed and total over
 * {@link PROVISIONING_STEP_KINDS}; see the compiler doc for how this becomes
 * `CompiledStep.dependsOnSequence`.
 */
const STEP_DEPENDENCY_PARENT_KIND: Record<
  ProvisioningStepKind,
  ProvisioningStepKind | null
> = {
  "domain.declare": null,
  "dns.point-at-target": "domain.declare",
  "dns.manual-record": "domain.declare",
  "proxy.ensure-resource": "domain.declare",
  "proxy.ensure-rules": "proxy.ensure-resource",
  "mail.enable": "domain.declare",
  "mail.ensure-mailbox": "mail.enable",
};

/* =========================================================================
 * The compiler.
 * ========================================================================= */

export interface TemplateStepDefinitionInput {
  sequence: number;
  stepKind: ProvisioningStepKind;
  provider: ProvisioningStepProvider | null;
  params: unknown;
  optional: boolean;
}

export interface CompiledStep {
  sequence: number;
  stepKind: ProvisioningStepKind;
  provider: ProvisioningStepProvider | null;
  /** VALIDATED and NORMALIZED — every `${placeholder}` already resolved. */
  params: Record<string, unknown>;
  optional: boolean;
  /** The `sequence` of the step this one structurally depends on, or `null`. */
  dependsOnSequence: number | null;
}

export interface CompiledPlan {
  steps: CompiledStep[];
}

const PLACEHOLDER_PATTERN = /^\$\{([a-zA-Z0-9_]+)\}$/;

/**
 * The ENTIRE templating language: a string of the exact shape `${inputKey}`
 * (whole-string match, at any depth) is replaced by `inputs[inputKey]`.
 * Nothing else is interpreted — no concatenation, no conditionals, no
 * expressions. A referenced input that was not supplied fails to COMPILE,
 * never reaches a provider call with an `undefined` hole in it.
 */
function substitutePlaceholders(
  value: unknown,
  inputs: Record<string, unknown>,
): unknown {
  if (typeof value === "string") {
    const match = PLACEHOLDER_PATTERN.exec(value);
    if (match === null) return value;
    const key = match[1] as string;
    if (!Object.hasOwn(inputs, key)) {
      throw new InfrastructureValidationError(
        `template input "${key}" was not supplied`,
        { key },
      );
    }
    return inputs[key];
  }
  if (Array.isArray(value)) {
    return value.map((entry) => substitutePlaceholders(entry, inputs));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = substitutePlaceholders(entry, inputs);
    }
    return out;
  }
  return value;
}

/**
 * Compiles a template's step DEFINITIONS plus the operator's inputs into a
 * FROZEN {@link CompiledPlan}. PURE and deterministic — no clock, no I/O, no
 * randomness — which is what "frozen" means: a caller may persist the result
 * and never re-run this function against it. See the module doc for the full
 * account.
 *
 * `dependsOnSequence` is computed here, once, from
 * {@link STEP_DEPENDENCY_PARENT_KIND}: the nearest EARLIER step of the
 * required parent kind. A step whose parent kind never appears earlier in the
 * list is a MALFORMED template (`proxy.ensure-rules` with no preceding
 * `proxy.ensure-resource`) and fails to compile, rather than compiling into a
 * plan the driver could never advance past `pending`.
 */
export function compileTemplate(input: {
  templateVersion: number;
  steps: readonly TemplateStepDefinitionInput[];
  inputs: Record<string, unknown>;
}): CompiledPlan {
  const ordered = [...input.steps].sort((a, b) => a.sequence - b.sequence);
  const compiled: CompiledStep[] = [];
  const lastSequenceByKind = new Map<ProvisioningStepKind, number>();

  for (const step of ordered) {
    const schema = provisioningStepParamsSchemas[step.stepKind];
    const substituted = substitutePlaceholders(step.params, input.inputs);
    const parsed = schema.parse(substituted) as Record<string, unknown>;

    const parentKind = STEP_DEPENDENCY_PARENT_KIND[step.stepKind];
    let dependsOnSequence: number | null = null;
    if (parentKind !== null) {
      const parentSequence = lastSequenceByKind.get(parentKind);
      if (parentSequence === undefined) {
        throw new InfrastructureValidationError(
          `step ${step.sequence} ("${step.stepKind}") has no preceding "${parentKind}" step in this template`,
          {
            sequence: step.sequence,
            stepKind: step.stepKind,
            requiredParentKind: parentKind,
          },
        );
      }
      dependsOnSequence = parentSequence;
    }

    compiled.push({
      sequence: step.sequence,
      stepKind: step.stepKind,
      provider: step.provider,
      params: parsed,
      optional: step.optional,
      dependsOnSequence,
    });
    lastSequenceByKind.set(step.stepKind, step.sequence);
  }

  return { steps: compiled };
}

/**
 * Every `${inputKey}` referenced anywhere across a template's step
 * DEFINITIONS, in first-appearance order — what the run wizard needs to know
 * which inputs to ask the operator for, without hand-authoring a form per
 * template. PURE, and deliberately permissive about UNKNOWN keys the way
 * `compileTemplate` is not: this function never validates that a key is
 * actually supplied, it only discovers which ones a template's own authors
 * wrote — the wizard renders one field per key, and `compileTemplate` is
 * still what refuses a genuinely missing one at run start.
 */
export function extractTemplateInputKeys(
  steps: readonly TemplateStepDefinitionInput[],
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      const match = PLACEHOLDER_PATTERN.exec(value);
      if (match !== null) {
        const key = match[1] as string;
        if (!seen.has(key)) {
          seen.add(key);
          ordered.push(key);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const entry of Object.values(value as Record<string, unknown>)) {
        walk(entry);
      }
    }
  };

  for (const step of [...steps].sort((a, b) => a.sequence - b.sequence)) {
    walk(step.params);
  }
  return ordered;
}

function findAncestorDomainName(
  plan: CompiledPlan,
  step: CompiledStep,
): string {
  let current: CompiledStep | undefined = step;
  while (current !== undefined) {
    if (current.stepKind === "domain.declare") {
      const name = current.params["name"];
      if (typeof name === "string") return name;
      break;
    }
    const parentSequence: number | null = current.dependsOnSequence;
    current =
      parentSequence === null
        ? undefined
        : plan.steps.find((s) => s.sequence === parentSequence);
  }
  throw new InfrastructureValidationError(
    `step ${step.sequence} ("${step.stepKind}") has no reachable "domain.declare" ancestor — invariant violated by the compiler`,
    { sequence: step.sequence, stepKind: step.stepKind },
  );
}

/* =========================================================================
 * Template CRUD + starting a run.
 * ========================================================================= */

const createTemplateStepInputSchema = z.strictObject({
  stepKind: z.enum(PROVISIONING_STEP_KINDS),
  provider: z.enum(PROVISIONING_STEP_PROVIDERS).nullish(),
  /** MAY contain `${inputKey}` placeholders — validated only at COMPILE time, after substitution. */
  params: z.record(z.string(), z.unknown()),
  optional: z.boolean().optional(),
});
export type CreateTemplateStepInput = z.input<
  typeof createTemplateStepInputSchema
>;

const createTemplateInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).nullish(),
  isDefault: z.boolean().optional(),
  steps: z.array(createTemplateStepInputSchema).min(1),
  createdByUserId: z.string().min(1).nullish(),
});
export type CreateProvisioningTemplateInput = z.input<
  typeof createTemplateInputSchema
>;

export interface StartTemplateRunInput {
  templateId: string;
  inputs: Record<string, unknown>;
  actorUserId?: string | null;
}

export interface ProvisioningTemplatesService {
  create(
    input: CreateProvisioningTemplateInput,
  ): Promise<ProvisioningTemplateRow>;
  get(id: string): Promise<ProvisioningTemplateRow>;
  list(): Promise<ProvisioningTemplateRow[]>;
  findDefault(): Promise<ProvisioningTemplateRow | null>;
  listSteps(templateId: string): Promise<ProvisioningTemplateStepRow[]>;
  /**
   * Replaces a template's ENTIRE step list and bumps `version` — the
   * DDL sketch's own words: "version bumped on every edit." A running or
   * `'partial'` template run is unaffected: it already froze its own
   * `compiled_plan` at start and never re-reads `provisioning_template_steps`
   * — this is what makes "resume" mean the same thing three days later even
   * across an intervening template edit.
   */
  replaceSteps(
    templateId: string,
    steps: readonly CreateTemplateStepInput[],
  ): Promise<ProvisioningTemplateRow>;
  /** PURE preview: compiles WITHOUT writing a run row — the wizard's MANDATORY plan-preview step. */
  previewRun(
    templateId: string,
    inputs: Record<string, unknown>,
  ): Promise<CompiledPlan>;
  /**
   * Compiles, freezes, writes `template_runs`/`template_run_steps`, and
   * enqueues the driver task — then returns, per the design's own "write
   * intent and enqueue, then redirect" rule. Never drives a single step
   * itself.
   */
  startRun(input: StartTemplateRunInput): Promise<TemplateRunRow>;
  getRun(id: string): Promise<TemplateRunRow>;
  listRuns(templateId?: string): Promise<TemplateRunRow[]>;
  listRunSteps(runId: string): Promise<TemplateRunStepRow[]>;
  /**
   * "Abandon": marks the run `'failed'` and touches NOTHING else — no
   * rollback, ever. A request-scoped admin action, never a worker task (the
   * same discipline `tokens.ts`'s mint/roll already follow), because
   * re-deriving "abandon this run" from inside a job would need the job to
   * receive an operator's live decision, which is exactly the shape ADR-0022
   * already ruled out for a mint's reveal-once secret.
   */
  abandonRun(
    runId: string,
    options?: { actorUserId?: string | null },
  ): Promise<TemplateRunRow>;
}

function toStepDefinitionInput(
  row: ProvisioningTemplateStepRow,
): TemplateStepDefinitionInput {
  return {
    sequence: row.sequence,
    stepKind: row.stepKind as ProvisioningStepKind,
    provider: row.provider as ProvisioningStepProvider | null,
    params: row.params,
    optional: row.optional,
  };
}

export function createProvisioningTemplatesService(options: {
  db: LoxepDb;
  enqueue?: TransactionalEnqueue;
}): ProvisioningTemplatesService {
  const { db } = options;
  const enqueue: TransactionalEnqueue =
    options.enqueue ?? (async () => undefined);

  async function requireTemplate(
    executor: Pick<LoxepDb, "select">,
    id: string,
  ): Promise<ProvisioningTemplateRow> {
    const rows = await executor
      .select()
      .from(provisioningTemplates)
      .where(eq(provisioningTemplates.id, id));
    const row = rows[0];
    if (row === undefined) {
      throw new InfrastructureNotFoundError(
        `provisioning template ${id} not found`,
        { id },
      );
    }
    return row;
  }

  async function requireRunRow(
    executor: Pick<LoxepDb, "select">,
    id: string,
  ): Promise<TemplateRunRow> {
    const rows = await executor
      .select()
      .from(templateRuns)
      .where(eq(templateRuns.id, id));
    const row = rows[0];
    if (row === undefined) {
      throw new InfrastructureNotFoundError(`template run ${id} not found`, {
        id,
      });
    }
    return row;
  }

  async function listStepRows(
    executor: Pick<LoxepDb, "select">,
    templateId: string,
  ): Promise<ProvisioningTemplateStepRow[]> {
    return executor
      .select()
      .from(provisioningTemplateSteps)
      .where(eq(provisioningTemplateSteps.templateId, templateId))
      .orderBy(asc(provisioningTemplateSteps.sequence));
  }

  return {
    async create(input) {
      const parsed = createTemplateInputSchema.parse(input);

      return db.transaction(async (tx) => {
        const rows = await tx
          .insert(provisioningTemplates)
          .values({
            name: parsed.name,
            description: parsed.description ?? null,
            isDefault: parsed.isDefault ?? false,
            createdByUserId: parsed.createdByUserId ?? null,
          })
          .returning();
        const template = rows[0];
        if (template === undefined) {
          throw new Error("provisioning template insert returned no row");
        }

        for (const [index, step] of parsed.steps.entries()) {
          await tx.insert(provisioningTemplateSteps).values({
            templateId: template.id,
            sequence: index,
            stepKind: step.stepKind,
            provider: step.provider ?? null,
            params: step.params,
            optional: step.optional ?? false,
          });
        }

        return template;
      });
    },

    async get(id) {
      return requireTemplate(db, id);
    },

    async list() {
      return db
        .select()
        .from(provisioningTemplates)
        .orderBy(asc(provisioningTemplates.name));
    },

    async findDefault() {
      const rows = await db
        .select()
        .from(provisioningTemplates)
        .where(eq(provisioningTemplates.isDefault, true));
      return rows[0] ?? null;
    },

    async listSteps(templateId) {
      return listStepRows(db, templateId);
    },

    async replaceSteps(templateId, steps) {
      const parsedSteps = steps.map((step) =>
        createTemplateStepInputSchema.parse(step),
      );

      return db.transaction(async (tx) => {
        await requireTemplate(tx, templateId);
        await tx
          .delete(provisioningTemplateSteps)
          .where(eq(provisioningTemplateSteps.templateId, templateId));

        for (const [index, step] of parsedSteps.entries()) {
          await tx.insert(provisioningTemplateSteps).values({
            templateId,
            sequence: index,
            stepKind: step.stepKind,
            provider: step.provider ?? null,
            params: step.params,
            optional: step.optional ?? false,
          });
        }

        const rows = await tx
          .update(provisioningTemplates)
          .set({
            version: sql`${provisioningTemplates.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(provisioningTemplates.id, templateId))
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new Error("provisioning template version bump returned no row");
        }
        return row;
      });
    },

    async previewRun(templateId, inputs) {
      const template = await requireTemplate(db, templateId);
      const steps = await listStepRows(db, templateId);
      return compileTemplate({
        templateVersion: template.version,
        steps: steps.map(toStepDefinitionInput),
        inputs,
      });
    },

    async startRun({ templateId, inputs, actorUserId }) {
      const template = await requireTemplate(db, templateId);
      const steps = await listStepRows(db, templateId);
      const plan = compileTemplate({
        templateVersion: template.version,
        steps: steps.map(toStepDefinitionInput),
        inputs,
      });

      return db.transaction(async (tx) => {
        const runRows = await tx
          .insert(templateRuns)
          .values({
            templateId,
            templateVersion: template.version,
            inputs,
            compiledPlan: plan,
            status: "running",
            actorUserId: actorUserId ?? null,
          })
          .returning();
        const run = runRows[0];
        if (run === undefined) {
          throw new Error("template run insert returned no row");
        }

        for (const step of plan.steps) {
          await tx.insert(templateRunSteps).values({
            runId: run.id,
            sequence: step.sequence,
            stepKind: step.stepKind,
            provider: step.provider,
            status: "pending",
          });
        }

        // Same transaction. `preserve_run_at`: see `tasks.ts`'s own doc for
        // why re-enqueueing on resume must not reset a days-long wait.
        await enqueue(
          tx,
          RUN_PROVISIONING_TEMPLATE_TASK,
          { runId: run.id },
          {
            jobKey: provisioningTemplateRunJobKey(run.id),
            jobKeyMode: "preserve_run_at",
          },
        );

        return run;
      });
    },

    async getRun(id) {
      return requireRunRow(db, id);
    },

    async listRuns(templateId) {
      if (templateId === undefined) {
        return db
          .select()
          .from(templateRuns)
          .orderBy(asc(templateRuns.startedAt));
      }
      return db
        .select()
        .from(templateRuns)
        .where(eq(templateRuns.templateId, templateId))
        .orderBy(asc(templateRuns.startedAt));
    },

    async listRunSteps(runId) {
      return db
        .select()
        .from(templateRunSteps)
        .where(eq(templateRunSteps.runId, runId))
        .orderBy(asc(templateRunSteps.sequence));
    },

    async abandonRun(runId, abandonOptions) {
      const run = await requireRunRow(db, runId);
      // Idempotent: abandoning an already-terminal run is a no-op, not an
      // error — the same "make it so" tolerance `enableMail` extends to a
      // repeated enable.
      if (run.status === "succeeded" || run.status === "failed") return run;

      return db.transaction(async (tx) => {
        const rows = await tx
          .update(templateRuns)
          .set({ status: "failed", finishedAt: new Date() })
          .where(eq(templateRuns.id, runId))
          .returning();
        const updated = rows[0];
        if (updated === undefined) {
          throw new Error("template run update returned no row");
        }

        // The driver-pass evidence row — see the module doc. NO
        // `template_run_steps` row is touched: every step's own status stays
        // exactly as it was. That IS "no rollback."
        await tx.insert(reconcileRuns).values({
          kind: RUN_PROVISIONING_TEMPLATE_RUN_KIND,
          subjectType: TEMPLATE_RUN_SUBJECT_TYPE,
          subjectId: runId,
          mode: "apply",
          trigger: "manual",
          status: "failed",
          finishedAt: new Date(),
          errorSummary:
            "abandoned by the operator — everything this run created stays in place; there is no rollback",
          actorUserId: abandonOptions?.actorUserId ?? null,
        });

        return updated;
      });
    },
  };
}

/* =========================================================================
 * The driver.
 * ========================================================================= */

interface StepOutcome {
  status: "succeeded" | "blocked" | "failed";
  blockedReason?: string;
  errorCode?: string;
  errorDetail?: string;
  reconcileRunId?: string | null;
  providerOperationKey?: string | null;
}

interface DispatchContext {
  actorUserId: string | null;
  actorIsAdmin: boolean | undefined;
}

/**
 * What the driver needs resolved from a connection or hosting target — the
 * SAME "resolve the provider per subject, never per installation" discipline
 * `container-hosts.ts`/`proxy.ts` already document, applied here at the
 * template-step granularity.
 */
export interface ProvisioningProviders {
  resolveDnsProvider(connectionId: string): Promise<DnsProviderPort>;
  resolveMailProvider(connectionId: string): Promise<MailProviderPort>;
  /** `null` = no proxy connection is linked from this hosting target. Mirrors `ProxyResourcesService.reconcileDomain`'s own `resolveProvider` shape exactly. */
  resolveProxyProvider(hostingTargetId: string): Promise<{
    provider: ProxyProviderPort;
    orgId: string;
    writeAuthorization?: ProxyWriteAuthorizationContext;
  } | null>;
}

export interface AdvanceRunOptions {
  actorUserId?: string | null;
  actorIsAdmin?: boolean;
}

export interface ProvisioningDriver {
  /**
   * Advance a run as far as it currently can go, record exactly where it
   * stopped, and return the settled row (`'succeeded'` or `'partial'`).
   * Never throws for a CLASSIFIED failure (a `ProviderCallError`, an invalid
   * step) — those become a `'failed'`/`'blocked'` step and the loop
   * continues to the next independent step. Rethrows only a genuinely
   * unexpected error, after marking the run `'failed'` — the same "a real
   * fault propagates so the job's backoff applies" rule every reconciler in
   * this package already follows.
   */
  advance(runId: string, options?: AdvanceRunOptions): Promise<TemplateRunRow>;
}

export interface CreateProvisioningDriverOptions {
  db: LoxepDb;
  proxyResourceService: ProxyResourcesService;
  providers: ProvisioningProviders;
  secrets: MailboxSecretWriter;
  /** Defaults to `mail-sync.ts`'s `defaultPasswordMinter`. */
  mintPassword?: PasswordMinter;
  /** Defaults to `createSettingsService({ db })`. Overridable for tests. */
  settings?: SettingsService;
}

export function createProvisioningDriver(
  options: CreateProvisioningDriverOptions,
): ProvisioningDriver {
  const { db, proxyResourceService, providers, secrets } = options;
  const mintPassword = options.mintPassword ?? defaultPasswordMinter;
  const settings = options.settings ?? createSettingsService({ db });

  async function requireRun(id: string): Promise<TemplateRunRow> {
    const rows = await db
      .select()
      .from(templateRuns)
      .where(eq(templateRuns.id, id));
    const row = rows[0];
    if (row === undefined) {
      throw new InfrastructureNotFoundError(`template run ${id} not found`, {
        id,
      });
    }
    return row;
  }

  async function loadStepRows(
    runId: string,
  ): Promise<Map<number, TemplateRunStepRow>> {
    const rows = await db
      .select()
      .from(templateRunSteps)
      .where(eq(templateRunSteps.runId, runId))
      .orderBy(asc(templateRunSteps.sequence));
    return new Map(rows.map((row) => [row.sequence, row]));
  }

  async function updateStepRow(
    id: string,
    outcome: StepOutcome,
  ): Promise<void> {
    await db
      .update(templateRunSteps)
      .set({
        status: outcome.status,
        blockedReason: outcome.blockedReason ?? null,
        errorCode: outcome.errorCode ?? null,
        errorDetail: outcome.errorDetail ?? null,
        reconcileRunId: outcome.reconcileRunId ?? null,
        providerOperationKey: outcome.providerOperationKey ?? null,
        occurredAt: new Date(),
      })
      .where(eq(templateRunSteps.id, id));
  }

  /**
   * The write-authorization pre-check EVERY provider-touching step passes
   * through, ahead of and in addition to the underlying service's own
   * (redundant) gate — see the module doc's "defense in depth" note.
   * `'credential_scope'` uniformly, across all three providers — see the
   * module doc for why.
   */
  async function checkTierOnePolicy(connectionId: string): Promise<boolean> {
    const policies = await settings.get(providerWritePolicySetting);
    const tier = resolveProviderWritePolicy(policies, connectionId);
    return providerWritePolicyTierRank(tier) >= 1;
  }

  async function requireManagedDomainByName(
    managedDomainsService: ManagedDomainsService,
    name: string,
  ) {
    const domain = await managedDomainsService.findByName(name);
    if (domain === null) {
      throw new InfrastructureNotFoundError(
        `managed domain "${name}" not found (invariant: its "domain.declare" step must have already succeeded)`,
        { name },
      );
    }
    return domain;
  }

  /* ------------------------------------------------------- domain.declare */

  /**
   * `managedDomains.create` (or find-by-name, idempotent) plus the ONE
   * genuinely new resolve-and-block prerequisite this closed vocabulary
   * needs: `@loxep/integration-cloudflare` has no zone-create verb, so this
   * step RESOLVES the Cloudflare zone (a tier-0 READ, always permitted — no
   * write-policy check needed) and blocks if absent, exactly the design's
   * own words for this exact gap.
   *
   * Carries NO `reconcile_run_id`, deliberately: declaring a domain has no
   * reconciler run of its own to be evidence of — it is a pure Loxep intent
   * write (plus one provider READ). The first real reconcile evidence in
   * this template appears at the NEXT step, `dns.point-at-target`, which
   * drives the same `RecordSyncService.run()` an operator's own "sync now"
   * button would.
   */
  async function dispatchDomainDeclare(
    params: DomainDeclareParams,
    ctx: DispatchContext,
  ): Promise<StepOutcome> {
    const managedDomainsService = createManagedDomainsService({ db });
    let domain = await managedDomainsService.findByName(params.name);
    if (domain === null) {
      domain = await managedDomainsService.create({
        name: params.name,
        dnsConnectionId: params.dnsConnectionId,
        registrar: params.registrar ?? undefined,
        mailEnabled: params.mailEnabled,
        createdByUserId: ctx.actorUserId ?? undefined,
      });
    }

    if (domain.externalZoneId !== null) {
      return { status: "succeeded" };
    }

    const dnsProvider = await providers.resolveDnsProvider(
      params.dnsConnectionId,
    );
    const zone = await dnsProvider.findZoneByName(params.name);
    if (zone === null) {
      return {
        status: "blocked",
        blockedReason: "zone_not_found",
        errorDetail: `no Cloudflare zone was found for "${params.name}" — create or confirm the zone in Cloudflare's dashboard, then resume this run.`,
      };
    }

    // `provider_zone_status` closes a small, honestly-named gap: nothing in
    // this package writes it today (`tasks.ts`'s own doc lists
    // `poll-delegation` among the deferred tasks that would normally own
    // this write) — but THIS step already holds the provider's own zone
    // status at the exact moment it resolves the zone, and
    // `isDelegationConfirmed` (`mail-sync.ts`) reads exactly this column as
    // one of its two sufficient signals. Recording it here, honestly, is
    // what lets `mail.enable` reach its OWN gate (write policy) instead of
    // sitting behind a delegation wait nothing ever confirmed.
    await db
      .update(managedDomains)
      .set({
        externalZoneId: zone.externalZoneId,
        providerZoneStatus: zone.status,
        updatedAt: new Date(),
      })
      .where(eq(managedDomains.id, domain.id));
    return { status: "succeeded" };
  }

  /* ------------------------------------------------- dns.point-at-target */

  function classifyReconcileOutcome(
    result: RunRecordSyncResult,
  ): StepOutcome {
    if (result.writePolicyBlockedReason !== null) {
      return {
        status: "blocked",
        blockedReason: "credential_scope",
        errorDetail:
          "the Cloudflare connection's write policy blocks this apply — allow writes for this connection on /settings/connections, then resume this run.",
        reconcileRunId: result.runId,
      };
    }
    if (result.status === "failed") {
      return {
        status: "failed",
        errorCode: "provider_unavailable",
        errorDetail:
          "the DNS record sync run failed — see the linked reconcile run for detail.",
        reconcileRunId: result.runId,
      };
    }
    return { status: "succeeded", reconcileRunId: result.runId };
  }

  async function dispatchDnsPointAtTarget(
    plan: CompiledPlan,
    step: CompiledStep,
    params: DnsPointAtTargetParams,
    ctx: DispatchContext,
  ): Promise<StepOutcome> {
    const managedDomainsService = createManagedDomainsService({ db });
    const domainName = findAncestorDomainName(plan, step);
    const domain = await requireManagedDomainByName(
      managedDomainsService,
      domainName,
    );

    const permitted = await checkTierOnePolicy(domain.dnsConnectionId);
    if (!permitted) {
      return {
        status: "blocked",
        blockedReason: "credential_scope",
        errorDetail:
          "the Cloudflare connection's write policy blocks this apply — allow writes for this connection on /settings/connections, then resume this run.",
      };
    }

    await managedDomainsService.updateIntent(domain.id, {
      apexTargetId: params.apexTargetId,
      apexProxied: params.apexProxied,
      wildcardProxied: params.wildcardProxied,
      actorUserId: ctx.actorUserId ?? undefined,
    });

    const dnsProvider = await providers.resolveDnsProvider(
      domain.dnsConnectionId,
    );
    const sync = createRecordSyncService({
      db,
      provider: dnsProvider,
      connectionId: domain.dnsConnectionId,
      settings,
    });
    const result = await sync.run({
      domainId: domain.id,
      mode: "apply",
      trigger: "intent_change",
      actorUserId: ctx.actorUserId,
      actorIsAdmin: ctx.actorIsAdmin,
    });
    return classifyReconcileOutcome(result);
  }

  /* -------------------------------------------------- dns.manual-record */

  async function dispatchDnsManualRecord(
    plan: CompiledPlan,
    step: CompiledStep,
    params: DnsManualRecordParams,
    ctx: DispatchContext,
  ): Promise<StepOutcome> {
    const managedDomainsService = createManagedDomainsService({ db });
    const domainName = findAncestorDomainName(plan, step);
    const domain = await requireManagedDomainByName(
      managedDomainsService,
      domainName,
    );

    const permitted = await checkTierOnePolicy(domain.dnsConnectionId);
    if (!permitted) {
      return {
        status: "blocked",
        blockedReason: "credential_scope",
        errorDetail:
          "the Cloudflare connection's write policy blocks this apply — allow writes for this connection on /settings/connections, then resume this run.",
      };
    }

    await managedDomainsService.addManualRecord(
      domain.id,
      {
        type: params.type,
        name: params.name,
        content: params.content,
        ttlSeconds: params.ttlSeconds ?? null,
        priority: params.priority ?? null,
        proxied: params.proxied ?? false,
      },
      { actorUserId: ctx.actorUserId },
    );

    const dnsProvider = await providers.resolveDnsProvider(
      domain.dnsConnectionId,
    );
    const sync = createRecordSyncService({
      db,
      provider: dnsProvider,
      connectionId: domain.dnsConnectionId,
      settings,
    });
    const result = await sync.run({
      domainId: domain.id,
      mode: "apply",
      trigger: "intent_change",
      actorUserId: ctx.actorUserId,
      actorIsAdmin: ctx.actorIsAdmin,
    });
    return classifyReconcileOutcome(result);
  }

  /* ----------------------------------------------- proxy.ensure-resource */

  function classifyProxyOutcome(
    result: ReconcileProxyResourceResult,
  ): StepOutcome {
    if (result.status === "skipped") {
      return {
        status: "blocked",
        blockedReason: "no_proxy_connection",
        errorDetail:
          "the hosting target's proxy connection could not be resolved — link a Pangolin connection on its fleet-detail page, then resume this run.",
      };
    }
    if (result.status === "failed") {
      return {
        status: "failed",
        errorCode: "provider_unavailable",
        errorDetail:
          "the Pangolin reconcile run failed — see the linked reconcile run for detail.",
        reconcileRunId: result.runId,
      };
    }
    if (result.status === "partial") {
      return {
        status: "blocked",
        blockedReason: "credential_scope",
        errorDetail:
          "the Pangolin connection's write policy blocks this apply — allow writes for this connection on /settings/connections, then resume this run.",
        reconcileRunId: result.runId,
      };
    }
    return { status: "succeeded", reconcileRunId: result.runId };
  }

  async function findProxyResourceRow(domainId: string, subdomain: string | null) {
    const rows = await db
      .select()
      .from(proxyResources)
      .where(
        and(
          eq(proxyResources.domainId, domainId),
          subdomain === null
            ? isNull(proxyResources.subdomain)
            : eq(proxyResources.subdomain, subdomain),
        ),
      );
    return rows[0] ?? null;
  }

  async function dispatchProxyEnsureResource(
    plan: CompiledPlan,
    step: CompiledStep,
    params: ProxyEnsureResourceParams,
    ctx: DispatchContext,
  ): Promise<StepOutcome> {
    const managedDomainsService = createManagedDomainsService({ db });
    const domainName = findAncestorDomainName(plan, step);
    const domain = await requireManagedDomainByName(
      managedDomainsService,
      domainName,
    );

    const resolved = await providers.resolveProxyProvider(
      params.hostingTargetId,
    );
    if (resolved === null) {
      return {
        status: "blocked",
        blockedReason: "no_proxy_connection",
        errorDetail:
          "the hosting target has no linked Pangolin connection — link one on its fleet-detail page, then resume this run.",
      };
    }
    const policyTier = resolved.writeAuthorization?.policyTier;
    if (
      policyTier === undefined ||
      providerWritePolicyTierRank(policyTier) < 1
    ) {
      return {
        status: "blocked",
        blockedReason: "credential_scope",
        errorDetail:
          "the Pangolin connection's write policy blocks this apply — allow writes for this connection on /settings/connections, then resume this run.",
      };
    }

    const subdomain = params.subdomain ?? null;
    // Declare the intent row directly — see the module doc's "why this
    // module writes proxy intent directly" section.
    let resourceRow = await findProxyResourceRow(domain.id, subdomain);
    if (resourceRow === null) {
      const inserted = await db
        .insert(proxyResources)
        .values({
          domainId: domain.id,
          hostingTargetId: params.hostingTargetId,
          subdomain,
          mode: params.mode ?? "http",
          proxyPort: params.proxyPort ?? null,
          ssl: params.ssl ?? true,
          externalDomainId: params.externalDomainId ?? null,
          createdByUserId: ctx.actorUserId,
        })
        .returning();
      resourceRow = inserted[0] ?? null;
      if (resourceRow === null) {
        throw new Error("proxy_resources insert returned no row");
      }
    } else if (
      resourceRow.externalDomainId === null &&
      params.externalDomainId !== undefined &&
      params.externalDomainId !== null
    ) {
      await db
        .update(proxyResources)
        .set({
          externalDomainId: params.externalDomainId,
          updatedAt: new Date(),
        })
        .where(eq(proxyResources.id, resourceRow.id));
      resourceRow = { ...resourceRow, externalDomainId: params.externalDomainId };
    }

    if (resourceRow.externalDomainId === null) {
      return {
        status: "blocked",
        blockedReason: "org_domain_not_found",
        errorDetail: `no Pangolin org-domain id is resolved for "${domainName}" — add/confirm the org domain in the Pangolin dashboard, record its id, then resume this run.`,
      };
    }

    const result = await proxyResourceService.reconcile(resourceRow.id, {
      mode: "apply",
      trigger: "intent_change",
      provider: resolved.provider,
      orgId: resolved.orgId,
      actorUserId: ctx.actorUserId,
      writeAuthorization: resolved.writeAuthorization,
    });
    return classifyProxyOutcome(result);
  }

  /* -------------------------------------------------- proxy.ensure-rules */

  async function dispatchProxyEnsureRules(
    plan: CompiledPlan,
    step: CompiledStep,
    params: ProxyEnsureRulesParams,
    ctx: DispatchContext,
  ): Promise<StepOutcome> {
    const managedDomainsService = createManagedDomainsService({ db });
    const domainName = findAncestorDomainName(plan, step);
    const domain = await requireManagedDomainByName(
      managedDomainsService,
      domainName,
    );

    const subdomain = params.subdomain ?? null;
    const resourceRow = await findProxyResourceRow(domain.id, subdomain);
    if (resourceRow === null) {
      throw new InfrastructureNotFoundError(
        `no proxy resource declared for domain "${domainName}" subdomain ${subdomain ?? "@"} (invariant: its "proxy.ensure-resource" step must have already succeeded)`,
        { domainName, subdomain },
      );
    }

    const resolved = await providers.resolveProxyProvider(
      resourceRow.hostingTargetId,
    );
    if (resolved === null) {
      return {
        status: "blocked",
        blockedReason: "no_proxy_connection",
        errorDetail:
          "the hosting target's proxy connection could not be resolved — link a Pangolin connection on its fleet-detail page, then resume this run.",
      };
    }
    const policyTier = resolved.writeAuthorization?.policyTier;
    if (
      policyTier === undefined ||
      providerWritePolicyTierRank(policyTier) < 1
    ) {
      return {
        status: "blocked",
        blockedReason: "credential_scope",
        errorDetail:
          "the Pangolin connection's write policy blocks this apply — allow writes for this connection on /settings/connections, then resume this run.",
      };
    }

    for (const rule of params.rules) {
      const existing = await db
        .select()
        .from(proxyResourceRules)
        .where(
          and(
            eq(proxyResourceRules.proxyResourceId, resourceRow.id),
            eq(proxyResourceRules.action, rule.action),
            eq(proxyResourceRules.match, rule.match),
            eq(proxyResourceRules.value, rule.value),
          ),
        );
      if (existing.length === 0) {
        await db.insert(proxyResourceRules).values({
          proxyResourceId: resourceRow.id,
          action: rule.action,
          match: rule.match,
          value: rule.value,
          priority: rule.priority,
          owner: "template",
        });
      }
    }

    const result = await proxyResourceService.reconcile(resourceRow.id, {
      mode: "apply",
      trigger: "intent_change",
      provider: resolved.provider,
      orgId: resolved.orgId,
      actorUserId: ctx.actorUserId,
      writeAuthorization: resolved.writeAuthorization,
    });
    return classifyProxyOutcome(result);
  }

  /* ------------------------------------------------------- mail.enable */

  function classifyMailDomainOutcome(
    result: MailDomainSyncResult,
  ): StepOutcome {
    switch (result.outcome) {
      case "disabled":
        return {
          status: "blocked",
          blockedReason: "mail_disabled",
          errorDetail:
            "mail is not enabled for this domain's intent — this is unexpected for a template-declared domain.",
          reconcileRunId: result.runId,
        };
      case "delegation_pending":
        return {
          status: "blocked",
          blockedReason: "awaiting_delegation",
          errorDetail:
            "waiting for DNS delegation to complete at the registrar — this resumes automatically once Cloudflare reports the zone active.",
          reconcileRunId: result.runId,
        };
      case "ownership_pending":
        return {
          status: "blocked",
          blockedReason: "ownership_not_yet_provable",
          errorDetail:
            "Purelymail has not yet been able to verify the ownership TXT record — resume this run again once DNS has propagated.",
          reconcileRunId: result.runId,
        };
      case "write_policy_blocked":
        return {
          status: "blocked",
          blockedReason: "credential_scope",
          errorDetail:
            "the Purelymail connection's write policy blocks this apply — allow writes for this connection on /settings/connections, then resume this run.",
          reconcileRunId: result.runId,
        };
      case "dns_pending":
      case "verified":
        return { status: "succeeded", reconcileRunId: result.runId };
    }
  }

  async function dispatchMailEnable(
    plan: CompiledPlan,
    step: CompiledStep,
    params: MailEnableParams,
    ctx: DispatchContext,
  ): Promise<StepOutcome> {
    const managedDomainsService = createManagedDomainsService({ db });
    const domainName = findAncestorDomainName(plan, step);
    const domain = await requireManagedDomainByName(
      managedDomainsService,
      domainName,
    );

    const permitted = await checkTierOnePolicy(params.mailConnectionId);
    if (!permitted) {
      return {
        status: "blocked",
        blockedReason: "credential_scope",
        errorDetail:
          "the Purelymail connection's write policy blocks this apply — allow writes for this connection on /settings/connections, then resume this run.",
      };
    }

    if (!domain.mailEnabled) {
      await managedDomainsService.updateIntent(domain.id, {
        mailEnabled: true,
        actorUserId: ctx.actorUserId ?? undefined,
      });
    }

    const mailDomainsService = createMailDomainsService({ db });
    const existingMailDomain = await mailDomainsService.find(domain.id);
    if (existingMailDomain === null) {
      await mailDomainsService.enableMail(domain.id, {
        mailConnectionId: params.mailConnectionId,
        actorUserId: ctx.actorUserId ?? undefined,
      });
    }

    const mailProvider = await providers.resolveMailProvider(
      params.mailConnectionId,
    );
    const mailSyncService = createMailSyncService({
      db,
      provider: mailProvider,
      secrets,
      mintPassword,
      providerName: "purelymail",
      connectionId: params.mailConnectionId,
      settings,
    });
    const result = await mailSyncService.runMailDomainSync({
      domainId: domain.id,
      trigger: "intent_change",
      actorUserId: ctx.actorUserId,
      actorIsAdmin: ctx.actorIsAdmin,
    });
    return classifyMailDomainOutcome(result);
  }

  /* -------------------------------------------------- mail.ensure-mailbox */

  async function dispatchMailEnsureMailbox(
    plan: CompiledPlan,
    step: CompiledStep,
    params: MailEnsureMailboxParams,
    ctx: DispatchContext,
  ): Promise<StepOutcome> {
    const managedDomainsService = createManagedDomainsService({ db });
    const domainName = findAncestorDomainName(plan, step);
    const domain = await requireManagedDomainByName(
      managedDomainsService,
      domainName,
    );

    const mailDomainsService = createMailDomainsService({ db });
    const mailDomain = await mailDomainsService.find(domain.id);
    if (mailDomain === null) {
      throw new InfrastructureNotFoundError(
        `domain "${domainName}" has no mail registration yet (invariant: its "mail.enable" step must have already succeeded)`,
        { domainName },
      );
    }

    const permitted = await checkTierOnePolicy(mailDomain.mailConnectionId);
    if (!permitted) {
      return {
        status: "blocked",
        blockedReason: "credential_scope",
        errorDetail:
          "the Purelymail connection's write policy blocks this apply — allow writes for this connection on /settings/connections, then resume this run.",
      };
    }

    const localPart = params.localPart.trim().toLowerCase();
    const existingMailboxes = await mailDomainsService.listMailboxes(domain.id);
    const alreadyDeclared = existingMailboxes.some(
      (row) => row.localPart === localPart,
    );
    if (!alreadyDeclared) {
      await mailDomainsService.addMailbox(domain.id, {
        localPart: params.localPart,
        kind: params.kind,
        forwardTo: params.forwardTo ?? undefined,
        actorUserId: ctx.actorUserId ?? undefined,
      });
    }

    const mailProvider = await providers.resolveMailProvider(
      mailDomain.mailConnectionId,
    );
    const mailSyncService = createMailSyncService({
      db,
      provider: mailProvider,
      secrets,
      mintPassword,
      providerName: "purelymail",
      connectionId: mailDomain.mailConnectionId,
      settings,
    });
    const result = await mailSyncService.runMailboxSync({
      domainId: domain.id,
      trigger: "intent_change",
      actorUserId: ctx.actorUserId,
      actorIsAdmin: ctx.actorIsAdmin,
    });

    // `MailboxSyncResult` carries no explicit blocked signal of its own —
    // this driver already pre-checked write policy above, so a 'partial'
    // reaching here is the underlying service's OWN (redundant) gate firing
    // as a defense-in-depth backstop, never the primary path.
    if (result.status === "failed") {
      return {
        status: "failed",
        errorCode: "provider_unavailable",
        errorDetail:
          "the mailbox sync run failed — see the linked reconcile run for detail.",
        reconcileRunId: result.runId,
      };
    }
    if (result.status === "partial") {
      return {
        status: "blocked",
        blockedReason: "credential_scope",
        errorDetail:
          "the Purelymail connection's write policy blocks this apply — allow writes for this connection on /settings/connections, then resume this run.",
        reconcileRunId: result.runId,
      };
    }
    return { status: "succeeded", reconcileRunId: result.runId };
  }

  /* --------------------------------------------------------- dispatch --- */

  async function dispatchStep(
    plan: CompiledPlan,
    step: CompiledStep,
    ctx: DispatchContext,
  ): Promise<StepOutcome> {
    switch (step.stepKind) {
      case "domain.declare":
        return dispatchDomainDeclare(
          domainDeclareParamsSchema.parse(step.params),
          ctx,
        );
      case "dns.point-at-target":
        return dispatchDnsPointAtTarget(
          plan,
          step,
          dnsPointAtTargetParamsSchema.parse(step.params),
          ctx,
        );
      case "dns.manual-record":
        return dispatchDnsManualRecord(
          plan,
          step,
          dnsManualRecordParamsSchema.parse(step.params),
          ctx,
        );
      case "proxy.ensure-resource":
        return dispatchProxyEnsureResource(
          plan,
          step,
          proxyEnsureResourceParamsSchema.parse(step.params),
          ctx,
        );
      case "proxy.ensure-rules":
        return dispatchProxyEnsureRules(
          plan,
          step,
          proxyEnsureRulesParamsSchema.parse(step.params),
          ctx,
        );
      case "mail.enable":
        return dispatchMailEnable(
          plan,
          step,
          mailEnableParamsSchema.parse(step.params),
          ctx,
        );
      case "mail.ensure-mailbox":
        return dispatchMailEnsureMailbox(
          plan,
          step,
          mailEnsureMailboxParamsSchema.parse(step.params),
          ctx,
        );
    }
  }

  async function finishRun(
    runId: string,
    status: TemplateRunStatus,
    actorUserId: string | null,
  ): Promise<TemplateRunRow> {
    const rows = await db
      .update(templateRuns)
      .set({ status, finishedAt: new Date() })
      .where(eq(templateRuns.id, runId))
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("template run update returned no row");
    }

    // The driver-PASS evidence row — see the module doc's "no step here
    // invents its own evidence" section and the schema's own doc.
    await db.insert(reconcileRuns).values({
      kind: RUN_PROVISIONING_TEMPLATE_RUN_KIND,
      subjectType: TEMPLATE_RUN_SUBJECT_TYPE,
      subjectId: runId,
      mode: "apply",
      // Every drive of this task is either the wizard's initial enqueue or
      // an operator's explicit "Resume run" click — both are honestly
      // "manual" from the reconciler's own trigger vocabulary; nothing here
      // is a sweep or a poll.
      trigger: "manual",
      status,
      finishedAt: new Date(),
      actorUserId,
    });

    return row;
  }

  return {
    async advance(runId, advanceOptions = {}) {
      const run = await requireRun(runId);
      if (run.status === "succeeded" || run.status === "failed") return run;

      const plan = run.compiledPlan as CompiledPlan;
      const stepRows = await loadStepRows(runId);
      const ctx: DispatchContext = {
        actorUserId: advanceOptions.actorUserId ?? run.actorUserId ?? null,
        actorIsAdmin: advanceOptions.actorIsAdmin,
      };

      for (const compiledStep of plan.steps) {
        const row = stepRows.get(compiledStep.sequence);
        if (row === undefined) {
          throw new Error(
            `template run ${runId} is missing its step row for sequence ${compiledStep.sequence} — invariant violated at run creation`,
          );
        }
        if (row.status === "succeeded" || row.status === "skipped") continue;

        if (compiledStep.dependsOnSequence !== null) {
          const parentRow = stepRows.get(compiledStep.dependsOnSequence);
          if (parentRow === undefined || parentRow.status !== "succeeded") {
            // Not yet reachable this pass — leave it exactly as it was.
            continue;
          }
        }

        // Clear a PRIOR pass's blocked/error markers before attempting again
        // — `blocked_reason`'s own `CHECK` requires it `NULL` whenever
        // `status != 'blocked'`, and a stale value here would violate it the
        // moment a resumed step re-attempts and lands anywhere else.
        await db
          .update(templateRunSteps)
          .set({
            status: "running",
            blockedReason: null,
            errorCode: null,
            errorDetail: null,
            occurredAt: new Date(),
          })
          .where(eq(templateRunSteps.id, row.id));

        let outcome: StepOutcome;
        try {
          outcome = await dispatchStep(plan, compiledStep, ctx);
        } catch (error) {
          if (error instanceof ProviderCallError) {
            outcome = {
              status: "failed",
              errorCode: error.kind,
              errorDetail: error.message,
            };
          } else if (
            error instanceof InfrastructureValidationError ||
            error instanceof InfrastructureNotFoundError
          ) {
            outcome = {
              status: "failed",
              errorCode: "invalid_request",
              errorDetail: error.message,
            };
          } else {
            // A genuinely unexpected error — do not swallow it. Mark the
            // step and the run failed, then rethrow so the worker's own
            // retry/alerting applies, matching every other reconciler here.
            await updateStepRow(row.id, {
              status: "failed",
              errorCode: "internal_error",
              errorDetail:
                error instanceof Error ? error.message : "unexpected error",
            });
            await finishRun(runId, "partial", ctx.actorUserId);
            throw error;
          }
        }

        await updateStepRow(row.id, outcome);
        stepRows.set(compiledStep.sequence, {
          ...row,
          status: outcome.status,
          blockedReason: outcome.blockedReason ?? null,
          reconcileRunId: outcome.reconcileRunId ?? null,
          providerOperationKey: outcome.providerOperationKey ?? null,
          errorCode: outcome.errorCode ?? null,
          errorDetail: outcome.errorDetail ?? null,
        });
      }

      const requiredSteps = plan.steps.filter((s) => !s.optional);
      const allRequiredSucceeded = requiredSteps.every(
        (s) => stepRows.get(s.sequence)?.status === "succeeded",
      );
      return finishRun(
        runId,
        allRequiredSucceeded ? "succeeded" : "partial",
        ctx.actorUserId,
      );
    },
  };
}
