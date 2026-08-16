import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import TypedConfirmDialog from '@/components/ui/typed-confirm-dialog';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { ToneBadge } from '@/features/settings/components/status-tone';
import {
  retireProxyResourceRule,
  enableProxyResourceRule
} from '@/server/infrastructure-functions';
import type { ProxyResourceChainDto } from '@/server/infrastructure-functions';

const RULE_ACTION_TONE: Record<string, 'success' | 'destructive' | 'warning'> = {
  ACCEPT: 'success',
  DROP: 'destructive',
  PASS: 'warning'
};

/** What retiring/re-enabling THIS rule would change — named explicitly in the typed-confirmation dialog, per the write-risk model's rule 6 ("names the exact flip that unblocks it" / "names the object the action touches"). */
function ruleAccessChangeCopy(
  rule: ProxyResourceChainDto['rules'][number],
  fullDomain: string,
  direction: 'retire' | 'enable'
): string {
  const subject =
    rule.action === 'ACCEPT'
      ? `bypasses access control for ${rule.match === 'CIDR' || rule.match === 'IP' ? 'the address' : 'requests matching'} ${rule.value}`
      : rule.action === 'DROP'
        ? `blocks ${rule.match === 'CIDR' || rule.match === 'IP' ? 'the address' : 'requests matching'} ${rule.value}`
        : `routes ${rule.match === 'CIDR' || rule.match === 'IP' ? 'the address' : 'requests matching'} ${rule.value} to authentication`;
  return direction === 'retire'
    ? `This disables the ${rule.action} rule that ${subject} on ${fullDomain}. Anyone or anything relying on it to reach this resource loses that access immediately — this is reversible; the rule can be re-enabled here at any time.`
    : `This re-enables the ${rule.action} rule that ${subject} on ${fullDomain}, restoring whatever access it grants (or block it enforces).`;
}

/**
 * One `proxy_resource_rules` row — rendered where DNS drift renders (the
 * design's own instruction). M2 (loxep-acj.2) shipped this read-only; M7
 * (loxep-acj.7) adds the disable/re-enable action per rule, behind a typed
 * confirmation naming exactly what access changes. A `'manual'`-owned rule
 * gets no action — Loxep's reconciler never rewrites a human's record, and
 * the server refuses the same way, so the button is never offered.
 */
function RuleRow({
  rule,
  fullDomain
}: {
  rule: ProxyResourceChainDto['rules'][number];
  fullDomain: string;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = React.useState<'retire' | 'enable' | null>(null);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['infrastructure', 'domains'] }),
      queryClient.invalidateQueries({ queryKey: ['infrastructure', 'fleet'] })
    ]);
  };

  const retireMutation = useMutation({
    mutationFn: (confirmedFullDomain: string) =>
      retireProxyResourceRule({ data: { proxyResourceRuleId: rule.id, confirmedFullDomain } }),
    onSuccess: async () => {
      toast.success(`Retiring rule — this may take a moment to reflect at Pangolin`);
      setConfirming(null);
      await invalidate();
    },
    onError: (error) => toastError(error, 'Failed to enqueue the retire')
  });
  const enableMutation = useMutation({
    mutationFn: (confirmedFullDomain: string) =>
      enableProxyResourceRule({ data: { proxyResourceRuleId: rule.id, confirmedFullDomain } }),
    onSuccess: async () => {
      toast.success(`Re-enabling rule — this may take a moment to reflect at Pangolin`);
      setConfirming(null);
      await invalidate();
    },
    onError: (error) => toastError(error, 'Failed to enqueue the re-enable')
  });

  return (
    <li
      className={
        rule.enabled
          ? 'flex flex-wrap items-center gap-2 rounded-md border px-2 py-1 text-sm'
          : 'flex flex-wrap items-center gap-2 rounded-md border px-2 py-1 text-sm opacity-60'
      }
    >
      <ToneBadge tone={RULE_ACTION_TONE[rule.action] ?? 'secondary'}>{rule.action}</ToneBadge>
      <Badge variant='outline'>{rule.match}</Badge>
      {rule.aliasName === null ? (
        <span className='font-mono'>{rule.value}</span>
      ) : (
        // Pangolin chain design milestone 5 (loxep-acj.5): a dynamic_ip rule
        // stores the STABLE REFERENCE 'alias:<name>', never the resolved
        // literal — this badge names the alias rather than the raw
        // reference string, and links to where the alias's current address
        // and every rule it binds are managed.
        <Link
          to='/infrastructure/aliases'
          className='outline-none focus-visible:ring-[3px] focus-visible:ring-ring'
        >
          <Badge variant='secondary'>
            <Icons.integrations />
            bound to alias &lsquo;{rule.aliasName}&rsquo;
          </Badge>
        </Link>
      )}
      <span className='text-muted-foreground tabular-nums'>priority {rule.priority}</span>
      <span className='text-muted-foreground'>· {rule.owner}</span>
      {!rule.enabled && (
        <Badge variant='secondary'>
          <Icons.close />
          disabled
        </Badge>
      )}
      {rule.owner !== 'manual' && (
        <div className='ml-auto'>
          {rule.enabled ? (
            <Button
              size='sm'
              variant='outline'
              onClick={() => setConfirming('retire')}
              disabled={retireMutation.isPending}
            >
              Retire
            </Button>
          ) : (
            <Button
              size='sm'
              variant='outline'
              onClick={() => setConfirming('enable')}
              disabled={enableMutation.isPending}
            >
              Re-enable
            </Button>
          )}
        </div>
      )}
      <TypedConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={
          confirming === 'retire'
            ? `Retire this rule on "${fullDomain}"?`
            : `Re-enable this rule on "${fullDomain}"?`
        }
        description={ruleAccessChangeCopy(rule, fullDomain, confirming ?? 'retire')}
        confirmText={fullDomain}
        actionLabel={confirming === 'retire' ? 'Retire rule' : 'Re-enable rule'}
        variant={confirming === 'retire' ? 'destructive' : 'default'}
        pending={retireMutation.isPending || enableMutation.isPending}
        onConfirm={() =>
          confirming === 'retire'
            ? retireMutation.mutate(fullDomain)
            : enableMutation.mutate(fullDomain)
        }
      />
    </li>
  );
}

/**
 * The rule list's filter — hide-disabled by default, with an "only disabled"
 * toggle (the owner-confirmed UX this milestone's brief names explicitly).
 * A plain `<ul>`/`Switch` composition, matching this exact page's own
 * precedent for a small embedded list (`hosting-target-tokens-panel.tsx`'s
 * token list, `dns-drift-panel.tsx`'s findings list) rather than the donor
 * `DataTable` stack, which Frontend Standards reserves for a substantial,
 * independently-paginated listing — this is neither: a resource typically
 * carries a handful of rules at most.
 */
function RulesList({
  rules,
  fullDomain,
  lastRuleLifecycleChange
}: {
  rules: ProxyResourceChainDto['rules'];
  fullDomain: string;
  lastRuleLifecycleChange: ProxyResourceChainDto['lastRuleLifecycleChange'];
}) {
  const [onlyDisabled, setOnlyDisabled] = React.useState(false);
  const visible = rules.filter((rule) => (onlyDisabled ? !rule.enabled : rule.enabled));
  const disabledCount = rules.filter((rule) => !rule.enabled).length;

  if (rules.length === 0) {
    return <p className='text-muted-foreground text-sm'>No rules declared for this resource.</p>;
  }

  return (
    <div className='flex flex-col gap-2'>
      {disabledCount > 0 && (
        <div className='flex flex-col gap-1'>
          <div className='flex items-center gap-2'>
            <Switch
              id={`only-disabled-${rules[0]?.id ?? 'rules'}`}
              checked={onlyDisabled}
              onCheckedChange={setOnlyDisabled}
            />
            <Label
              htmlFor={`only-disabled-${rules[0]?.id ?? 'rules'}`}
              className='text-muted-foreground text-sm font-normal'
            >
              Show only disabled rules ({disabledCount})
            </Label>
          </div>
          {lastRuleLifecycleChange && (
            // Resource-level, not per-rule — the ledger (`reconcile_runs`)
            // has no finer granularity today. See
            // `buildProxyResourceChainDtos`'s own doc.
            <p className='text-muted-foreground text-xs'>
              Last rule change on this resource:{' '}
              {lastRuleLifecycleChange.kind === 'retire' ? 'retired' : 're-enabled'}{' '}
              {lastRuleLifecycleChange.actorUserName
                ? `by ${lastRuleLifecycleChange.actorUserName} `
                : ''}
              on {formatDateTime(lastRuleLifecycleChange.occurredAt)}
            </p>
          )}
        </div>
      )}
      {visible.length === 0 ? (
        <p className='text-muted-foreground text-sm'>
          {onlyDisabled ? 'No disabled rules.' : 'All rules are disabled.'}
        </p>
      ) : (
        <ul className='flex flex-col gap-1'>
          {visible.map((rule) => (
            <RuleRow key={rule.id} rule={rule} fullDomain={fullDomain} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One `proxy_resources` row, rendered on whichever detail page did not
 * originate it — `linkTo` points at the OTHER end of the chain
 * (`ProxyChainPanel` on `/infrastructure/domains/$name` links to the hosting
 * target; `ProxyConnectionPanel` on `/infrastructure/fleet/$name` links to
 * the domain).
 */
export default function ProxyResourceRow({
  resource,
  linkTo
}: {
  resource: ProxyResourceChainDto;
  linkTo: {
    to: '/infrastructure/domains/$name' | '/infrastructure/fleet/$name';
    params: { name: string };
    label: string;
  };
}) {
  return (
    <li className='flex flex-col gap-3 rounded-md border p-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='font-mono text-sm font-medium'>{resource.fullDomain}</span>
          <Badge variant='outline'>{resource.mode}</Badge>
          {!resource.ssl && <Badge variant='secondary'>no TLS</Badge>}
          {!resource.enabled && <Badge variant='secondary'>disabled</Badge>}
        </div>
        <Link
          to={linkTo.to}
          params={linkTo.params}
          className='text-muted-foreground text-sm outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring'
        >
          <span className='inline-flex items-center gap-1'>
            <Icons.arrowRight />
            {linkTo.label}
          </span>
        </Link>
      </div>

      <div className='text-muted-foreground text-xs'>
        {resource.externalResourceId === null
          ? 'Not yet matched against Pangolin — declared, never reconciled.'
          : `Pangolin resource #${resource.externalResourceId}`}
        {resource.lastRun && ` · last checked ${resource.lastRun.status}`}
      </div>

      {resource.unmatchedObservedCount !== null && resource.unmatchedObservedCount > 0 && (
        <div className='text-muted-foreground flex items-center gap-2 text-sm'>
          <Icons.info />
          Pangolin knows about {resource.unmatchedObservedCount} resource
          {resource.unmatchedObservedCount === 1 ? '' : 's'} Loxep does not — information, not drift
          to correct.
        </div>
      )}

      <RulesList
        rules={resource.rules}
        fullDomain={resource.fullDomain}
        lastRuleLifecycleChange={resource.lastRuleLifecycleChange}
      />
    </li>
  );
}

export function ProxyResourceEmptyState({
  title,
  description
}: {
  title: string;
  description: string;
}) {
  return (
    <Empty className='p-0'>
      <EmptyHeader>
        <EmptyMedia variant='icon'>
          <Icons.integrations />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
