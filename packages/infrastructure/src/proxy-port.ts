/**
 * The proxy provider port: the shapes this domain needs from a reverse-proxy
 * / tunnel adapter, **re-declared structurally rather than imported**, plus
 * the planner that turns desired state into provider operations.
 *
 * `@loxep/infrastructure` takes NO dependency on
 * `@loxep/integration-pangolin`, exactly as it takes none on
 * `@loxep/integration-cloudflare`, `@loxep/integration-purelymail`, or
 * `@loxep/integration-dockhand`. The composition root (`@loxep/app`) holds
 * both this port's consumer and the real adapter, passing a
 * `ProxyProviderPort` in per call. The consequence is the intended one: a
 * second reverse-proxy provider needs a new integration package and no
 * change here, and this package's tests run against a stub with no provider
 * code in the graph at all.
 *
 * The duplication is guarded the way every other structural re-declaration in
 * Loxep is — by a compile-time assignability test in `@loxep/app`'s suite
 * (`const port: ProxyProviderPort = proxyProviderPortFromPangolinAdapter(adapter)`
 * — the annotation IS the guard), so a drift between the two shapes fails a
 * test rather than a production sync.
 *
 * ## `container-host-port.ts` is the template, copied on purpose
 *
 * Same Loxep-owned observed types, a payload type, a **closed** operation
 * union, a `*Capabilities` interface, the `read`/`apply`/`capabilities`
 * triple, and a pure planner. The Pangolin chain design names this file as
 * the template explicitly and asks that this module doc "copy that sentence
 * and mean it harder": the operation union has no `delete` member so that
 * adding one requires an owner ruling rather than a one-line union member —
 * and Pangolin's own `enabled` flag on a rule (retirement is `disable`, never
 * `delete`) makes that restraint permanent rather than provisional, unlike
 * the container-host port's.
 *
 * ## `read()` takes a SUBJECT, and `apply()` exists but is never called here
 *
 * `read(subject)` takes `{ orgId }` because Pangolin resources are read
 * per-org (`listResources(orgId)`, then `listTargets`/`listRules` per
 * resource) — unlike the container-host port's installation-wide `read()`,
 * ONE connection can host several orgs, and "which org" is a per-subject
 * fact the caller resolves from the desired resource's own connection.
 *
 * `apply()` is a real member of this interface — a future adapter must
 * implement it, and `proxyProviderPortFromPangolinAdapter` wires it for
 * real — but milestone 2 (`loxep-acj.2`) ships a SERVICE
 * (`proxy.ts`'s `createProxyResourcesService`) that refuses to call it: the
 * service forces `mode = 'check'` and throws a legible
 * per-connection-write-policy error if a caller ever passes `mode: 'apply'`.
 * The port's own shape does not enforce this — it cannot, since `apply`
 * genuinely needs to exist for the type to be useful once the write-policy
 * gate (a later milestone) exists — so CHECK MODE ONLY is a service-level
 * rule with its own test, not a structural one this file can make
 * unbuildable. See `proxy.ts`'s module doc for the refusal.
 *
 * ## Why there is no `delete`, and why it is now PERMANENT rather than provisional
 *
 * `container-host-port.ts`'s closed union can widen later if an owner rules
 * it should. This one is different: Pangolin's rule vocabulary carries an
 * `enabled` boolean, so RETIREMENT IS DISABLE, not delete — the Pangolin
 * chain design's verdict 3. There is structurally no unrecoverable operation
 * this port needs a delete verb for, ever. `update-rule` with
 * `rule.enabled = false` is how a superseded rule retires.
 *
 * ## The join key is the FULL DOMAIN, not a stored provider column
 *
 * `niceId` is Pangolin's own unique-per-org display identifier, but a
 * desired resource cannot know it before the resource exists — the
 * `hosting_targets_name_uq` ↔ "unique display name" correspondence
 * `container-host-port.ts` built its bootstrap on does not transfer
 * directly. What DOES transfer without a provider round-trip is the full
 * hostname: Loxep composes it from `proxy_resources.subdomain` plus the
 * owning `managed_domains.name`, and Pangolin reports the same value,
 * independently, as `PangolinResourceFact.fullDomain`. That is this port's
 * bootstrap join key — see {@link DesiredProxyResource.fullDomain}.
 *
 * ## No secret material crosses this boundary, in either direction
 *
 * A Pangolin resource's password and pincode are settable at the provider and
 * are not part of any Loxep intent. The observed type carries `ssoEnabled`
 * and `emailWhitelistEnabled` as PRESENCE only, never the whitelist's
 * contents — the same presence-bit asymmetry `ObservedContainerHost` uses for
 * TLS material, for the same reason: a port that accepted the value would put
 * it into every diff and every run-step summary that touched it.
 *
 * ## `unmatchedObserved` is never turned into deletes — here, MORE than at DNS
 *
 * At Cloudflare an unexpected record is unusual; at Pangolin it is the NORMAL
 * case, because the owner manages resources directly in the dashboard and
 * always will. The plan surfaces them so a caller can render "Pangolin knows
 * about N resources Loxep does not" — information, never drift to correct.
 *
 * ## Rule ownership lives on the INTENT row, not this port
 *
 * `proxy_resource_rules.owner` (`template` | `manual` | `dynamic_ip`) decides
 * which rules the reconciler may rewrite — the same rule `dns_records.owner`
 * enforces for DNS. This port has no opinion about ownership; the PLANNER
 * below reads {@link DesiredProxyRule.owner} and skips emitting a
 * create/update operation for a `'manual'` rule that differs from what is
 * observed, exactly the way `reconcile.ts`'s `applyOperationsFor` skips a
 * `'manual'` `dns_records` row — "a reconciler that rewrites a human's record
 * is a reconciler nobody will run."
 */

/** One observed target under an observed resource, in Loxep's vocabulary. */
export interface ObservedProxyTarget {
  externalTargetId: string;
  siteId: string | null;
  ip: string | null;
  port: number | null;
  method: string | null;
  enabled: boolean;
  path: string | null;
  pathMatchType: string | null;
  priority: number | null;
}

/** One observed rule under an observed resource, in Loxep's vocabulary. */
export interface ObservedProxyRule {
  externalRuleId: string;
  action: string;
  match: string;
  value: string;
  priority: number;
  enabled: boolean;
}

/**
 * One observed Pangolin PUBLIC resource, in Loxep's vocabulary, with its
 * targets and rules nested — the same shape the provider's own read surface
 * has (`listTargets`/`listRules` are resource-scoped calls), so neither
 * nested type carries a back-reference to its parent resource.
 */
export interface ObservedProxyResource {
  externalResourceId: string;
  niceId: string | null;
  name: string | null;
  fullDomain: string | null;
  domainId: string | null;
  subdomain: string | null;
  mode: string | null;
  proxyPort: number | null;
  ssl: boolean;
  enabled: boolean;
  /** Presence only — never a whitelist's contents. */
  ssoEnabled: boolean | null;
  blockAccess: boolean;
  applyRules: boolean | null;
  /** Presence only — never a whitelist's contents. */
  emailWhitelistEnabled: boolean | null;
  targets: ObservedProxyTarget[];
  rules: ObservedProxyRule[];
}

/** The create/update shape for a resource. */
export interface ProxyResourcePayload {
  name: string;
  /** Pangolin's own org-scoped domain id (`PangolinDomainFact.domainId`). */
  domainId: string;
  /** `null` for an apex resource. */
  subdomain: string | null;
  mode: string;
  proxyPort?: number | null;
  ssl?: boolean;
  enabled?: boolean;
}

/** The create/update shape for a target. */
export interface ProxyTargetPayload {
  siteId: string;
  ip: string;
  port: number;
  method?: string | null;
  enabled?: boolean;
  path?: string | null;
  pathMatchType?: string | null;
  priority?: number;
}

/** The create/update shape for a rule. `priority` is always sent — see the module doc. */
export interface ProxyRulePayload {
  action: string;
  match: string;
  value: string;
  priority: number;
  enabled: boolean;
}

/**
 * The closed operation union. NO `delete` member — see the module doc.
 * Shipped with all six members buildable (unlike the module doc's earlier
 * "zero members buildable until M4" option): the type itself does no harm
 * sitting unused, and `proxy.ts`'s service is what actually enforces CHECK
 * MODE ONLY, with its own test — see that module's doc for why the
 * enforcement point is the service, not this union.
 */
export type ProxyOperation =
  | { kind: "create-resource"; resource: ProxyResourcePayload }
  | {
      kind: "update-resource";
      externalResourceId: string;
      resource: Partial<ProxyResourcePayload>;
    }
  | {
      kind: "create-target";
      externalResourceId: string;
      target: ProxyTargetPayload;
    }
  | {
      kind: "update-target";
      externalTargetId: string;
      target: Partial<ProxyTargetPayload>;
    }
  | {
      kind: "create-rule";
      externalResourceId: string;
      rule: ProxyRulePayload;
    }
  | {
      kind: "update-rule";
      externalResourceId: string;
      externalRuleId: string;
      rule: ProxyRulePayload;
    };
// NO delete member, deliberately and permanently. See the module doc.

export interface ProxyApplyResult {
  kind: ProxyOperation["kind"];
  status: "applied";
  externalResourceId?: string;
  externalTargetId?: string;
  externalRuleId?: string;
}

export interface ProxyProviderCapabilities {
  provider: string;
  /** Resource-policy bulk rule endpoint — licence-gated on most builds. */
  bulkRuleSet: boolean;
  /** Whether the provider has an alias/IP-group primitive. Pangolin: always `false`. */
  ruleAliases: boolean;
  /** The `enabled` flag on rule update — the mechanism that makes retirement reversible. */
  ruleDisable: boolean;
  domainCreate: boolean;
  siteCreate: boolean;
  ruleMatches: readonly string[];
  ruleActions: readonly string[];
}

/** What `read()` is scoped to — see the module doc's "takes a SUBJECT" section. */
export interface ProxyReadSubject {
  orgId: string;
}

/**
 * The minimal contract that makes the proxy reconciler provider-agnostic —
 * the design's `read` / `apply` / `capabilities` triple, matching
 * `ContainerHostProviderPort`/`DnsProviderPort`.
 */
export interface ProxyProviderPort {
  read(subject: ProxyReadSubject): Promise<ObservedProxyResource[]>;
  apply(operation: ProxyOperation): Promise<ProxyApplyResult>;
  capabilities(): ProxyProviderCapabilities;
}

/** One desired target, as a caller assembles it from `proxy_resources` intent. */
export interface DesiredProxyTarget extends ProxyTargetPayload {
  externalTargetId?: string | null;
}

/**
 * One desired rule, as a caller assembles it from a `proxy_resource_rules`
 * row.
 *
 * `owner` is the `dns_records.owner` precedent applied per-rule — see the
 * module doc's "Rule ownership" section. `value` is exactly what the intent
 * row carries: a literal, or an unresolved `alias:<name>` reference (a later
 * milestone's job to resolve at materialization time; this port never
 * interprets it).
 */
export interface DesiredProxyRule extends ProxyRulePayload {
  externalRuleId?: string | null;
  owner: "template" | "manual" | "dynamic_ip";
  /**
   * The `ip_aliases` name `value` was resolved from at materialization
   * (`ip-aliases.ts`'s `materializeProxyRuleValue`), or `null` for an
   * ordinary literal. `value` itself is ALWAYS the resolved literal by the
   * time it reaches this type — this field is provenance for
   * `write-policy.ts`'s `wouldLockOut` (`LockoutCheckRule.aliasName`), never
   * re-interpreted by this port or its planner.
   */
  aliasName?: string | null;
}

/**
 * Desired state for one resource, as a caller assembles it from a
 * `proxy_resources` row (plus its `proxy_resource_rules` children).
 *
 * This is deliberately NOT `proxy_resources` itself — see
 * `container-host-port.ts`'s identical note about `hosting_targets`. The
 * mapping happens in the caller (`proxy.ts`), in memory.
 */
export interface DesiredProxyResource {
  /** The `proxy_resources.id` this desired resource came from, for attribution. */
  proxyResourceId: string;
  /** The `hosting_targets.id` this resource fronts. */
  hostingTargetId: string;
  /** The `managed_domains.id` this resource's hostname belongs to. */
  domainId: string;
  /**
   * Pangolin's own org-scoped domain id. `null` until `resolveDomain` has
   * run — a desired resource may exist before that resolution, in which case
   * the planner can still diff it against an already-observed match by
   * {@link fullDomain}, but a `create-resource` operation for it is not yet
   * safe to apply (a later milestone's concern; this port does not gate it).
   */
  externalDomainId: string | null;
  /**
   * `subdomain.basedomain`, or `basedomain` alone for an apex resource — the
   * bootstrap join key. See the module doc's "join key is the FULL DOMAIN"
   * section.
   */
  fullDomain: string;
  /** `null` for an apex resource. */
  subdomain: string | null;
  mode: string;
  proxyPort?: number | null;
  ssl: boolean;
  enabled: boolean;
  /**
   * The provider's own id for this resource, once known — the self-retiring
   * half of `container-host-port.ts`'s `externalHostId` bootstrap, applied
   * here identically.
   */
  externalResourceId?: string | null;
  targets: DesiredProxyTarget[];
  rules: DesiredProxyRule[];
}

export interface ProxyResourcePlan {
  operations: ProxyOperation[];
  /**
   * Resources present at the provider that no desired record matched.
   *
   * **Never turned into deletes, ever** — the module doc's "MORE than at DNS"
   * section. This is the NORMAL case for Pangolin, not the exception.
   */
  unmatchedObserved: ObservedProxyResource[];
}

function targetKey(target: {
  siteId: string;
  ip: string;
  port: number;
}): string {
  return `${target.siteId} ${target.ip} ${target.port}`;
}

/** Comparable resource fields only. */
function differsResource(
  desired: DesiredProxyResource,
  observed: ObservedProxyResource,
): Partial<ProxyResourcePayload> | null {
  const changes: Partial<ProxyResourcePayload> = {};
  if (observed.mode !== null && desired.mode !== observed.mode) {
    changes.mode = desired.mode;
  }
  if (
    desired.proxyPort !== undefined &&
    (desired.proxyPort ?? null) !== observed.proxyPort
  ) {
    changes.proxyPort = desired.proxyPort;
  }
  if (desired.ssl !== observed.ssl) changes.ssl = desired.ssl;
  if (desired.enabled !== observed.enabled) changes.enabled = desired.enabled;
  return Object.keys(changes).length === 0 ? null : changes;
}

/** Comparable target fields only. */
function differsTarget(
  desired: DesiredProxyTarget,
  observed: ObservedProxyTarget,
): Partial<ProxyTargetPayload> | null {
  const changes: Partial<ProxyTargetPayload> = {};
  const compare = <K extends "method" | "path" | "pathMatchType">(
    key: K,
  ): void => {
    const want = desired[key];
    if (want === undefined) return;
    if ((want ?? null) !== observed[key]) changes[key] = want;
  };
  compare("method");
  compare("path");
  compare("pathMatchType");
  if (desired.enabled !== undefined && desired.enabled !== observed.enabled) {
    changes.enabled = desired.enabled;
  }
  if (
    desired.priority !== undefined &&
    (desired.priority ?? null) !== observed.priority
  ) {
    changes.priority = desired.priority;
  }
  return Object.keys(changes).length === 0 ? null : changes;
}

/**
 * Turn desired state plus an observed inventory into the operations that
 * converge them.
 *
 * Pure — no I/O, no clock — matching `diffDnsRecords` and
 * `planContainerHostOperations`.
 *
 * ## Resources whose creation is not yet observable get ONLY a `create-resource`
 *
 * A resource that does not exist at the provider yet has no
 * `externalResourceId` for its targets or rules to reference — Pangolin's
 * target/rule creates take a `resourceId` path parameter. So an unmatched
 * desired resource emits exactly one operation; its targets and rules wait
 * for a LATER plan, once the create has been observed. This mirrors
 * `container-hosts.ts`'s own single-operation-per-run discipline, generalized
 * to "children wait for their parent's id."
 *
 * ## A `'manual'`-owned rule that differs produces no operation
 *
 * See the module doc's "Rule ownership" section — the `reconcile.ts`
 * precedent, applied per-rule via {@link DesiredProxyRule.owner}.
 *
 * ## Rule updates always carry the FULL comparable set
 *
 * Because Pangolin requires `priority` on every rule write and treats a
 * partial update as silently reordering evaluation, a rule update operation
 * here is never partial — it is the complete `ProxyRulePayload`, exactly the
 * way the module doc for `container-host-port.ts` documents for its own
 * secret-material fields, generalized to "this provider has a required field
 * an omission would corrupt."
 */
export function planProxyResourceOperations(input: {
  desired: readonly DesiredProxyResource[];
  observed: readonly ObservedProxyResource[];
}): ProxyResourcePlan {
  const byId = new Map<string, ObservedProxyResource>();
  const byFullDomain = new Map<string, ObservedProxyResource>();
  for (const resource of input.observed) {
    byId.set(resource.externalResourceId, resource);
    if (resource.fullDomain !== null) {
      byFullDomain.set(resource.fullDomain, resource);
    }
  }

  const operations: ProxyOperation[] = [];
  const matched = new Set<string>();

  for (const desired of input.desired) {
    const observed =
      (desired.externalResourceId != null
        ? byId.get(desired.externalResourceId)
        : undefined) ?? byFullDomain.get(desired.fullDomain);

    if (observed === undefined) {
      operations.push({
        kind: "create-resource",
        resource: {
          name: desired.fullDomain,
          domainId: desired.externalDomainId ?? "",
          subdomain: desired.subdomain,
          mode: desired.mode,
          proxyPort: desired.proxyPort ?? null,
          ssl: desired.ssl,
          enabled: desired.enabled,
        },
      });
      continue;
    }
    matched.add(observed.externalResourceId);

    const resourceChanges = differsResource(desired, observed);
    if (resourceChanges !== null) {
      operations.push({
        kind: "update-resource",
        externalResourceId: observed.externalResourceId,
        resource: resourceChanges,
      });
    }

    for (const desiredTarget of desired.targets) {
      const observedTarget =
        (desiredTarget.externalTargetId != null
          ? observed.targets.find(
              (t) => t.externalTargetId === desiredTarget.externalTargetId,
            )
          : undefined) ??
        observed.targets.find(
          (t) =>
            t.siteId !== null &&
            t.ip !== null &&
            t.port !== null &&
            targetKey({ siteId: t.siteId, ip: t.ip, port: t.port }) ===
              targetKey(desiredTarget),
        );

      if (observedTarget === undefined) {
        const { externalTargetId: _identity, ...payload } = desiredTarget;
        operations.push({
          kind: "create-target",
          externalResourceId: observed.externalResourceId,
          target: payload,
        });
        continue;
      }
      const targetChanges = differsTarget(desiredTarget, observedTarget);
      if (targetChanges !== null) {
        operations.push({
          kind: "update-target",
          externalTargetId: observedTarget.externalTargetId,
          target: targetChanges,
        });
      }
    }

    for (const desiredRule of desired.rules) {
      const observedRule =
        (desiredRule.externalRuleId != null
          ? observed.rules.find(
              (r) => r.externalRuleId === desiredRule.externalRuleId,
            )
          : undefined) ??
        observed.rules.find(
          (r) =>
            r.action === desiredRule.action &&
            r.match === desiredRule.match &&
            r.value === desiredRule.value,
        );

      if (observedRule === undefined) {
        // A human-owned rule that Pangolin does not have is never CREATED —
        // "a reconciler that rewrites a human's record is a reconciler
        // nobody will run." See the module doc.
        if (desiredRule.owner === "manual") continue;
        operations.push({
          kind: "create-rule",
          externalResourceId: observed.externalResourceId,
          rule: {
            action: desiredRule.action,
            match: desiredRule.match,
            value: desiredRule.value,
            priority: desiredRule.priority,
            enabled: desiredRule.enabled,
          },
        });
        continue;
      }

      const differs =
        observedRule.priority !== desiredRule.priority ||
        observedRule.enabled !== desiredRule.enabled ||
        observedRule.action !== desiredRule.action ||
        observedRule.match !== desiredRule.match ||
        observedRule.value !== desiredRule.value;
      if (!differs) continue;
      if (desiredRule.owner === "manual") continue;

      operations.push({
        kind: "update-rule",
        externalResourceId: observed.externalResourceId,
        externalRuleId: observedRule.externalRuleId,
        rule: {
          action: desiredRule.action,
          match: desiredRule.match,
          value: desiredRule.value,
          priority: desiredRule.priority,
          enabled: desiredRule.enabled,
        },
      });
    }
  }

  return {
    operations,
    unmatchedObserved: input.observed.filter(
      (resource) => !matched.has(resource.externalResourceId),
    ),
  };
}
