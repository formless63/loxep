/**
 * The container-host reconciler proper (loxep-hb7 Milestone C): declaring an
 * operator's "register this host in Dockhand" intent, and driving
 * `planContainerHostOperations` (`container-host-port.ts`) against a real
 * provider port — its FIRST non-test caller.
 *
 * ```text
 * declareIntent   web request, admin action     writes external_resources /
 *                                                resource_links intent +
 *                                                application_secrets, then
 *                                                enqueues the task below in
 *                                                the SAME transaction
 * reconcile       infrastructure.reconcile-      read -> diff -> (apply) ->
 *                 container-host task            record, modelled on
 *                                                `sync.ts`'s runRecordSync
 * ```
 *
 * ## Why this file takes NO `@loxep/integration-dockhand` dependency
 *
 * Same rule `container-host-port.ts`'s own module doc states: the port is
 * re-declared structurally, and the composition root (`@loxep/app`) holds
 * both this service and the real adapter, passing a
 * `ContainerHostProviderPort` in per call. `reconcile()` therefore takes the
 * port as an argument rather than a constructor option — unlike
 * `createRecordSyncService`'s single Cloudflare-per-installation `provider`,
 * a Dockhand host can be registered against ANY of several connections, so
 * "which provider" is a per-target fact resolved from the stored link, not an
 * installation-wide constant.
 *
 * ## Why `declareIntent` needs no provider at all
 *
 * Declaring intent never calls Dockhand. It writes Loxep's own desired state
 * and enqueues the task that will. This is the same split `domains.ts`'s
 * `addManualRecord` and `mail.ts`'s `enableMail` draw: the request-scoped
 * write is fast, synchronous, and provider-free; the provider call happens
 * later, in the worker, where a slow or failing call cannot block an HTTP
 * response.
 *
 * ## `writeSecret`/`readSecret` are injected, not constructed here
 *
 * Same reasoning as `tokens.ts`'s `TransactionalDnsTokenSecretWriter`: this
 * package takes no `@loxep/config` dependency, so it cannot build a
 * `SecretsService` (which needs a `Keyring`) itself. The composition root
 * (`apps/web/src/server/admin.ts` for `declareIntent`,
 * `@loxep/app/src/infrastructure-container-host.ts` for `reconcile`) injects
 * two narrow functions instead of the whole service — `writeSecret` takes a
 * transaction handle (the SAME atomicity requirement `token-port.ts`'s
 * `TransactionalDnsTokenSecretWriter` documents: the intent row and the
 * secret version must land together or not at all), `readSecret` does not,
 * because a plain read has no transaction to join.
 *
 * ## `readSecret` is NOT a reveal-once channel
 *
 * `bundles.ts`'s `container_host_secret` doc states the distinction: this
 * material is operator-supplied, not Loxep-minted, so ADR-0022 does not
 * govern it. `readSecret` exists so `reconcile()` can relay the stored
 * material to the provider on a create/update — never so a web surface can
 * read it back. No server function in this codebase may call it; only this
 * module's own `reconcile()` does.
 *
 * ## Metadata carries INTENT, not a copy of Dockhand's inventory
 *
 * `resource-links.ts`'s own rule — "metadata carries sync metadata only,
 * never a copy of the tool's data" — is about the TOOL's data (a container
 * list, a stack list). The fields this module writes into
 * `external_resources.metadata` (`connectionType`, `host`, `port`, …,
 * `desiredAt`) are Loxep's OWN declared intent plus observation timestamps,
 * the same category `external_resources` already carries — see
 * `container-host-port.ts`'s own module doc and hb7 §2.3's note.
 *
 * `desiredAt`'s presence is what distinguishes a link an OPERATOR declared
 * through this module from one Milestone B's discovery auto-attached with no
 * intent behind it (`fleet-health.ts`'s `projectDockhandResources`, which
 * writes NO `desiredAt`). `reconcile()` refuses to act on a link that lacks
 * it — see that function's doc.
 *
 * ## The ledger's IDEAL case, named as such
 *
 * hb7 §2.5: Dockhand host creation is fully read-back resolvable — a stuck
 * `pending` `provider_operations` row resolves by calling `provider.read()`
 * (Dockhand's `readHosts`/`listHosts`, the SAME endpoint) and matching by
 * name. `succeeded` when found, `failed` (safe to retry next run) when not.
 * It never becomes an operator decision, unlike a token create
 * (`tokens.ts`'s `mint`). An `update` is NOT ledgered — `PUT
 * /api/environments/{id}` is convergent, matching how `sync.ts` treats its
 * own DNS applies.
 *
 * ## Identity self-retirement happens here, not in the planner
 *
 * `container-host-port.ts`'s planner only CONSUMES
 * `DesiredContainerHost.externalHostId`; it never learns one. This module is
 * where the link's `external_id` gets written the first time a create
 * succeeds or a check-mode plan matches by name — see
 * `selfRetireIdentity`'s doc below.
 *
 * ## The write-authorization gate (loxep-47o.10, joining Cloudflare/Purelymail/Pangolin)
 *
 * The estate-browser audit (`estate-browsers-design.md` §8.3) found this the
 * one write-capable adapter with zero `assertWritePolicy` call sites — an
 * undocumented asymmetry with its three siblings, not a considered exemption.
 * The accepted design closes that asymmetry. `reconcile()` gates its ONE
 * possible write (`applyHost`, fired at most once per call — hb7 §2.4) with
 * `assertWritePolicy` immediately before attempting it, keyed on the
 * declared link's OWN `connectionId` (never a constructor option, unlike
 * `sync.ts`'s single-connection-per-installation Cloudflare service — a
 * Dockhand host can be registered against any of several connections, so
 * "which connection" is a per-target fact read off the link, not an
 * installation-wide constant; see the module doc above). Both `create` and
 * `update` are tier 1 (additive): the write is narrow — it creates or
 * updates a row in Dockhand's OWN database; nothing executes on the target
 * machine — unlike Pangolin, whose
 * `update-*` is tier 2. A refusal records a `'blocked'`
 * `reconcile_run_steps` row (never a failure, never a silent skip) and the
 * run finishes `'partial'`, exactly like `sync.ts`/`mail-sync.ts`. The
 * default policy is `read_only`, so applies block until the connection's tier
 * is explicitly raised on `/settings/connections` — see the connecting guide.
 */
import {
  createResourceLinksService,
  createSettingsService,
  providerWritePolicySetting,
  resolveProviderWritePolicy,
} from "@loxep/domain";
import type { SettingsService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import {
  externalResources,
  hostingTargets,
  reconcileRunSteps,
  reconcileRuns,
  resourceLinks as resourceLinksTable,
} from "@loxep/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  RECONCILE_CONTAINER_HOST_TASK,
  containerHostJobKey,
  type ReconcileContainerHostPayload,
} from "./tasks.ts";
import type { TransactionalEnqueue } from "./domains.ts";
import {
  InfrastructureNotFoundError,
  InfrastructureValidationError,
  ProviderCallError,
} from "./errors.ts";
import {
  createProviderOperationsLedger,
  idempotencyKey,
  type ProviderOperationsLedger,
} from "./operations.ts";
import type { ResponseRedactor } from "./port.ts";
import {
  planContainerHostOperations,
  type ContainerHostProviderPort,
  type DesiredContainerHost,
  type ObservedContainerHost,
} from "./container-host-port.ts";
import {
  assertWritePolicy,
  WritePolicyError,
  writePolicyBlockedStep,
  type WritePolicyBlockedReason,
} from "./write-policy.ts";

export type ReconcileRunRow = typeof reconcileRuns.$inferSelect;

/** `reconcile_runs.kind` for this task. */
export const RECONCILE_CONTAINER_HOST_RUN_KIND = "reconcile-container-host";

/** `resource_links.purpose` for a Dockhand host registration — the fleet design's own vocabulary row. */
export const CONTAINER_HOST_LINK_PURPOSE = "container_console";
export const CONTAINER_HOST_EXTERNAL_TYPE = "environment";
export const CONTAINER_HOST_PROVIDER = "dockhand";

/** `application_secrets.secret_key` for one target's write-only host material. */
export function containerHostSecretKey(hostingTargetId: string): string {
  return `infrastructure.dockhand_host.${hostingTargetId}`;
}

function errorKind(error: unknown): string {
  return error instanceof Error && "kind" in error
    ? String((error as { kind: unknown }).kind)
    : "provider_unavailable";
}

/**
 * The SAFE fallback redactor — unlike `sync.ts`'s scalar-keeping default,
 * this one may run against a container-host PAYLOAD that carries a raw TLS
 * private key or Hawser token as a plain string field, so it cannot simply
 * keep every scalar. Every known secret-shaped field name is reduced to a
 * presence bit; every other scalar passes through. The composition root
 * should still inject Dockhand's own allow-list redactor
 * (`redactDockhandHostPayload`/`redactDockhandHost`) — this default exists so
 * a caller that forgets degrades to a redacted (never a leaking) summary.
 */
const CONTAINER_HOST_SECRET_FIELD_NAMES = new Set([
  "tlsCa",
  "tlsCert",
  "tlsKey",
  "hawserToken",
]);
const defaultContainerHostRedactor: ResponseRedactor = (value) => {
  if (typeof value !== "object" || value === null) return { value: null };
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (CONTAINER_HOST_SECRET_FIELD_NAMES.has(key)) {
      out[`${key}Configured`] = entry !== undefined && entry !== null && entry !== "";
      continue;
    }
    if (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean" ||
      entry === null
    ) {
      out[key] = entry;
    }
  }
  return out;
};

/** The write-only secret payload `reconcile()` relays to the provider. Every field independently optional — see `bundles.ts`'s `container_host_secret`. */
export interface ContainerHostSecretPayload {
  tlsCa?: string;
  tlsCert?: string;
  tlsKey?: string;
  hawserToken?: string;
}

/**
 * Mirrors `token-port.ts`'s `TransactionalDnsTokenSecretWriter` exactly: a
 * transaction handle first, so a rollback of the caller's transaction rolls
 * back the secret write too.
 */
export type TransactionalContainerHostSecretWriter = (
  tx: LoxepDb,
  input: {
    secretKey: string;
    purpose: "container_host_secret";
    payload: ContainerHostSecretPayload;
    actorUserId?: string | null;
  },
) => Promise<{ id: string }>;

/** A plain (non-transactional) read — `reconcile()` is never inside the caller's own transaction. Returns `{}` when nothing is stored. */
export type ContainerHostSecretReader = (
  secretKey: string,
) => Promise<ContainerHostSecretPayload>;

/** The non-secret intent fields stored in `external_resources.metadata` — see the module doc's "Metadata carries INTENT" section. */
export interface ContainerHostIntentMetadata {
  connectionType: string;
  host: string | null;
  port: number | null;
  protocol: string | null;
  socketPath: string | null;
  tlsSkipVerify: boolean | null;
  labels: string[];
  publicIp: string | null;
  /** Set the moment an operator declares intent; absent on a discovery-only link. See the module doc. */
  desiredAt: string;
  lastAppliedAt: string | null;
  /** Structurally a jsonb bag (`external_resources.metadata`) — see `isContainerHostIntent`'s narrowing. */
  [key: string]: unknown;
}

/** `true` only when `metadata` itself carries `desiredAt` — an OPERATOR declared this, not just discovery. */
function isContainerHostIntent(
  metadata: Record<string, unknown>,
): metadata is ContainerHostIntentMetadata & Record<string, unknown> {
  return typeof metadata["desiredAt"] === "string";
}

export interface DeclareContainerHostIntentInput {
  hostingTargetId: string;
  connectionId: string;
  /** The Dockhand deep link this connection's base URL resolves to — the caller computes it (this package holds no adapter). */
  url: string;
  connectionType: string;
  host?: string | null;
  port?: number | null;
  protocol?: string | null;
  socketPath?: string | null;
  tlsSkipVerify?: boolean | null;
  labels?: string[];
  publicIp?: string | null;
  /** Write-only. Empty/absent leaves any already-stored value untouched — see `bundles.ts`. */
  tlsCa?: string;
  tlsCert?: string;
  tlsKey?: string;
  hawserToken?: string;
  actorUserId?: string | null;
}

export interface DeclareContainerHostIntentResult {
  hostingTargetId: string;
  externalResourceId: string;
  jobKey: string;
}

export interface ReconcileContainerHostResult {
  /** `null` when nothing ran — no declared intent, or a decommissioned target. See `reconcile()`'s doc. */
  runId: string | null;
  status: "skipped" | "succeeded" | "failed" | "partial";
  mode: "apply" | "check";
  operationCount: number;
  applied: number;
  unmatchedObservedCount: number;
  /** Set when the write-authorization gate refused the one possible operation — see the module doc. `null` otherwise, including every `check`-mode run. */
  writePolicyBlockedReason: WritePolicyBlockedReason | null;
}

/** One hosting target with a declared (operator-confirmed) container-host intent — Milestone D's drift-cadence subject list. */
export interface DeclaredContainerHostTarget {
  hostingTargetId: string;
  hostingTargetName: string;
  connectionId: string;
  lastRunStartedAt: Date | null;
}

export interface ContainerHostsService {
  declareIntent(
    input: DeclareContainerHostIntentInput,
  ): Promise<DeclareContainerHostIntentResult>;
  reconcile(
    hostingTargetId: string,
    options: {
      mode: "apply" | "check";
      trigger: "intent_change" | "manual" | "poll";
      provider: ContainerHostProviderPort;
      actorUserId?: string | null;
      /**
       * Whether a known human actor is attached to this run — see
       * `write-policy.ts`'s `assertWritePolicy` for why `undefined` (no
       * actor; every current caller of `reconcile()` is a background task)
       * is not the same as `false` (a known non-admin, which always
       * refuses).
       */
      actorIsAdmin?: boolean;
      /**
       * Defaults to a SAFE (never-leaking) local redactor —
       * {@link defaultContainerHostRedactor} — but the composition root
       * should still inject Dockhand's own allow-list redactor
       * (`redactDockhandHostPayload`/`redactDockhandHost`) for richer summaries.
       * Unlike `sync.ts`'s optional `redact`, the default here cannot simply
       * keep every scalar: `operation.host` can carry a raw TLS private key
       * or Hawser token as a plain string field.
       */
      redact?: ResponseRedactor;
    },
  ): Promise<ReconcileContainerHostResult>;
  /** Every target with declared intent, oldest-reconciled first — the drift cadence's own due-ness order. */
  listDeclaredTargets(): Promise<DeclaredContainerHostTarget[]>;
  listRuns(hostingTargetId: string): Promise<ReconcileRunRow[]>;
}

export function createContainerHostsService(options: {
  db: LoxepDb;
  writeSecret: TransactionalContainerHostSecretWriter;
  readSecret: ContainerHostSecretReader;
  enqueue: TransactionalEnqueue;
  /** Defaults to `createSettingsService({ db })`. Overridable for tests. */
  settings?: SettingsService;
}): ContainerHostsService {
  const { db, writeSecret, readSecret, enqueue } = options;
  const settings = options.settings ?? createSettingsService({ db });
  const ledger: ProviderOperationsLedger = createProviderOperationsLedger({ db });

  async function requireHostingTarget(
    executor: Pick<LoxepDb, "select">,
    id: string,
  ): Promise<typeof hostingTargets.$inferSelect> {
    const rows = await executor
      .select()
      .from(hostingTargets)
      .where(eq(hostingTargets.id, id));
    const row = rows[0];
    if (row === undefined) {
      throw new InfrastructureNotFoundError(`hosting target ${id} not found`, {
        id,
      });
    }
    return row;
  }

  async function findContainerHostLink(
    executor: LoxepDb,
    hostingTargetId: string,
  ) {
    const links = await createResourceLinksService({ db: executor }).listLinksFor(
      "hosting_target",
      hostingTargetId,
    );
    return links.find(
      (link) =>
        link.provider === CONTAINER_HOST_PROVIDER &&
        link.externalType === CONTAINER_HOST_EXTERNAL_TYPE &&
        link.purpose === CONTAINER_HOST_LINK_PURPOSE,
    );
  }

  async function declareIntent(
    input: DeclareContainerHostIntentInput,
  ): Promise<DeclareContainerHostIntentResult> {
    const target = await requireHostingTarget(db, input.hostingTargetId);
    if (target.decommissionedAt !== null) {
      throw new InfrastructureValidationError(
        `hosting target "${target.name}" is decommissioned; cannot register a container host for it`,
        { hostingTargetId: input.hostingTargetId },
      );
    }

    return db.transaction(async (tx) => {
      const resourceLinksService = createResourceLinksService({ db: tx });
      const existing = await findContainerHostLink(tx, input.hostingTargetId);
      const existingDesired =
        existing !== undefined && isContainerHostIntent(existing.metadata)
          ? existing.metadata
          : undefined;

      const metadata: ContainerHostIntentMetadata = {
        connectionType: input.connectionType,
        host: input.host ?? null,
        port: input.port ?? null,
        protocol: input.protocol ?? null,
        socketPath: input.socketPath ?? null,
        tlsSkipVerify: input.tlsSkipVerify ?? null,
        labels: input.labels ?? [],
        publicIp: input.publicIp ?? null,
        desiredAt: new Date().toISOString(),
        lastAppliedAt: existingDesired?.lastAppliedAt ?? null,
      };

      let externalResourceId: string;
      if (existing !== undefined) {
        // Patch the SAME row in place (by primary key) — never a second
        // insert, which would orphan a discovery-created row (Milestone B's
        // auto-attach) or duplicate a previously-declared one.
        await tx
          .update(externalResources)
          .set({
            connectionId: input.connectionId,
            url: input.url,
            metadata,
            updatedAt: new Date(),
          })
          .where(eq(externalResources.id, existing.externalResourceId));
        externalResourceId = existing.externalResourceId;
      } else {
        const created = await resourceLinksService.createLink({
          provider: CONTAINER_HOST_PROVIDER,
          externalType: CONTAINER_HOST_EXTERNAL_TYPE,
          externalId: null,
          connectionId: input.connectionId,
          url: input.url,
          title: target.name,
          metadata,
          resourceType: "hosting_target",
          resourceId: input.hostingTargetId,
          purpose: CONTAINER_HOST_LINK_PURPOSE,
        });
        externalResourceId = created.externalResourceId;
      }

      const secretPayload: ContainerHostSecretPayload = {};
      if (input.tlsCa !== undefined) secretPayload.tlsCa = input.tlsCa;
      if (input.tlsCert !== undefined) secretPayload.tlsCert = input.tlsCert;
      if (input.tlsKey !== undefined) secretPayload.tlsKey = input.tlsKey;
      if (input.hawserToken !== undefined) {
        secretPayload.hawserToken = input.hawserToken;
      }
      // An empty save leaves any already-stored value untouched — only write
      // when the operator actually supplied something this time, matching
      // every other write-only field in the secrets registry.
      if (Object.keys(secretPayload).length > 0) {
        await writeSecret(tx, {
          secretKey: containerHostSecretKey(input.hostingTargetId),
          purpose: "container_host_secret",
          payload: secretPayload,
          actorUserId: input.actorUserId ?? null,
        });
      }

      const jobKey = containerHostJobKey(
        RECONCILE_CONTAINER_HOST_TASK,
        input.hostingTargetId,
      );
      // Passed as an inline literal, not a pre-typed `ReconcileContainerHostPayload`
      // variable: `TransactionalEnqueue.payload` is `Record<string, unknown>`,
      // and only an object LITERAL gets TypeScript's weak-type structural
      // check there — a named interface variable with no index signature is
      // not assignable to it.
      const payload: ReconcileContainerHostPayload = {
        hostingTargetId: input.hostingTargetId,
        mode: "apply",
        trigger: "intent_change",
      };
      await enqueue(tx, RECONCILE_CONTAINER_HOST_TASK, { ...payload }, { jobKey });

      return { hostingTargetId: input.hostingTargetId, externalResourceId, jobKey };
    });
  }

  /**
   * Writes the provider's id into the link the first time a create succeeds
   * or a check matches by name — hb7 §3.1's self-retiring bootstrap,
   * documented on `DesiredContainerHost.externalHostId` and
   * `container-host-port.ts`'s module doc.
   *
   * A best-effort write: a failure here does not fail the run (the host
   * operation, if any, already succeeded at the provider) — it is retried on
   * the next reconcile, the same tolerance `sync.ts` extends to a crash
   * between a provider call and its own DB write.
   */
  async function selfRetireIdentity(
    externalResourceId: string,
    externalHostId: string,
  ): Promise<void> {
    try {
      await db
        .update(externalResources)
        .set({ externalId: externalHostId, updatedAt: new Date() })
        .where(eq(externalResources.id, externalResourceId));
    } catch {
      // See doc above — swallowed on purpose.
    }
  }

  async function reconcile(
    hostingTargetId: string,
    reconcileOptions: {
      mode: "apply" | "check";
      trigger: "intent_change" | "manual" | "poll";
      provider: ContainerHostProviderPort;
      actorUserId?: string | null;
      actorIsAdmin?: boolean;
      redact?: ResponseRedactor;
    },
  ): Promise<ReconcileContainerHostResult> {
    const redact = reconcileOptions.redact ?? defaultContainerHostRedactor;
    const target = await requireHostingTarget(db, hostingTargetId);

    if (target.decommissionedAt !== null) {
      // Decommissioning stops reconciling — the design's own rule (§2.6/§4).
      return {
        runId: null,
        status: "skipped",
        mode: reconcileOptions.mode,
        operationCount: 0,
        applied: 0,
        unmatchedObservedCount: 0,
        writePolicyBlockedReason: null,
      };
    }

    const link = await findContainerHostLink(db, hostingTargetId);
    if (link === undefined || !isContainerHostIntent(link.metadata)) {
      // No declared intent — either nothing registered yet, or the only
      // link present is a Milestone B discovery auto-attach with no operator
      // intent behind it. Nothing to converge; no run row (a run implies a
      // reconcile attempt actually happened).
      return {
        runId: null,
        status: "skipped",
        mode: reconcileOptions.mode,
        operationCount: 0,
        applied: 0,
        unmatchedObservedCount: 0,
        writePolicyBlockedReason: null,
      };
    }
    const meta = link.metadata as ContainerHostIntentMetadata;

    // Secret material is fetched only when it could possibly be used —
    // NEVER unconditionally. `planContainerHostOperations` treats a
    // `desired.tlsKey` (etc.) that is merely PRESENT as "the caller
    // deliberately supplied it" and re-sends it on every update
    // (`container-host-port.ts`'s own "does NOT re-send TLS material on
    // every sweep" rule, and its test suite proves it at the pure-function
    // level) — so a `reconcile()` that always populated `desired` from
    // storage would defeat that rule at THIS layer on every single call,
    // including a check-mode drift pass and a manual reconcile of an
    // already-registered host. Fetched only for: (a) a genuine CREATE
    // attempt (`link.externalId === null` — the provider needs the material
    // to connect at all), or (b) the run that is the DIRECT reaction to the
    // operator having just declared/edited intent (`trigger ===
    // 'intent_change'`, which may have just written new material). Every
    // other apply — a manual "Reconcile" click on an already-registered
    // host, or Milestone D's periodic check-mode drift cadence — proceeds
    // with an empty payload, which `planContainerHostOperations` correctly
    // reads as "no opinion", not "clear it" (comparison is by presence, and
    // an update never guesses at absence).
    let secretPayload: ContainerHostSecretPayload = {};
    if (
      reconcileOptions.mode === "apply" &&
      (link.externalId === null || reconcileOptions.trigger === "intent_change")
    ) {
      try {
        secretPayload = await readSecret(containerHostSecretKey(hostingTargetId));
      } catch {
        // No secret stored — a `socket` connection or a TLS-less `direct`
        // one legitimately has none. Proceed with an empty payload.
      }
    }

    const desired: DesiredContainerHost = {
      hostingTargetId,
      name: target.name,
      connectionType: meta.connectionType,
      host: meta.host,
      port: meta.port,
      protocol: meta.protocol,
      socketPath: meta.socketPath,
      tlsSkipVerify: meta.tlsSkipVerify,
      labels: meta.labels,
      publicIp: meta.publicIp,
      externalHostId: link.externalId,
      ...secretPayload,
    };

    const runRows = await db
      .insert(reconcileRuns)
      .values({
        kind: RECONCILE_CONTAINER_HOST_RUN_KIND,
        subjectType: "hosting_target",
        subjectId: hostingTargetId,
        mode: reconcileOptions.mode,
        trigger: reconcileOptions.trigger,
        actorUserId: reconcileOptions.actorUserId ?? null,
      })
      .returning();
    const run = runRows[0];
    if (run === undefined) throw new Error("reconcile run insert returned no row");

    let sequence = 0;
    const step = async (entry: {
      step: string;
      /** `'blocked'` — the write-authorization gate refused; see the module doc. Never a failure, never a silent skip. */
      status: "succeeded" | "failed" | "skipped" | "blocked";
      requestSummary?: Record<string, unknown> | null;
      responseSummary?: Record<string, unknown> | null;
      errorCode?: string | null;
      errorDetail?: string | null;
    }): Promise<void> => {
      await db.insert(reconcileRunSteps).values({
        runId: run.id,
        sequence: sequence++,
        step: entry.step,
        status: entry.status,
        provider: CONTAINER_HOST_PROVIDER,
        requestSummary: entry.requestSummary ?? null,
        responseSummary: entry.responseSummary ?? null,
        errorCode: entry.errorCode ?? null,
        errorDetail: entry.errorDetail ?? null,
      });
    };
    const finish = async (
      status: "succeeded" | "failed" | "partial",
      errorSummary: string | null,
    ): Promise<void> => {
      await db
        .update(reconcileRuns)
        .set({ status, finishedAt: new Date(), stepCount: sequence, errorSummary })
        .where(eq(reconcileRuns.id, run.id));
    };

    let observed: ObservedContainerHost[];
    try {
      observed = await reconcileOptions.provider.read();
    } catch (error) {
      const kind = errorKind(error);
      await step({
        step: "read-provider",
        status: "failed",
        errorCode: kind,
        errorDetail: "dockhand host read failed",
      });
      await finish("failed", `provider read failed (${kind})`);
      if (error instanceof ProviderCallError) throw error;
      throw new ProviderCallError(kind, "dockhand host read failed", {
        hostingTargetId,
        runId: run.id,
      });
    }
    await step({
      step: "read-provider",
      status: "succeeded",
      requestSummary: { operation: "container_host.list" },
      responseSummary: { observed: observed.length },
    });

    const plan = planContainerHostOperations({ desired: [desired], observed });
    await step({
      step: "diff",
      status: "succeeded",
      responseSummary: {
        operations: plan.operations.length,
        unmatchedObservedCount: plan.unmatchedObserved.length,
        // A bounded sample only — never the whole inventory in a run step.
        unmatchedObservedSample: plan.unmatchedObserved
          .slice(0, 10)
          .map((host) => ({ name: host.name, externalHostId: host.externalHostId })),
      },
    });

    // hb7 §3.1: the first time a check MATCHES by name (no id known yet),
    // the observed side already reveals the id — retire the bootstrap right
    // here, even in check mode and even when nothing else differs.
    let matchedExternalHostId = link.externalId;
    if (matchedExternalHostId === null) {
      const matchedByName = observed.find((host) => host.name === target.name);
      if (matchedByName !== undefined) {
        matchedExternalHostId = matchedByName.externalHostId;
      }
    }

    // ---- write policy (loxep-47o.10, joining Cloudflare/Purelymail/Pangolin) --
    let writePolicyBlockedError: WritePolicyError | null = null;
    if (
      reconcileOptions.mode === "apply" &&
      plan.operations.length > 0 &&
      link.connectionId !== null
    ) {
      const policies = await settings.get(providerWritePolicySetting);
      const policyTier = resolveProviderWritePolicy(policies, link.connectionId);
      try {
        assertWritePolicy({
          mode: reconcileOptions.mode,
          trigger: reconcileOptions.trigger,
          policyTier,
          // Both create and update are tier 1 (additive) — see the module
          // doc's "write-authorization gate" section for why this differs
          // from Pangolin's update-is-tier-2 split.
          operationTier: 1,
          actorIsAdmin: reconcileOptions.actorIsAdmin,
          unblockHint:
            `allow writes for this Dockhand connection (currently '${policyTier}') ` +
            "on /settings/connections to register or update this host",
        });
      } catch (error) {
        if (!(error instanceof WritePolicyError)) throw error;
        writePolicyBlockedError = error;
      }
    }

    let applied = 0;
    if (writePolicyBlockedError !== null) {
      await step({ step: "apply.blocked", ...writePolicyBlockedStep(writePolicyBlockedError) });
    } else if (reconcileOptions.mode === "apply" && plan.operations.length > 0) {
      // "At most one operation, mode==='apply' only" (hb7 §2.4) — one
      // desired host can produce at most one operation anyway, but the cap
      // is stated explicitly so a future edit to the planner cannot silently
      // widen a single target's run into a multi-operation apply.
      const operation = plan.operations[0];
      if (operation === undefined) {
        throw new Error("unreachable: plan.operations.length > 0");
      }

      if (operation.kind === "create") {
        const key = idempotencyKey(
          CONTAINER_HOST_PROVIDER,
          "host.create",
          hostingTargetId,
        );
        const begin = await ledger.begin({
          key,
          provider: CONTAINER_HOST_PROVIDER,
          operation: "host.create",
          runId: run.id,
        });

        if (begin.decision === "already_succeeded") {
          await step({
            step: "apply.create",
            status: "succeeded",
            responseSummary: { shortCircuited: true, idempotencyKey: key },
          });
        } else if (begin.decision === "needs_read_back") {
          // hb7 §2.5: the ledger's IDEAL case. readHosts() IS provider.read()
          // — the same call the diff step above already made — but a fresh
          // read is taken here deliberately: `observed` may be stale by the
          // time a stuck-pending row is discovered on a LATER run.
          const readBack = await reconcileOptions.provider.read();
          const found = readBack.find((host) => host.name === operation.host.name);
          if (found === undefined) {
            await ledger.fail(key, { readBack: "absent" });
            await step({
              step: "apply.create.read-back",
              status: "succeeded",
              responseSummary: { present: false, resolvedTo: "failed" },
            });
          } else {
            await ledger.succeed(key, { readBack: "present", externalHostId: found.externalHostId });
            await step({
              step: "apply.create.read-back",
              status: "succeeded",
              responseSummary: { present: true, resolvedTo: "succeeded" },
            });
            applied = 1;
            matchedExternalHostId = found.externalHostId;
          }
        } else {
          try {
            const result = await reconcileOptions.provider.apply(operation);
            await ledger.succeed(key, redact(result));
            applied = 1;
            matchedExternalHostId = result.externalHostId;
            await step({
              step: "apply.create",
              status: "succeeded",
              requestSummary: redact(operation.host),
              responseSummary: redact(result),
            });
          } catch (error) {
            const kind = errorKind(error);
            await ledger.fail(key, { errorKind: kind });
            await step({
              step: "apply.create",
              status: "failed",
              errorCode: kind,
              errorDetail: "dockhand host create failed",
            });
            await finish("failed", `host create failed (${kind})`);
            if (error instanceof ProviderCallError) throw error;
            throw new ProviderCallError(kind, "dockhand host create failed", {
              hostingTargetId,
              runId: run.id,
            });
          }
        }
      } else {
        // update: convergent, NOT ledgered — see the module doc.
        try {
          const result = await reconcileOptions.provider.apply(operation);
          applied = 1;
          matchedExternalHostId = result.externalHostId;
          await step({
            step: "apply.update",
            status: "succeeded",
            requestSummary: redact(operation.host),
            responseSummary: redact(result),
          });
        } catch (error) {
          const kind = errorKind(error);
          await step({
            step: "apply.update",
            status: "failed",
            errorCode: kind,
            errorDetail: "dockhand host update failed",
          });
          await finish("failed", `host update failed (${kind})`);
          if (error instanceof ProviderCallError) throw error;
          throw new ProviderCallError(kind, "dockhand host update failed", {
            hostingTargetId,
            runId: run.id,
          });
        }
      }
    } else if (reconcileOptions.mode === "apply") {
      await step({ step: "apply.none", status: "skipped" });
    } else {
      await step({ step: "apply.skipped-check-mode", status: "skipped" });
    }

    if (matchedExternalHostId !== null && matchedExternalHostId !== link.externalId) {
      await selfRetireIdentity(link.externalResourceId, matchedExternalHostId);
    }
    if (reconcileOptions.mode === "apply" && applied > 0) {
      await db
        .update(externalResources)
        .set({
          metadata: { ...meta, lastAppliedAt: new Date().toISOString() },
          updatedAt: new Date(),
        })
        .where(eq(externalResources.id, link.externalResourceId));
    }

    // A write-policy refusal is neither a failure nor a silent skip (rule
    // 2) — the run finishes 'partial', the same honest classification
    // sync.ts/mail-sync.ts already apply.
    await finish(writePolicyBlockedError !== null ? "partial" : "succeeded", null);
    return {
      runId: run.id,
      status: writePolicyBlockedError !== null ? "partial" : "succeeded",
      mode: reconcileOptions.mode,
      operationCount: plan.operations.length,
      applied,
      unmatchedObservedCount: plan.unmatchedObserved.length,
      writePolicyBlockedReason: writePolicyBlockedError?.blockedReason ?? null,
    };
  }

  async function listDeclaredTargets(): Promise<DeclaredContainerHostTarget[]> {
    const rows = await db
      .select({
        hostingTargetId: hostingTargets.id,
        hostingTargetName: hostingTargets.name,
        connectionId: externalResources.connectionId,
        metadata: externalResources.metadata,
      })
      .from(resourceLinksTable)
      .innerJoin(
        externalResources,
        eq(externalResources.id, resourceLinksTable.externalResourceId),
      )
      // `resource_links.resource_id` is `text` (a generic cross-resource-type
      // reference — see `resources.ts`), while `hosting_targets.id` is
      // `uuid`; an ordinary `eq()` between the two is a `uuid = text`
      // operator PostgreSQL rejects outright, so the uuid side is cast
      // explicitly rather than relying on an implicit coercion that does
      // not exist for this pair.
      .innerJoin(
        hostingTargets,
        eq(sql<string>`${hostingTargets.id}::text`, resourceLinksTable.resourceId),
      )
      .where(
        and(
          eq(resourceLinksTable.resourceType, "hosting_target"),
          eq(resourceLinksTable.purpose, CONTAINER_HOST_LINK_PURPOSE),
          eq(externalResources.provider, CONTAINER_HOST_PROVIDER),
          eq(externalResources.externalType, CONTAINER_HOST_EXTERNAL_TYPE),
          isNull(hostingTargets.decommissionedAt),
        ),
      );

    const declared = rows.filter(
      (row) =>
        row.connectionId !== null &&
        isContainerHostIntent(row.metadata as Record<string, unknown>),
    );

    const lastRuns = await db
      .select({ subjectId: reconcileRuns.subjectId, startedAt: reconcileRuns.startedAt })
      .from(reconcileRuns)
      .where(eq(reconcileRuns.kind, RECONCILE_CONTAINER_HOST_RUN_KIND));
    const latestBySubject = new Map<string, Date>();
    for (const runRow of lastRuns) {
      const existing = latestBySubject.get(runRow.subjectId);
      if (existing === undefined || runRow.startedAt > existing) {
        latestBySubject.set(runRow.subjectId, runRow.startedAt);
      }
    }

    return declared
      .map((row) => ({
        hostingTargetId: row.hostingTargetId,
        hostingTargetName: row.hostingTargetName,
        connectionId: row.connectionId as string,
        lastRunStartedAt: latestBySubject.get(row.hostingTargetId) ?? null,
      }))
      .sort((a, b) => {
        // Never-run targets first, then oldest-run-first — the drift
        // cadence's own fairness order under its subject cap.
        if (a.lastRunStartedAt === null) return -1;
        if (b.lastRunStartedAt === null) return 1;
        return a.lastRunStartedAt.getTime() - b.lastRunStartedAt.getTime();
      });
  }

  async function listRuns(hostingTargetId: string): Promise<ReconcileRunRow[]> {
    return db
      .select()
      .from(reconcileRuns)
      .where(
        and(
          eq(reconcileRuns.subjectType, "hosting_target"),
          eq(reconcileRuns.subjectId, hostingTargetId),
          eq(reconcileRuns.kind, RECONCILE_CONTAINER_HOST_RUN_KIND),
        ),
      );
  }

  return { declareIntent, reconcile, listDeclaredTargets, listRuns };
}
