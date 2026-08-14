/**
 * Server functions for the `/infrastructure` workspace (Phase 7 milestone 3,
 * loxep-lmy.3).
 *
 * Handlers use dynamic imports so `@/server/admin` (and the server packages
 * behind it) stay out of the client bundle; only type-only imports from
 * server packages are allowed at the top level here — mirrors
 * `@/server/market-functions.ts` and `@/server/admin-functions.ts`.
 *
 * Role gates (ADR-0017): reads of ordinary product data call `requireSession`
 * (any authenticated member); mutations call `requireAdmin`.
 *
 * ## Two behaviors that are design constraints, restated here because a
 * server function is where they could be silently violated
 *
 * 1. **The new-domain form writes intent and enqueues, then returns — it
 *    never awaits a provider call.** {@link createManagedDomain} calls
 *    `managedDomains.create`, which enqueues `infrastructure.materialize-
 *    records` in the SAME database transaction and returns immediately. There
 *    is no code path here that talks to a DNS provider synchronously.
 * 2. **Minting a token is a request-scoped admin action, never a job.**
 *    {@link mintDnsProviderToken} calls `tokens.mint` directly, in this
 *    handler, and returns the plaintext value in ITS OWN response — the one
 *    channel ADR-0022 permits. No function here enqueues a mint.
 *
 * Secret values are never rendered by any OTHER surface: {@link
 * mintDnsProviderToken} and {@link rollDnsProviderToken} are the only two
 * functions in this module whose return type carries a `value` field.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { JsonValue } from '@/server/admin-functions';
import type { TailnetAddressKind } from '@loxep/infrastructure';

function iso(date: Date): string;
function iso(date: Date | null | undefined): string | null;
function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Shared option lists
// ---------------------------------------------------------------------------

export interface ConnectionOptionDto {
  id: string;
  name: string;
  status: string;
}

/** DNS-provider connections (`connections.kind = 'dns'`) for the new-domain wizard. */
export const fetchDnsConnectionOptions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ConnectionOptionDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const rows = await getAdminServices().connections.listConnections({ kind: 'dns' });
    return rows.map((row) => ({ id: row.id, name: row.name, status: row.status }));
  }
);

/** Mail-provider connections (`connections.kind = 'mail'`) for "enable mail". */
export const fetchMailConnectionOptions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ConnectionOptionDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const rows = await getAdminServices().connections.listConnections({ kind: 'mail' });
    return rows.map((row) => ({ id: row.id, name: row.name, status: row.status }));
  }
);

export interface HostingTargetOptionDto {
  id: string;
  name: string;
  controlSurface: string;
}

/** Every non-decommissioned hosting target, for the apex-target and mint-scope pickers. */
export const fetchHostingTargetOptions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<HostingTargetOptionDto[]> => {
    const { requireSession, getHostingTargetsService } = await import('@/server/admin');
    await requireSession();
    const rows = await getHostingTargetsService().list();
    return rows
      .filter((row) => row.decommissionedAt === null)
      .map((row) => ({ id: row.id, name: row.name, controlSurface: row.controlSurface }));
  }
);

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface InfrastructureOverviewDto {
  domainCount: number;
  domainsNeedingAttentionCount: number;
  hostingTargetCount: number;
  dnsProviderTokenCount: number;
  unresolvedDriftCount: number;
  domainsNeedingAttention: {
    id: string;
    name: string;
    state: string;
    driftDetectedAt: string | null;
    lastErrorCode: string | null;
  }[];
  recentRuns: {
    id: string;
    kind: string;
    subjectType: string;
    status: string;
    mode: string;
    startedAt: string;
    finishedAt: string | null;
  }[];
}

export const fetchInfrastructureOverview = createServerFn({ method: 'GET' }).handler(
  async (): Promise<InfrastructureOverviewDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();

    const [domains, hostingTargets, tokens, unresolvedDrift, recentRuns] = await Promise.all([
      handle.db.query.managedDomains.findMany(),
      handle.db.query.hostingTargets.findMany({
        where: (table, { isNull }) => isNull(table.decommissionedAt)
      }),
      handle.db.query.dnsProviderTokens.findMany(),
      handle.db.query.dnsDriftFindings.findMany({
        where: (table, { isNull }) => isNull(table.resolvedAt)
      }),
      handle.db.query.reconcileRuns.findMany({
        orderBy: (table, { desc }) => [desc(table.startedAt)],
        limit: 10
      })
    ]);

    const needingAttention = domains.filter(
      (domain) => domain.state !== 'ready' || domain.driftDetectedAt !== null
    );

    return {
      domainCount: domains.length,
      domainsNeedingAttentionCount: needingAttention.length,
      hostingTargetCount: hostingTargets.length,
      dnsProviderTokenCount: tokens.length,
      unresolvedDriftCount: unresolvedDrift.length,
      domainsNeedingAttention: needingAttention.slice(0, 10).map((domain) => ({
        id: domain.id,
        name: domain.name,
        state: domain.state,
        driftDetectedAt: iso(domain.driftDetectedAt),
        lastErrorCode: domain.lastErrorCode
      })),
      recentRuns: recentRuns.map((run) => ({
        id: run.id,
        kind: run.kind,
        subjectType: run.subjectType,
        status: run.status,
        mode: run.mode,
        startedAt: iso(run.startedAt),
        finishedAt: iso(run.finishedAt)
      }))
    };
  }
);

// ---------------------------------------------------------------------------
// Managed domains (loxep-lmy.3)
// ---------------------------------------------------------------------------

export interface ManagedDomainDto {
  id: string;
  name: string;
  state: string;
  dnsConnectionId: string;
  apexTargetId: string | null;
  apexTargetName: string | null;
  apexProxied: boolean;
  wildcardProxied: boolean;
  mailEnabled: boolean;
  mailRegistered: boolean;
  mailVerified: boolean;
  registrar: string | null;
  zoneNameservers: string[] | null;
  driftDetectedAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  lastReconciledAt: string | null;
  createdAt: string;
}

export const fetchManagedDomains = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ManagedDomainDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();

    const [domains, hostingTargets, mailDomains] = await Promise.all([
      handle.db.query.managedDomains.findMany({
        orderBy: (table, { asc }) => [asc(table.name)]
      }),
      handle.db.query.hostingTargets.findMany({ columns: { id: true, name: true } }),
      handle.db.query.mailDomains.findMany({
        columns: { domainId: true, providerAddedAt: true, ownershipVerifiedAt: true }
      })
    ]);
    const targetNameById = new Map(hostingTargets.map((row) => [row.id, row.name]));
    const mailByDomainId = new Map(mailDomains.map((row) => [row.domainId, row]));

    return domains.map((domain) => {
      const mail = mailByDomainId.get(domain.id);
      return {
        id: domain.id,
        name: domain.name,
        state: domain.state,
        dnsConnectionId: domain.dnsConnectionId,
        apexTargetId: domain.apexTargetId,
        apexTargetName: domain.apexTargetId
          ? (targetNameById.get(domain.apexTargetId) ?? null)
          : null,
        apexProxied: domain.apexProxied,
        wildcardProxied: domain.wildcardProxied,
        mailEnabled: domain.mailEnabled,
        mailRegistered: mail?.providerAddedAt !== undefined && mail.providerAddedAt !== null,
        mailVerified: mail?.ownershipVerifiedAt !== undefined && mail.ownershipVerifiedAt !== null,
        registrar: domain.registrar,
        zoneNameservers: domain.zoneNameservers,
        driftDetectedAt: iso(domain.driftDetectedAt),
        lastErrorAt: iso(domain.lastErrorAt),
        lastErrorCode: domain.lastErrorCode,
        lastReconciledAt: iso(domain.lastReconciledAt),
        createdAt: iso(domain.createdAt)
      };
    });
  }
);

export interface DnsRecordDto {
  id: string;
  type: string;
  name: string;
  content: string;
  ttlSeconds: number | null;
  proxied: boolean;
  owner: string;
  lastSyncedAt: string | null;
}

export interface DnsDriftFindingDto {
  id: string;
  kind: string;
  recordType: string;
  recordName: string;
  desiredContent: string | null;
  observedContent: string | null;
  desiredProxied: boolean | null;
  observedProxied: boolean | null;
  firstDetectedAt: string;
  lastDetectedAt: string;
}

export interface MailboxDto {
  id: string;
  localPart: string;
  kind: string;
  forwardTo: string | null;
  hasSecret: boolean;
  providerCreatedAt: string | null;
  desiredDeletedAt: string | null;
}

export interface MailStateDto {
  mailConnectionId: string;
  providerAddedAt: string | null;
  ownershipVerifiedAt: string | null;
  verifyAttempts: number;
  lastVerifyError: string | null;
  lastVerifyAt: string | null;
}

export interface ManagedDomainDetailDto extends ManagedDomainDto {
  records: DnsRecordDto[];
  unresolvedDrift: DnsDriftFindingDto[];
  mail: MailStateDto | null;
  mailboxes: MailboxDto[];
}

export const fetchManagedDomain = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ name: z.string().trim().min(1) }))
  .handler(async ({ data }): Promise<ManagedDomainDetailDto> => {
    const { requireSession, getAdminServices, getInfrastructureMailService, getDriftService } =
      await import('@/server/admin');
    await requireSession();
    const { managedDomains, hostingTargets: targets } = getAdminServices();
    const domain = await managedDomains.findByName(data.name);
    if (domain === null) {
      throw new Error(`Managed domain "${data.name}" not found`);
    }

    const mailService = getInfrastructureMailService();
    const drift = getDriftService();
    const [records, unresolvedDrift, mail, mailboxes, apexTarget] = await Promise.all([
      managedDomains.listRecords(domain.id),
      drift.listUnresolved(domain.id),
      mailService.find(domain.id),
      mailService.listMailboxes(domain.id),
      domain.apexTargetId ? targets.get(domain.apexTargetId).catch(() => null) : null
    ]);

    return {
      id: domain.id,
      name: domain.name,
      state: domain.state,
      dnsConnectionId: domain.dnsConnectionId,
      apexTargetId: domain.apexTargetId,
      apexTargetName: apexTarget?.name ?? null,
      apexProxied: domain.apexProxied,
      wildcardProxied: domain.wildcardProxied,
      mailEnabled: domain.mailEnabled,
      mailRegistered: mail?.providerAddedAt !== null && mail?.providerAddedAt !== undefined,
      mailVerified: mail?.ownershipVerifiedAt !== null && mail?.ownershipVerifiedAt !== undefined,
      registrar: domain.registrar,
      zoneNameservers: domain.zoneNameservers,
      driftDetectedAt: iso(domain.driftDetectedAt),
      lastErrorAt: iso(domain.lastErrorAt),
      lastErrorCode: domain.lastErrorCode,
      lastReconciledAt: iso(domain.lastReconciledAt),
      createdAt: iso(domain.createdAt),
      records: records.map((record) => ({
        id: record.id,
        type: record.type,
        name: record.name,
        content: record.content,
        ttlSeconds: record.ttlSeconds,
        proxied: record.proxied,
        owner: record.owner,
        lastSyncedAt: iso(record.lastSyncedAt)
      })),
      unresolvedDrift: unresolvedDrift.map((finding) => ({
        id: finding.id,
        kind: finding.kind,
        recordType: finding.recordType,
        recordName: finding.recordName,
        desiredContent: finding.desiredContent,
        observedContent: finding.observedContent,
        desiredProxied: finding.desiredProxied,
        observedProxied: finding.observedProxied,
        firstDetectedAt: iso(finding.firstDetectedAt),
        lastDetectedAt: iso(finding.lastDetectedAt)
      })),
      mail:
        mail === null
          ? null
          : {
              mailConnectionId: mail.mailConnectionId,
              providerAddedAt: iso(mail.providerAddedAt),
              ownershipVerifiedAt: iso(mail.ownershipVerifiedAt),
              verifyAttempts: mail.verifyAttempts,
              lastVerifyError: mail.lastVerifyError,
              lastVerifyAt: iso(mail.lastVerifyAt)
            },
      mailboxes: mailboxes.map((mailbox) => ({
        id: mailbox.id,
        localPart: mailbox.localPart,
        kind: mailbox.kind,
        forwardTo: mailbox.forwardTo,
        hasSecret: mailbox.secretId !== null,
        providerCreatedAt: iso(mailbox.providerCreatedAt),
        desiredDeletedAt: iso(mailbox.desiredDeletedAt)
      }))
    };
  });

const createManagedDomainInput = z.strictObject({
  name: z.string().trim().min(1),
  dnsConnectionId: z.uuid(),
  apexTargetId: z.uuid().nullish(),
  apexProxied: z.boolean().optional(),
  wildcardProxied: z.boolean().optional(),
  mailEnabled: z.boolean().optional(),
  registrar: z.string().trim().min(1).nullish(),
  notes: z.string().trim().min(1).nullish()
});

/**
 * Writes intent and enqueues `infrastructure.materialize-records`, then
 * returns — it never awaits a provider call. The reconciler is asynchronous;
 * the caller redirects to the domain detail page, where state advances as
 * the worker (not this request) drives the provisioning chain forward.
 */
export const createManagedDomain = createServerFn({ method: 'POST' })
  .inputValidator(createManagedDomainInput)
  .handler(async ({ data }): Promise<{ id: string; name: string }> => {
    const { requireAdmin, getManagedDomainsService } = await import('@/server/admin');
    const session = await requireAdmin();
    const row = await getManagedDomainsService().create({
      name: data.name,
      dnsConnectionId: data.dnsConnectionId,
      apexTargetId: data.apexTargetId,
      apexProxied: data.apexProxied,
      wildcardProxied: data.wildcardProxied,
      mailEnabled: data.mailEnabled,
      registrar: data.registrar,
      notes: data.notes,
      createdByUserId: session.user.id
    });
    return { id: row.id, name: row.name };
  });

const updateManagedDomainIntentInput = z.strictObject({
  id: z.uuid(),
  apexTargetId: z.uuid().nullish(),
  apexProxied: z.boolean().optional(),
  wildcardProxied: z.boolean().optional(),
  mailEnabled: z.boolean().optional(),
  registrar: z.string().trim().min(1).nullish(),
  notes: z.string().trim().min(1).nullish()
});

export const updateManagedDomainIntent = createServerFn({ method: 'POST' })
  .inputValidator(updateManagedDomainIntentInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getManagedDomainsService } = await import('@/server/admin');
    const session = await requireAdmin();
    const { id, ...patch } = data;
    const row = await getManagedDomainsService().updateIntent(id, {
      ...patch,
      actorUserId: session.user.id
    });
    return { id: row.id };
  });

/**
 * "Adopt": write the observed value into `dns_records` as a `manual` record.
 * Reality is never overwritten — intent catches up with it. The finding
 * itself resolves on the NEXT sync (as `disappeared`, once observed and
 * desired agree), matching `@loxep/infrastructure`'s own tested behavior
 * rather than marking it resolved optimistically here.
 */
export const adoptDriftFinding = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ domainId: z.uuid(), findingId: z.uuid() }))
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getAdminServices, getManagedDomainsService } =
      await import('@/server/admin');
    const session = await requireAdmin();
    const { handle } = getAdminServices();
    const finding = await handle.db.query.dnsDriftFindings.findFirst({
      where: (table, { eq }) => eq(table.id, data.findingId)
    });
    if (finding === undefined || finding.domainId !== data.domainId) {
      throw new Error(`Drift finding "${data.findingId}" not found`);
    }
    if (finding.observedContent === null) {
      throw new Error(
        'This finding has no observed value to adopt (a missing record has nothing to adopt).'
      );
    }
    const record = await getManagedDomainsService().addManualRecord(
      data.domainId,
      {
        type: finding.recordType,
        name: finding.recordName,
        content: finding.observedContent,
        proxied: finding.observedProxied ?? false,
        externalRecordId: finding.externalRecordId
      },
      { actorUserId: session.user.id }
    );
    return { id: record.id };
  });

export const dismissDriftFinding = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ findingId: z.uuid() }))
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getDriftService } = await import('@/server/admin');
    const session = await requireAdmin();
    const row = await getDriftService().dismiss(data.findingId, { actorUserId: session.user.id });
    return { id: row.id };
  });

export const enableMailForDomain = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ domainId: z.uuid(), mailConnectionId: z.uuid() }))
  .handler(async ({ data }): Promise<{ domainId: string }> => {
    const { requireAdmin, getInfrastructureMailService } = await import('@/server/admin');
    const session = await requireAdmin();
    const row = await getInfrastructureMailService().enableMail(data.domainId, {
      mailConnectionId: data.mailConnectionId,
      actorUserId: session.user.id
    });
    return { domainId: row.domainId };
  });

export const applyDefaultMailboxTemplate = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ domainId: z.uuid() }))
  .handler(
    async ({ data }): Promise<{ created: number; resurrected: number; unchanged: number }> => {
      const { requireAdmin, getInfrastructureMailService } = await import('@/server/admin');
      const session = await requireAdmin();
      return getInfrastructureMailService().applyTemplate(data.domainId, undefined, {
        actorUserId: session.user.id
      });
    }
  );

/**
 * A manual "sync now": re-enqueues `infrastructure.sync-records` in `check`
 * mode. Enqueues rather than running inline — the same asynchronous shape
 * every intent-changing action here uses; the run's result shows up on
 * `/infrastructure/runs` once the worker processes it.
 */
export const requestDomainResync = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ domainId: z.uuid() }))
  .handler(async ({ data }): Promise<{ enqueued: true }> => {
    const [{ requireAdmin, getAdminServices, getInfrastructureEnqueue }, infrastructure] =
      await Promise.all([import('@/server/admin'), import('@loxep/infrastructure')]);
    await requireAdmin();
    const { handle } = getAdminServices();
    const enqueue = getInfrastructureEnqueue();
    await handle.db.transaction(async (tx) => {
      await enqueue(
        tx,
        infrastructure.SYNC_RECORDS_TASK,
        { domainId: data.domainId, mode: 'check', trigger: 'manual' },
        { jobKey: infrastructure.domainJobKey(infrastructure.SYNC_RECORDS_TASK, data.domainId) }
      );
    });
    return { enqueued: true };
  });

// ---------------------------------------------------------------------------
// Hosting targets / fleet (loxep-lmy.3)
// ---------------------------------------------------------------------------

export interface HostingTargetDto {
  id: string;
  name: string;
  controlSurface: string;
  provider: string | null;
  region: string | null;
  addressV4: string | null;
  addressV6: string | null;
  frontedByTargetId: string | null;
  frontedByTargetName: string | null;
  domainCount: number;
  tokenCount: number;
  decommissionedAt: string | null;
  createdAt: string;
}

export const fetchHostingTargets = createServerFn({ method: 'GET' }).handler(
  async (): Promise<HostingTargetDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const [targets, domains, tokens] = await Promise.all([
      handle.db.query.hostingTargets.findMany({ orderBy: (table, { asc }) => [asc(table.name)] }),
      handle.db.query.managedDomains.findMany({ columns: { apexTargetId: true } }),
      handle.db.query.dnsProviderTokens.findMany({ columns: { hostingTargetId: true } })
    ]);
    const nameById = new Map(targets.map((row) => [row.id, row.name]));
    const domainCountByTarget = new Map<string, number>();
    for (const domain of domains) {
      if (domain.apexTargetId === null) continue;
      domainCountByTarget.set(
        domain.apexTargetId,
        (domainCountByTarget.get(domain.apexTargetId) ?? 0) + 1
      );
    }
    const tokenCountByTarget = new Map<string, number>();
    for (const token of tokens) {
      tokenCountByTarget.set(
        token.hostingTargetId,
        (tokenCountByTarget.get(token.hostingTargetId) ?? 0) + 1
      );
    }

    return targets.map((target) => ({
      id: target.id,
      name: target.name,
      controlSurface: target.controlSurface,
      provider: target.provider,
      region: target.region,
      addressV4: target.addressV4,
      addressV6: target.addressV6,
      frontedByTargetId: target.frontedByTargetId,
      frontedByTargetName: target.frontedByTargetId
        ? (nameById.get(target.frontedByTargetId) ?? null)
        : null,
      domainCount: domainCountByTarget.get(target.id) ?? 0,
      tokenCount: tokenCountByTarget.get(target.id) ?? 0,
      decommissionedAt: iso(target.decommissionedAt),
      createdAt: iso(target.createdAt)
    }));
  }
);

/**
 * One `resource_links` attachment, joined with the `external_resources` row
 * it points at (loxep-v5r.3's generic companion-link service). `id` is the
 * `external_resources` row id; `resourceId`/`purpose` are carried too so the
 * panel can address this exact attachment (the natural key includes both,
 * per `resource_links_resource_purpose_uq`) when removing it.
 */
export interface CompanionLinkDto {
  id: string;
  provider: string;
  externalType: string;
  url: string;
  title: string | null;
  resourceId: string;
  purpose: string;
  createdAt: string;
}

export interface DnsProviderTokenDto {
  id: string;
  name: string;
  externalTokenId: string;
  permissionScope: string;
  policySyncedAt: string | null;
  lastRolledAt: string | null;
  domainIds: string[];
  createdAt: string;
}

export interface HostingTargetDetailDto extends HostingTargetDto {
  frontedTargets: { id: string; name: string }[];
  domains: { id: string; name: string; state: string }[];
  tokens: DnsProviderTokenDto[];
  companionLinks: CompanionLinkDto[];
  /**
   * `null` unless the stored address itself falls in Tailscale's CGNAT or
   * ULA range (loxep-89h; loxep-50t §3.2). Classified here, server-side,
   * with the SAME `tailnetAddressKind` predicate `resolveHostingAddress`
   * refuses on — not a second copy of the CIDR literals — so the fleet
   * detail warning and the materializer's refusal can never disagree about
   * what counts as a tailnet address. Computed from `addressV4`/`addressV6`,
   * which this response already carries; no extra read.
   */
  addressV4TailnetKind: TailnetAddressKind | null;
  addressV6TailnetKind: TailnetAddressKind | null;
}

export const fetchHostingTarget = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ name: z.string().trim().min(1) }))
  .handler(async ({ data }): Promise<HostingTargetDetailDto> => {
    const {
      requireSession,
      getAdminServices,
      getDnsProviderTokensService,
      getResourceLinksService
    } = await import('@/server/admin');
    // Dynamic, not top-level: `@loxep/infrastructure` pulls in server-only
    // packages (drizzle-orm, pg, graphile-worker via other modules in its
    // barrel) that must stay out of the client bundle — same reason every
    // other server-package access in this file goes through `@/server/admin`.
    const { tailnetAddressKind } = await import('@loxep/infrastructure');
    await requireSession();
    const { handle } = getAdminServices();
    const target = await handle.db.query.hostingTargets.findFirst({
      where: (table, { eq }) => eq(table.name, data.name)
    });
    if (target === undefined) {
      throw new Error(`Hosting target "${data.name}" not found`);
    }

    const [frontedTargets, domains, tokens, tokenZoneRows, companionLinks, frontingNode] =
      await Promise.all([
        handle.db.query.hostingTargets.findMany({
          where: (table, { eq }) => eq(table.frontedByTargetId, target.id),
          columns: { id: true, name: true }
        }),
        handle.db.query.managedDomains.findMany({
          where: (table, { eq }) => eq(table.apexTargetId, target.id),
          columns: { id: true, name: true, state: true }
        }),
        getDnsProviderTokensService().listForTarget(target.id),
        handle.db.query.dnsProviderTokenZones.findMany(),
        // loxep-v5r.3's generic companion-link service — the SINGLE owner of
        // `external_resources`/`resource_links` reads/writes; this handler
        // no longer queries those two tables directly.
        getResourceLinksService().listLinksFor('hosting_target', target.id),
        target.frontedByTargetId
          ? handle.db.query.hostingTargets.findFirst({
              where: (table, { eq }) => eq(table.id, target.frontedByTargetId as string),
              columns: { id: true, name: true }
            })
          : null
      ]);

    const zonesByToken = new Map<string, string[]>();
    for (const row of tokenZoneRows) {
      const list = zonesByToken.get(row.tokenId) ?? [];
      list.push(row.domainId);
      zonesByToken.set(row.tokenId, list);
    }

    return {
      id: target.id,
      name: target.name,
      controlSurface: target.controlSurface,
      provider: target.provider,
      region: target.region,
      addressV4: target.addressV4,
      addressV6: target.addressV6,
      addressV4TailnetKind: target.addressV4 === null ? null : tailnetAddressKind(target.addressV4),
      addressV6TailnetKind: target.addressV6 === null ? null : tailnetAddressKind(target.addressV6),
      frontedByTargetId: target.frontedByTargetId,
      frontedByTargetName: frontingNode?.name ?? null,
      domainCount: domains.length,
      tokenCount: tokens.length,
      decommissionedAt: iso(target.decommissionedAt),
      createdAt: iso(target.createdAt),
      frontedTargets,
      domains,
      tokens: tokens.map((token) => ({
        id: token.id,
        name: token.name,
        externalTokenId: token.externalTokenId,
        permissionScope: token.permissionScope,
        policySyncedAt: iso(token.policySyncedAt),
        lastRolledAt: iso(token.lastRolledAt),
        domainIds: zonesByToken.get(token.id) ?? [],
        createdAt: iso(token.createdAt)
      })),
      companionLinks: companionLinks.map((link) => ({
        id: link.externalResourceId,
        provider: link.provider,
        externalType: link.externalType,
        url: link.url,
        title: link.title,
        resourceId: link.resourceId,
        purpose: link.purpose,
        createdAt: iso(link.createdAt)
      }))
    };
  });

const addCompanionLinkInput = z.strictObject({
  hostingTargetId: z.uuid(),
  provider: z.string().trim().min(1).max(100),
  externalType: z.string().trim().min(1).max(100),
  url: z.url(),
  title: z.string().trim().min(1).max(200).nullish(),
  /** Free text (loxep-v5r.3's generic tier-1 mechanism, no closed vocabulary yet). */
  purpose: z.string().trim().min(1).max(100)
});

/**
 * Adds one companion-tool link to a hosting target — the "Add tool link"
 * form the fleet detail page's `CompanionLinksPanel` renders. Writes through
 * `@loxep/domain`'s generic `resourceLinks.createLink` (loxep-v5r.3), the
 * single owner of `external_resources`/`resource_links` writes; this handler
 * does not touch either table directly.
 */
export const addCompanionLink = createServerFn({ method: 'POST' })
  .inputValidator(addCompanionLinkInput)
  .handler(async ({ data }): Promise<CompanionLinkDto> => {
    const { requireAdmin, getResourceLinksService } = await import('@/server/admin');
    await requireAdmin();
    const link = await getResourceLinksService().createLink({
      provider: data.provider,
      externalType: data.externalType,
      url: data.url,
      title: data.title ?? null,
      resourceType: 'hosting_target',
      resourceId: data.hostingTargetId,
      purpose: data.purpose
    });
    return {
      id: link.externalResourceId,
      provider: link.provider,
      externalType: link.externalType,
      url: link.url,
      title: link.title,
      resourceId: link.resourceId,
      purpose: link.purpose,
      createdAt: iso(link.createdAt)
    };
  });

const removeCompanionLinkInput = z.strictObject({
  externalResourceId: z.uuid(),
  hostingTargetId: z.uuid(),
  purpose: z.string().trim().min(1).max(100)
});

/** Removes one companion-tool link (loxep-v5r.3's generic `detachLink`, idempotent). */
export const removeCompanionLink = createServerFn({ method: 'POST' })
  .inputValidator(removeCompanionLinkInput)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { requireAdmin, getResourceLinksService } = await import('@/server/admin');
    await requireAdmin();
    await getResourceLinksService().detachLink({
      externalResourceId: data.externalResourceId,
      resourceType: 'hosting_target',
      resourceId: data.hostingTargetId,
      purpose: data.purpose
    });
    return { ok: true };
  });

const createHostingTargetInput = z.strictObject({
  name: z.string().trim().min(1),
  controlSurface: z.enum(['proxy_node', 'tunnel_client', 'direct_reverse_proxy', 'none']),
  provider: z.string().trim().min(1).nullish(),
  region: z.string().trim().min(1).nullish(),
  addressV4: z.string().trim().min(1).nullish(),
  addressV6: z.string().trim().min(1).nullish(),
  frontedByTargetId: z.uuid().nullish(),
  notes: z.string().trim().min(1).nullish()
});

export const createHostingTarget = createServerFn({ method: 'POST' })
  .inputValidator(createHostingTargetInput)
  .handler(async ({ data }): Promise<{ id: string; name: string }> => {
    const { requireAdmin, getHostingTargetsService } = await import('@/server/admin');
    const session = await requireAdmin();
    const row = await getHostingTargetsService().create({
      ...data,
      createdByUserId: session.user.id
    });
    return { id: row.id, name: row.name };
  });

export const decommissionHostingTarget = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getHostingTargetsService } = await import('@/server/admin');
    const session = await requireAdmin();
    const row = await getHostingTargetsService().decommission(data.id, {
      actorUserId: session.user.id
    });
    return { id: row.id };
  });

// ---------------------------------------------------------------------------
// Minted DNS tokens (loxep-lmy.3) — HARD CONSTRAINT: mint/roll are
// request-scoped admin actions, never enqueued. See the module doc.
// ---------------------------------------------------------------------------

const mintDnsProviderTokenInput = z.strictObject({
  hostingTargetId: z.uuid(),
  dnsConnectionId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  domainIds: z.array(z.uuid()).optional()
});

export interface MintedDnsProviderTokenDto {
  token: DnsProviderTokenDto;
  /**
   * The plaintext value. Present in THIS response only — ADR-0022's one-time
   * reveal. No other function in this module returns it, and nothing reads
   * it back afterward.
   */
  value: string;
}

export const mintDnsProviderToken = createServerFn({ method: 'POST' })
  .inputValidator(mintDnsProviderTokenInput)
  .handler(async ({ data }): Promise<MintedDnsProviderTokenDto> => {
    const { requireAdmin, getDnsProviderTokensService } = await import('@/server/admin');
    const session = await requireAdmin();
    const result = await getDnsProviderTokensService().mint({
      hostingTargetId: data.hostingTargetId,
      dnsConnectionId: data.dnsConnectionId,
      name: data.name,
      domainIds: data.domainIds,
      actorUserId: session.user.id
    });
    return {
      token: {
        id: result.token.id,
        name: result.token.name,
        externalTokenId: result.token.externalTokenId,
        permissionScope: result.token.permissionScope,
        policySyncedAt: iso(result.token.policySyncedAt),
        lastRolledAt: iso(result.token.lastRolledAt),
        domainIds: data.domainIds ?? [],
        createdAt: iso(result.token.createdAt)
      },
      value: result.value
    };
  });

export const setDnsProviderTokenZones = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ tokenId: z.uuid(), domainIds: z.array(z.uuid()) }))
  .handler(async ({ data }): Promise<{ domainIds: string[] }> => {
    const { requireAdmin, getDnsProviderTokensService } = await import('@/server/admin');
    const session = await requireAdmin();
    return getDnsProviderTokensService().setZones(data.tokenId, {
      domainIds: data.domainIds,
      actorUserId: session.user.id
    });
  });

/**
 * Rolling regenerates the value and is styled destructively in the UI —
 * scope editing and rolling are deliberately never neighbours. Also a
 * request-scoped admin action, for the same ADR-0022 reason `mint` is.
 */
export const rollDnsProviderToken = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ tokenId: z.uuid() }))
  .handler(async ({ data }): Promise<{ token: DnsProviderTokenDto; value: string }> => {
    const { requireAdmin, getDnsProviderTokensService, getAdminServices } =
      await import('@/server/admin');
    const session = await requireAdmin();
    const tokens = getDnsProviderTokensService();
    const result = await tokens.roll(data.tokenId, { actorUserId: session.user.id });
    const zones = await getAdminServices().handle.db.query.dnsProviderTokenZones.findMany({
      where: (table, { eq }) => eq(table.tokenId, data.tokenId),
      columns: { domainId: true }
    });
    return {
      token: {
        id: result.token.id,
        name: result.token.name,
        externalTokenId: result.token.externalTokenId,
        permissionScope: result.token.permissionScope,
        policySyncedAt: iso(result.token.policySyncedAt),
        lastRolledAt: iso(result.token.lastRolledAt),
        domainIds: zones.map((row) => row.domainId),
        createdAt: iso(result.token.createdAt)
      },
      value: result.value
    };
  });

/** Manual "sync policy now" — calls the idempotent, re-runnable half directly (see `tokens.ts`). */
export const requestDnsProviderTokenPolicySync = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ tokenId: z.uuid() }))
  .handler(async ({ data }): Promise<{ status: string; zoneCount: number }> => {
    const { requireAdmin, getDnsProviderTokensService } = await import('@/server/admin');
    await requireAdmin();
    const result = await getDnsProviderTokensService().syncPolicy(data.tokenId, {
      trigger: 'manual'
    });
    return { status: result.status, zoneCount: result.zoneCount };
  });

// ---------------------------------------------------------------------------
// Reconcile runs (loxep-lmy.3)
// ---------------------------------------------------------------------------

export interface ReconcileRunDto {
  id: string;
  kind: string;
  subjectType: string;
  subjectId: string;
  subjectLabel: string | null;
  mode: string;
  status: string;
  trigger: string;
  stepCount: number;
  errorSummary: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const RECONCILE_RUNS_LIMIT = 100;

export const fetchReconcileRuns = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ReconcileRunDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const runs = await handle.db.query.reconcileRuns.findMany({
      orderBy: (table, { desc }) => [desc(table.startedAt)],
      limit: RECONCILE_RUNS_LIMIT
    });

    const domainIds = runs
      .filter((run) => run.subjectType === 'domain')
      .map((run) => run.subjectId);
    const tokenIds = runs.filter((run) => run.subjectType === 'token').map((run) => run.subjectId);
    const [domains, tokens] = await Promise.all([
      domainIds.length > 0
        ? handle.db.query.managedDomains.findMany({
            where: (table, { inArray }) => inArray(table.id, domainIds),
            columns: { id: true, name: true }
          })
        : [],
      tokenIds.length > 0
        ? handle.db.query.dnsProviderTokens.findMany({
            where: (table, { inArray }) => inArray(table.id, tokenIds),
            columns: { id: true, name: true }
          })
        : []
    ]);
    const domainNameById = new Map(domains.map((row) => [row.id, row.name]));
    const tokenNameById = new Map(tokens.map((row) => [row.id, row.name]));

    return runs.map((run) => ({
      id: run.id,
      kind: run.kind,
      subjectType: run.subjectType,
      subjectId: run.subjectId,
      subjectLabel:
        run.subjectType === 'domain'
          ? (domainNameById.get(run.subjectId) ?? null)
          : run.subjectType === 'token'
            ? (tokenNameById.get(run.subjectId) ?? null)
            : null,
      mode: run.mode,
      status: run.status,
      trigger: run.trigger,
      stepCount: run.stepCount,
      errorSummary: run.errorSummary,
      startedAt: iso(run.startedAt),
      finishedAt: iso(run.finishedAt)
    }));
  }
);

export interface ReconcileRunStepDto {
  id: string;
  sequence: number;
  step: string;
  status: string;
  provider: string | null;
  requestSummary: Record<string, JsonValue> | null;
  responseSummary: Record<string, JsonValue> | null;
  errorCode: string | null;
  errorDetail: string | null;
  occurredAt: string;
}

export interface ReconcileRunDetailDto extends ReconcileRunDto {
  steps: ReconcileRunStepDto[];
}

export const fetchReconcileRun = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<ReconcileRunDetailDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const run = await handle.db.query.reconcileRuns.findFirst({
      where: (table, { eq }) => eq(table.id, data.id)
    });
    if (run === undefined) {
      throw new Error(`Reconcile run "${data.id}" not found`);
    }
    const steps = await handle.db.query.reconcileRunSteps.findMany({
      where: (table, { eq }) => eq(table.runId, data.id),
      orderBy: (table, { asc }) => [asc(table.sequence)]
    });

    let subjectLabel: string | null = null;
    if (run.subjectType === 'domain') {
      const domain = await handle.db.query.managedDomains.findFirst({
        where: (table, { eq }) => eq(table.id, run.subjectId),
        columns: { name: true }
      });
      subjectLabel = domain?.name ?? null;
    } else if (run.subjectType === 'token') {
      const token = await handle.db.query.dnsProviderTokens.findFirst({
        where: (table, { eq }) => eq(table.id, run.subjectId),
        columns: { name: true }
      });
      subjectLabel = token?.name ?? null;
    }

    return {
      id: run.id,
      kind: run.kind,
      subjectType: run.subjectType,
      subjectId: run.subjectId,
      subjectLabel,
      mode: run.mode,
      status: run.status,
      trigger: run.trigger,
      stepCount: run.stepCount,
      errorSummary: run.errorSummary,
      startedAt: iso(run.startedAt),
      finishedAt: iso(run.finishedAt),
      steps: steps.map((step) => ({
        id: String(step.id),
        sequence: step.sequence,
        step: step.step,
        status: step.status,
        provider: step.provider,
        requestSummary: step.requestSummary as Record<string, JsonValue> | null,
        responseSummary: step.responseSummary as Record<string, JsonValue> | null,
        errorCode: step.errorCode,
        errorDetail: step.errorDetail,
        occurredAt: iso(step.occurredAt)
      }))
    };
  });

/**
 * "Retry" for `/infrastructure/runs/$id`: re-drives the SAME subject through
 * its reconciler, asynchronously. A `domain` subject re-enqueues
 * `sync-records` (check mode); a `token` subject re-runs the (idempotent)
 * policy sync directly, mirroring `requestDnsProviderTokenPolicySync`.
 */
export const retryReconcileRun = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ retried: boolean }> => {
    const {
      requireAdmin,
      getAdminServices,
      getInfrastructureEnqueue,
      getDnsProviderTokensService
    } = await import('@/server/admin');
    await requireAdmin();
    const { handle } = getAdminServices();
    const run = await handle.db.query.reconcileRuns.findFirst({
      where: (table, { eq }) => eq(table.id, data.id)
    });
    if (run === undefined) {
      throw new Error(`Reconcile run "${data.id}" not found`);
    }

    if (run.subjectType === 'domain') {
      const infrastructure = await import('@loxep/infrastructure');
      const enqueue = getInfrastructureEnqueue();
      await handle.db.transaction(async (tx) => {
        await enqueue(
          tx,
          infrastructure.SYNC_RECORDS_TASK,
          { domainId: run.subjectId, mode: 'check', trigger: 'manual' },
          { jobKey: infrastructure.domainJobKey(infrastructure.SYNC_RECORDS_TASK, run.subjectId) }
        );
      });
      return { retried: true };
    }
    if (run.subjectType === 'token') {
      await getDnsProviderTokensService().syncPolicy(run.subjectId, { trigger: 'manual' });
      return { retried: true };
    }
    throw new Error(`No retry action exists yet for subject type "${run.subjectType}"`);
  });
