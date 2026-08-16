import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import { ToneBadge } from '@/features/settings/components/status-tone';
import type { ProxyResourceChainDto } from '@/server/infrastructure-functions';

const RULE_ACTION_TONE: Record<string, 'success' | 'destructive' | 'warning'> = {
  ACCEPT: 'success',
  DROP: 'destructive',
  PASS: 'warning'
};

/**
 * One `proxy_resource_rules` row — rendered where DNS drift renders (the
 * design's own instruction). No apply action anywhere: milestone 2
 * (loxep-acj.2) is CHECK MODE ONLY, so this is read-only, informational.
 */
function RuleRow({ rule }: { rule: ProxyResourceChainDto['rules'][number] }) {
  return (
    <li className='flex flex-wrap items-center gap-2 rounded-md border px-2 py-1 text-sm'>
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
function RulesList({ rules }: { rules: ProxyResourceChainDto['rules'] }) {
  const [onlyDisabled, setOnlyDisabled] = React.useState(false);
  const visible = rules.filter((rule) => (onlyDisabled ? !rule.enabled : rule.enabled));
  const disabledCount = rules.filter((rule) => !rule.enabled).length;

  if (rules.length === 0) {
    return <p className='text-muted-foreground text-sm'>No rules declared for this resource.</p>;
  }

  return (
    <div className='flex flex-col gap-2'>
      {disabledCount > 0 && (
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
      )}
      {visible.length === 0 ? (
        <p className='text-muted-foreground text-sm'>
          {onlyDisabled ? 'No disabled rules.' : 'All rules are disabled.'}
        </p>
      ) : (
        <ul className='flex flex-col gap-1'>
          {visible.map((rule) => (
            <RuleRow key={rule.id} rule={rule} />
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

      <RulesList rules={resource.rules} />
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
