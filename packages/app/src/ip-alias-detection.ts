/**
 * Dynamic-IP alias detection sweep (Pangolin chain design milestone 5,
 * `loxep-acj.5`, "Dynamic IP: named aliases, fan-out, and never a silent
 * apply"). This is the composition root's piece: the domain/infrastructure
 * layers own the pure logic (`@loxep/domain`'s `ip-aliases.ts` schema,
 * `@loxep/infrastructure`'s `materializeProxyRuleValue`/`planIpAliasFanOut`),
 * and this module is where the two OUTBOUND reads a detector needs — a DNS
 * lookup, and a Pangolin adapter call — actually happen, exactly the role
 * `infrastructure-proxy.ts` and `fleet-health.ts` already play for their own
 * provider-specific reads. `@loxep/infrastructure` takes no DNS or
 * integration-package dependency on purpose (`proxy-port.ts`'s own module
 * doc); this file is where that boundary is crossed.
 *
 * ## The update flow, matching the design's own words exactly
 *
 * ```text
 * detector observes a new address for alias 'home'
 *    -> the alias is updated, previousAddress retained      (UNCONDITIONAL —
 *                                                              independent of
 *                                                              autoApply)
 *    -> every dynamic_ip rule referencing alias:home is read back, across
 *       every domain and hosting target (ProxyResourcesService's
 *       listRulesReferencingAlias — the cross-domain fan-out query)
 *    -> for each affected resource, reconcile() runs (trigger: 'poll'):
 *         mode 'apply'  when entry.autoApply is true — the ADD half only,
 *                        gated by write-policy.ts's assertWritePolicy
 *                        ('additive' tier or above) and wouldLockOut's
 *                        self-managed-resource clauses, exactly as a
 *                        'manual' apply is. Retirement is never attempted —
 *                        see ip-aliases.ts's module doc for why the ordinary
 *                        create-rule path IS the add-then-retire ADD half.
 *         mode 'check'  otherwise — still records a run and a diff, which is
 *                        what a future one-click-apply UI reads.
 *    -> ONE notification event, dedup-keyed on the change itself (never per
 *       sweep), summarizing "N rules across M resources reference an address
 *       that changed" — fired whether or not it auto-applied.
 * ```
 *
 * ## Detectors
 *
 * `manual` has no detector — this sweep skips it entirely; the operator
 * edits the address by hand, and there is nothing to auto-detect. `dns`
 * resolves the alias's stored `hostname` via `node:dns/promises`' `resolve4`
 * (one A-record lookup, no new outbound dependency — the design's own
 * rejection of a third-party "what is my IP" service). `pangolin_site` reads
 * `PangolinSiteFact.endpoint` for the alias's stored `connectionId`/`siteId`
 * — UNVERIFIED against a live read (M1's own finding: the Integration API
 * was unreachable from the build network), so this detector degrades to "no
 * detection this round" on ANY failure (a null site, a null endpoint, an
 * unparseable endpoint, a thrown error) rather than treating absence as a
 * signal — exactly the honesty `PangolinSiteFact.endpoint`'s own doc comment
 * already carries forward.
 *
 * A detector returning `null`, or an address IDENTICAL to what is already
 * stored, is a genuine no-op: no settings write, no fan-out read, no
 * notification. This is the "detection idempotency" property `bd show
 * loxep-acj.5` names explicitly.
 */
import { resolve4 } from "node:dns/promises";
import {
  createTransactionalNotificationEnqueue,
  formatIpAliasReference,
  ipAliasesSetting,
  publishNotificationEvent,
} from "@loxep/domain";
import type { IpAliasEntry, IpAliasMap, NotificationEnqueue } from "@loxep/domain";
import { createProxyResourcesService, planIpAliasFanOut } from "@loxep/infrastructure";
import type { IpAliasFanOutResourceInput, ObservedProxyResource } from "@loxep/infrastructure";
import { defineTask, jobKeyFor } from "@loxep/jobs";
import type { LoxepTask } from "@loxep/jobs";
import { z } from "zod";
import { resolveProxyProviderForHostingTarget } from "./infrastructure-proxy.ts";
import type { AppCronItem } from "./refresh-tokens.ts";
import type { AppServices } from "./services.ts";

/** Resolves a hostname to its A-record addresses — the `dns` detector's own read. Injectable for tests. */
export type DnsResolver = (hostname: string) => Promise<string[]>;

const defaultDnsResolver: DnsResolver = (hostname) => resolve4(hostname);

/** `null` on ANY failure (NXDOMAIN, timeout, no records) — "no detection this round", never an error the sweep surfaces. */
async function detectDnsAddress(
  hostname: string,
  resolver: DnsResolver,
): Promise<string | null> {
  try {
    const addresses = await resolver(hostname);
    return addresses[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * `endpoint` is one of `PangolinSiteFact`'s UNVERIFIED fields (adapter.ts's
 * own doc) and its exact shape against a live instance is unconfirmed — this
 * parser accepts only an unambiguous bare IPv4 literal or an
 * `ipv4:port` pair, and returns `null` for anything else (a hostname, an
 * IPv6 literal, an unparseable string) rather than guessing. A `null` here
 * becomes "no detection this round" at the call site, never a bad address
 * silently fed into a firewall rule.
 */
export function extractAddressFromPangolinEndpoint(endpoint: string): string | null {
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(endpoint);
  if (withPort?.[1] !== undefined) return withPort[1];
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(endpoint)) return endpoint;
  return null;
}

/** `null` on any failure (misconfigured alias, adapter error, absent/unparseable endpoint) — see the module doc. */
async function detectPangolinSiteAddress(
  services: AppServices,
  entry: IpAliasEntry,
): Promise<string | null> {
  if (entry.connectionId === null || entry.siteId === null) return null;
  try {
    const { adapter, orgId } = await services.getPangolinAdapterForConnection(
      entry.connectionId,
    );
    const site = await adapter.getSite(entry.siteId, orgId ?? undefined);
    if (site === null || site.endpoint === null) return null;
    return extractAddressFromPangolinEndpoint(site.endpoint);
  } catch {
    return null;
  }
}

export interface IpAliasDetectionOutcome {
  aliasName: string;
  /** `false` for `source: 'manual'` (skipped), no detection this round, or an unchanged address. */
  changed: boolean;
  previousAddress: string | null;
  newAddress: string | null;
  /** Distinct resources the fan-out touched — 0 when `changed` is false or no rule references this alias. */
  resourceCount: number;
  ruleCount: number;
  /** Whether at least one affected resource's ADD rule was actually applied (never a retire — see the module doc). */
  autoApplied: boolean;
  /** Whether a new `ip_alias_changed` event was recorded (false on a dedup replay, or when no rule referenced the alias). */
  notified: boolean;
}

export interface RunIpAliasDetectionSweepOptions {
  services: AppServices;
  /** Injectable for tests; defaults to `node:dns/promises`' `resolve4`. */
  dnsResolver?: DnsResolver;
  /** Production wires `createTransactionalNotificationEnqueue()`; tests wire a recorder. */
  enqueue?: NotificationEnqueue;
  /** Sweep clock; defaults to now. Tests pin it. */
  now?: Date;
}

/**
 * Detect a change for every non-`manual` alias, update the setting, fan out
 * (add-only apply when `autoApply` permits, otherwise check-only), and
 * notify once per genuine change. Never throws for an individual alias's
 * detector or apply failure — each is isolated so one misconfigured alias
 * cannot block every other one's sweep, matching `gatus-push.ts`'s own
 * "this never throws" discipline for a per-cycle background task.
 */
export async function runIpAliasDetectionSweep(
  options: RunIpAliasDetectionSweepOptions,
): Promise<IpAliasDetectionOutcome[]> {
  const { services } = options;
  const dnsResolver = options.dnsResolver ?? defaultDnsResolver;
  const enqueue = options.enqueue ?? createTransactionalNotificationEnqueue();
  const now = options.now ?? new Date();

  const aliases = await services.settings.get(ipAliasesSetting);
  const proxyResources = createProxyResourcesService({
    db: services.db,
    settings: services.settings,
  });

  const outcomes: IpAliasDetectionOutcome[] = [];
  const noChange = (name: string, entry: IpAliasEntry): IpAliasDetectionOutcome => ({
    aliasName: name,
    changed: false,
    previousAddress: entry.previousAddress,
    newAddress: entry.address,
    resourceCount: 0,
    ruleCount: 0,
    autoApplied: false,
    notified: false,
  });

  for (const [name, entry] of Object.entries(aliases)) {
    if (entry.source === "manual") continue;

    let detected: string | null;
    try {
      detected =
        entry.source === "dns"
          ? entry.hostname === null
            ? null
            : await detectDnsAddress(entry.hostname, dnsResolver)
          : await detectPangolinSiteAddress(services, entry);
    } catch {
      // A detector's own module already degrades every failure to `null`;
      // this catch is defense in depth so a bug in either detector cannot
      // take down every other alias's sweep this cycle.
      detected = null;
    }

    if (detected === null || detected === entry.address) {
      outcomes.push(noChange(name, entry));
      continue;
    }

    // Unconditional — independent of autoApply. See the module doc's own
    // update-flow diagram.
    const updatedEntry: IpAliasEntry = {
      ...entry,
      address: detected,
      previousAddress: entry.address,
      observedAt: now.toISOString(),
    };
    const updatedAliases: IpAliasMap = { ...aliases, [name]: updatedEntry };
    await services.settings.set(ipAliasesSetting, updatedAliases, {});
    aliases[name] = updatedEntry;

    const aliasReference = formatIpAliasReference(name);
    const referencing = await proxyResources.listRulesReferencingAlias(aliasReference);

    const fanOutResources: IpAliasFanOutResourceInput[] = [];
    let anyApplied = false;
    for (const { resource, rule } of referencing) {
      const resolved = await resolveProxyProviderForHostingTarget(
        services,
        resource.hostingTargetId,
      );
      if (resolved === null) {
        fanOutResources.push({
          proxyResourceId: resource.id,
          observed: null,
          rules: [
            { action: rule.action, match: rule.match, priority: rule.priority, enabled: rule.enabled },
          ],
        });
        continue;
      }

      let observed: ObservedProxyResource[];
      try {
        observed = await resolved.provider.read({ orgId: resolved.orgId });
      } catch {
        observed = [];
      }
      const observedResource =
        resource.externalResourceId === null
          ? null
          : (observed.find((r) => r.externalResourceId === resource.externalResourceId) ?? null);
      fanOutResources.push({
        proxyResourceId: resource.id,
        observed: observedResource,
        rules: [
          { action: rule.action, match: rule.match, priority: rule.priority, enabled: rule.enabled },
        ],
      });

      // The auto-apply gate: `updatedEntry.autoApply` (design: OFF by
      // default, never for `manual` — already excluded above) chooses
      // `mode`; `reconcile()` itself is the REAL gate — write-policy.ts's
      // `assertWritePolicy` (the connection's stored tier must be
      // 'additive' or above) and `wouldLockOut`'s self-managed-resource
      // clauses, refused structurally rather than checked here redundantly.
      // Only tier-1 `create-*` operations are ever applied (M4's own
      // structural limit, unchanged) — never a retire.
      try {
        const result = await proxyResources.reconcile(resource.id, {
          mode: updatedEntry.autoApply ? "apply" : "check",
          trigger: "poll",
          provider: resolved.provider,
          orgId: resolved.orgId,
          writeAuthorization: resolved.writeAuthorization,
        });
        if (result.appliedCount > 0) anyApplied = true;
      } catch {
        // A reconcile failure for ONE resource must not stop the rest of
        // the fan-out or the notification below — the run row it already
        // wrote is the durable record of what happened.
      }
    }

    const plan = planIpAliasFanOut({
      aliasName: name,
      previousAddress: updatedEntry.previousAddress,
      newAddress: updatedEntry.address,
      resources: fanOutResources,
    });

    let notified = false;
    if (plan.ruleCount > 0) {
      const first = referencing[0];
      if (first !== undefined) {
        const { created } = await publishNotificationEvent({
          executor: services.db,
          event: {
            eventClass: "infrastructure",
            eventType: "ip_alias_changed",
            subjectType: "hosting_target",
            subjectId: first.resource.hostingTargetId,
            occurredAt: now,
            payload: {
              aliasName: name,
              previousAddress: updatedEntry.previousAddress,
              newAddress: updatedEntry.address,
              resourceCount: plan.resourceCount,
              ruleCount: plan.ruleCount,
              autoApplied: anyApplied,
            },
            deduplicationKey: `ip-alias-changed:${name}:${updatedEntry.previousAddress ?? "none"}->${updatedEntry.address}`,
          },
          enqueue,
        });
        notified = created;
      }
    }

    outcomes.push({
      aliasName: name,
      changed: true,
      previousAddress: updatedEntry.previousAddress,
      newAddress: updatedEntry.address,
      resourceCount: plan.resourceCount,
      ruleCount: plan.ruleCount,
      autoApplied: anyApplied,
      notified,
    });
  }

  return outcomes;
}

/** Loose: cron-scheduled runs carry Graphile's `_cron` envelope field. */
const ipAliasDetectionPayloadSchema = z.looseObject({
  correlationId: z.string().optional(),
});

export type IpAliasDetectionTask = LoxepTask<typeof ipAliasDetectionPayloadSchema>;

export const IP_ALIAS_DETECTION_TASK_NAME = "infrastructure.detect-ip-aliases";

/**
 * Every 15 minutes — slower than `health.sweep`'s 5-minute cadence
 * deliberately: this task makes a NEW outbound read per non-manual alias (a
 * DNS lookup or a Pangolin adapter call) that no other sweep already makes,
 * unlike `health.sweep`'s reuse of each provider's own connection probe. A
 * dynamic address does not need 5-minute granularity to satisfy "changes at
 * 4am and one-click is not click-less" — see the design's own "Auto-apply is
 * an open question" section. One recurring cron job, no `monitor_targets`
 * row, no cron per alias — the design's explicit rejection of a second
 * scheduler for this ("the IP detector... ride[s] the existing shared
 * scheduling foundation").
 */
export const IP_ALIAS_DETECTION_CRON_MATCH = "*/15 * * * *";

export interface IpAliasDetectionTasks {
  ipAliasDetectionTask: IpAliasDetectionTask;
  ipAliasDetectionCronItem: AppCronItem;
}

export function createIpAliasDetectionTasks(options: {
  services: AppServices;
}): IpAliasDetectionTasks {
  const { services } = options;

  const ipAliasDetectionTask = defineTask({
    name: IP_ALIAS_DETECTION_TASK_NAME,
    payloadSchema: ipAliasDetectionPayloadSchema,
    // runIpAliasDetectionSweep isolates every alias's own failure internally
    // (see its own doc) — retries exist only for a transient database blip
    // reading/writing the setting itself.
    maxAttempts: 3,
    handler: async (_payload, { logger }) => {
      const outcomes = await runIpAliasDetectionSweep({ services });
      for (const outcome of outcomes) {
        if (!outcome.changed) continue;
        logger.info(
          {
            aliasName: outcome.aliasName,
            previousAddress: outcome.previousAddress,
            newAddress: outcome.newAddress,
            resourceCount: outcome.resourceCount,
            ruleCount: outcome.ruleCount,
            autoApplied: outcome.autoApplied,
            notified: outcome.notified,
          },
          "dynamic-IP alias change detected",
        );
      }
      return outcomes;
    },
  });

  const ipAliasDetectionCronItem: AppCronItem = {
    task: IP_ALIAS_DETECTION_TASK_NAME,
    match: IP_ALIAS_DETECTION_CRON_MATCH,
    identifier: "ip_alias_detection",
    options: {
      maxAttempts: ipAliasDetectionTask.maxAttempts,
      // A missed tick is uninteresting — the next tick re-detects from
      // scratch; there is no queued work to catch up on.
      backfillPeriod: 0,
      jobKey: jobKeyFor(IP_ALIAS_DETECTION_TASK_NAME, "cron"),
      jobKeyMode: "replace",
    },
  };

  return { ipAliasDetectionTask, ipAliasDetectionCronItem };
}
