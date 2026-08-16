/**
 * Server functions for the Purelymail estate browser (loxep-47o.3): domains,
 * account-wide mailboxes, and account-wide routing rules, read live against
 * the connection's real Purelymail account —
 * `apps/docs/src/content/docs/architecture/estate-browsers-design.md` §3.2.
 *
 * Every section is its OWN one-call read (Rule P6: there is no detail
 * endpoint for any Purelymail object, so no drill-in exists here at all).
 * Domains + Mailboxes + Routing rules is the fixed THREE-call overview (Rule
 * P7); the account facts (credit, ownership code) are a FOURTH call, so
 * {@link fetchPurelymailAccountFacts} is fetched lazily, only on explicit
 * header expand — the design's own resolution of the four-calls-over-budget
 * problem. `listUsers()` has a hard, unpaginated cap of
 * `PURELYMAIL_LIST_USER_LIMIT` (Rule P8: a provider list that does not
 * paginate at all renders its one call's full result and states the cap) —
 * {@link fetchPurelymailEstateMailboxes} carries that number in its own
 * result so the section can state it rather than hide it.
 *
 * ## Cross-reference reads are Loxep-DB reads, never a Purelymail call
 *
 * Every section's cross-reference against `managed_domains`/`mail_domains`/
 * `mailboxes` is a database read scoped to THIS connection
 * (`mail_domains.mail_connection_id`), matching
 * `pangolin-estate-functions.ts`'s own "a database read, batched" precedent
 * for `declared` — it never counts against the adapter's rate budget.
 *
 * ## Write affordances mount the ALREADY-GATED mail reconciler, never a new verb
 *
 * {@link triggerPurelymailDomainSync}/{@link triggerPurelymailMailboxSync}
 * call `getMailSyncServiceForConnection` (`admin.ts`), which ALWAYS passes
 * `connectionId` into `createMailSyncService` — so `mail-sync.ts`'s
 * write-authorization gate is live on every click, with no code path that
 * skips it (Rule P10; owner ruling 2026-08-16 #3: an estate page mounts
 * service-layer paths, never a per-verb whitelist). Neither action is
 * reachable from a row whose domain has no `managed_domains` row — an
 * undeclared domain has no `domainId` to sync, and creating one here would
 * be a NEW write path (forbidden independently of the gate). Admin-only,
 * matching every other write in this feature area.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { estateError, estateOk } from '@/features/estate/types';
import { classifyCaughtProviderError } from '@/features/estate/error-taxonomy';
import type { EstateSectionResult } from '@/features/estate/types';

const PURELYMAIL_PROVIDER = 'purelymail';

function iso(date: Date): string {
  return date.toISOString();
}

const connectionIdInput = z.strictObject({ connectionId: z.uuid() });

/** Resolves the connection and throws unless it is really a Purelymail one — every handler below starts here. */
async function requirePurelymailConnection(connectionId: string): Promise<void> {
  const { getAdminServices } = await import('@/server/admin');
  const { connections } = getAdminServices();
  const connection = await connections.getConnection(connectionId);
  if (connection.provider !== PURELYMAIL_PROVIDER) {
    throw new Error(`connection "${connectionId}" is not a Purelymail connection`);
  }
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export interface PurelymailEstateDomainDto {
  name: string;
  allowAccountReset: boolean;
  symbolicSubaddressing: boolean;
  isShared: boolean;
  dns: { passesMx: boolean; passesSpf: boolean; passesDkim: boolean; passesDmarc: boolean };
  /** `null` when Loxep has no `managed_domains`/`mail_domains` row for this domain on THIS connection — the account's real shape, per the design's "highest-value fact this page adds". */
  loxep: {
    managedDomainId: string;
    /** Loxep's own `managed_domains.state` value, verbatim — Loxep's own record, not provider truth, so Rule P3 does not apply to it. */
    state: string;
    registeredAtProvider: boolean;
    ownershipVerified: boolean;
  } | null;
}

export const fetchPurelymailEstateDomains = createServerFn({ method: 'GET' })
  .inputValidator(connectionIdInput)
  .handler(async ({ data }): Promise<EstateSectionResult<PurelymailEstateDomainDto[]>> => {
    const { requireSession, getAdminServices, getPurelymailAdapterForConnection } =
      await import('@/server/admin');
    await requireSession();
    await requirePurelymailConnection(data.connectionId);
    const readAt = iso(new Date());

    const { adapter } = await getPurelymailAdapterForConnection(data.connectionId);
    let live: Awaited<ReturnType<typeof adapter.listDomains>>;
    try {
      live = await adapter.listDomains();
    } catch (error) {
      return estateError(classifyCaughtProviderError(error, 'could not list domains'), readAt);
    }

    const { handle } = getAdminServices();
    const managed = await handle.db.query.managedDomains.findMany({
      columns: { id: true, name: true, state: true }
    });
    const mail = await handle.db.query.mailDomains.findMany({
      where: (table, { eq }) => eq(table.mailConnectionId, data.connectionId),
      columns: { domainId: true, providerAddedAt: true, ownershipVerifiedAt: true }
    });
    const mailByDomainId = new Map(mail.map((row) => [row.domainId, row]));
    const managedByName = new Map(
      managed
        .filter((row) => mailByDomainId.has(row.id))
        .map((row) => [row.name, { row, mail: mailByDomainId.get(row.id) }])
    );

    return estateOk(
      live.map((domain) => {
        const entry = managedByName.get(domain.name);
        return {
          name: domain.name,
          allowAccountReset: domain.allowAccountReset,
          symbolicSubaddressing: domain.symbolicSubaddressing,
          isShared: domain.isShared,
          dns: domain.dns,
          loxep:
            entry === undefined
              ? null
              : {
                  managedDomainId: entry.row.id,
                  state: entry.row.state,
                  registeredAtProvider: entry.mail?.providerAddedAt !== null,
                  ownershipVerified: entry.mail?.ownershipVerifiedAt !== null
                }
        };
      }),
      readAt
    );
  });

// ---------------------------------------------------------------------------
// Mailboxes — ACCOUNT-WIDE (Purelymail's listUsers has no per-domain filter)
// ---------------------------------------------------------------------------

export interface PurelymailEstateMailboxDto {
  address: string;
  localPart: string;
  domainName: string;
  loxep: { mailboxId: string; managedDomainId: string; kind: string } | null;
}

export interface PurelymailEstateMailboxesDto {
  /** `PURELYMAIL_LIST_USER_LIMIT` — Rule P8: a provider list with no pagination at all states its cap rather than hiding it. */
  limit: number;
  addresses: PurelymailEstateMailboxDto[];
}

async function loxepMailboxCrossReference(
  handle: import('@loxep/db').DbHandle
): Promise<Map<string, { mailboxId: string; managedDomainId: string; kind: string }>> {
  const [rows, domains] = await Promise.all([
    handle.db.query.mailboxes.findMany({
      columns: { id: true, domainId: true, localPart: true, kind: true }
    }),
    handle.db.query.managedDomains.findMany({ columns: { id: true, name: true } })
  ]);
  const domainNameById = new Map(domains.map((row) => [row.id, row.name]));
  const byAddress = new Map<string, { mailboxId: string; managedDomainId: string; kind: string }>();
  for (const row of rows) {
    const domainName = domainNameById.get(row.domainId);
    if (domainName === undefined) continue;
    byAddress.set(`${row.localPart}@${domainName}`, {
      mailboxId: row.id,
      managedDomainId: row.domainId,
      kind: row.kind
    });
  }
  return byAddress;
}

export const fetchPurelymailEstateMailboxes = createServerFn({ method: 'GET' })
  .inputValidator(connectionIdInput)
  .handler(async ({ data }): Promise<EstateSectionResult<PurelymailEstateMailboxesDto>> => {
    const { requireSession, getAdminServices, getFleetModule, getPurelymailAdapterForConnection } =
      await import('@/server/admin');
    await requireSession();
    await requirePurelymailConnection(data.connectionId);
    const readAt = iso(new Date());

    const { adapter } = await getPurelymailAdapterForConnection(data.connectionId);
    // `getFleetModule()`, never a bare `import('@loxep/app')` — that
    // module's own doc explains why a statically-analyzable dynamic import
    // of the worker composition breaks the SSR bundle
    // (`__dirname is not defined in ES module scope`, live-caught by this
    // section's own e2e test); `getFleetModule` is the one sanctioned way
    // `apps/web` reaches it, matching `getPurelymailAdapterForConnection`'s
    // own construction one line up.
    const { PURELYMAIL_LIST_USER_LIMIT } = await getFleetModule();
    let addresses: string[];
    try {
      addresses = await adapter.listUsers();
    } catch (error) {
      return estateError(classifyCaughtProviderError(error, 'could not list mailboxes'), readAt);
    }

    const { handle } = getAdminServices();
    const crossReference = await loxepMailboxCrossReference(handle);

    return estateOk(
      {
        limit: PURELYMAIL_LIST_USER_LIMIT,
        addresses: addresses.map((address) => {
          const atIndex = address.indexOf('@');
          const localPart = atIndex === -1 ? address : address.slice(0, atIndex);
          const domainName = atIndex === -1 ? '' : address.slice(atIndex + 1);
          return {
            address,
            localPart,
            domainName,
            loxep: crossReference.get(address) ?? null
          };
        })
      },
      readAt
    );
  });

// ---------------------------------------------------------------------------
// Routing rules — ACCOUNT-WIDE
// ---------------------------------------------------------------------------

export interface PurelymailEstateRoutingRuleDto {
  id: number;
  domainName: string;
  matchUser: string;
  prefix: boolean;
  catchall: boolean;
  targetAddresses: string[];
  loxep: { mailboxId: string; managedDomainId: string } | null;
}

export const fetchPurelymailEstateRoutingRules = createServerFn({ method: 'GET' })
  .inputValidator(connectionIdInput)
  .handler(async ({ data }): Promise<EstateSectionResult<PurelymailEstateRoutingRuleDto[]>> => {
    const { requireSession, getAdminServices, getPurelymailAdapterForConnection } =
      await import('@/server/admin');
    await requireSession();
    await requirePurelymailConnection(data.connectionId);
    const readAt = iso(new Date());

    const { adapter } = await getPurelymailAdapterForConnection(data.connectionId);
    let rules: Awaited<ReturnType<typeof adapter.listRoutingRules>>;
    try {
      rules = await adapter.listRoutingRules();
    } catch (error) {
      return estateError(
        classifyCaughtProviderError(error, 'could not list routing rules'),
        readAt
      );
    }

    const { handle } = getAdminServices();
    const crossReference = await loxepMailboxCrossReference(handle);

    return estateOk(
      rules.map((rule) => ({
        id: rule.id,
        domainName: rule.domainName,
        matchUser: rule.matchUser,
        prefix: rule.prefix,
        catchall: rule.catchall,
        targetAddresses: rule.targetAddresses,
        loxep: crossReference.get(`${rule.matchUser}@${rule.domainName}`) ?? null
      })),
      readAt
    );
  });

// ---------------------------------------------------------------------------
// Account facts — LAZY, on header expand only (the fourth call)
// ---------------------------------------------------------------------------

export interface PurelymailAccountFactsDto {
  /** The provider's own string, verbatim — Rule P3. */
  credit: string;
  ownershipCode: string;
}

export const fetchPurelymailAccountFacts = createServerFn({ method: 'GET' })
  .inputValidator(connectionIdInput)
  .handler(async ({ data }): Promise<EstateSectionResult<PurelymailAccountFactsDto>> => {
    const { requireSession, getPurelymailAdapterForConnection } = await import('@/server/admin');
    await requireSession();
    await requirePurelymailConnection(data.connectionId);
    const readAt = iso(new Date());

    const { adapter } = await getPurelymailAdapterForConnection(data.connectionId);
    try {
      const [credit, ownershipCode] = await Promise.all([
        adapter.checkAccountCredit(),
        adapter.getOwnershipCode()
      ]);
      return estateOk({ credit, ownershipCode }, readAt);
    } catch (error) {
      return estateError(
        classifyCaughtProviderError(error, 'could not read account facts'),
        readAt
      );
    }
  });

// ---------------------------------------------------------------------------
// Write affordances — mount the already-gated mail reconciler (Rule P10)
// ---------------------------------------------------------------------------

const domainSyncInput = z.strictObject({ connectionId: z.uuid(), domainId: z.uuid() });

export interface PurelymailSyncActionDto {
  runId: string;
  status: 'succeeded' | 'failed' | 'partial';
  outcome: string;
  blocked: boolean;
}

/**
 * Mounts `MailSyncService.runMailDomainSync` — "Register/verify at
 * Purelymail" for one domain Loxep already declares. Admin-only. The
 * connection's write-policy tier is checked by `mail-sync.ts` itself, not
 * duplicated here; the UI checks the SAME tier (already on the header) to
 * decide whether to offer this button at all, so a click that reaches this
 * function is never a surprise blocked result.
 */
export const triggerPurelymailDomainSync = createServerFn({ method: 'POST' })
  .inputValidator(domainSyncInput)
  .handler(async ({ data }): Promise<PurelymailSyncActionDto> => {
    const { requireAdmin, getMailSyncServiceForConnection } = await import('@/server/admin');
    const session = await requireAdmin();
    const sync = await getMailSyncServiceForConnection(data.connectionId);
    const result = await sync.runMailDomainSync({
      domainId: data.domainId,
      trigger: 'manual',
      actorUserId: session.user.id,
      actorIsAdmin: true
    });
    return {
      runId: result.runId,
      status: result.status,
      outcome: result.outcome,
      blocked: result.outcome === 'write_policy_blocked'
    };
  });

/** Mounts `MailSyncService.runMailboxSync` — "Sync mailboxes" for one domain. Same gate, same admin-only rule. */
export const triggerPurelymailMailboxSync = createServerFn({ method: 'POST' })
  .inputValidator(domainSyncInput)
  .handler(async ({ data }): Promise<PurelymailSyncActionDto> => {
    const { requireAdmin, getMailSyncServiceForConnection } = await import('@/server/admin');
    const session = await requireAdmin();
    const sync = await getMailSyncServiceForConnection(data.connectionId);
    const result = await sync.runMailboxSync({
      domainId: data.domainId,
      trigger: 'manual',
      actorUserId: session.user.id,
      actorIsAdmin: true
    });
    // `runMailboxSync` has no `write_policy_blocked` outcome value of its
    // own (mail-sync.ts's `MailboxSyncResult` reports the gate through
    // `status`/`created===0` instead) — a 'partial' status with nothing
    // created or deleted is this action's own blocked signal.
    return {
      runId: result.runId,
      status: result.status,
      outcome: result.status === 'partial' ? 'write_policy_blocked' : 'synced',
      blocked: result.status === 'partial'
    };
  });
