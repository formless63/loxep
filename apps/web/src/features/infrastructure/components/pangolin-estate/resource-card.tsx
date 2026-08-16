import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Icons } from '@/components/icons';
import { formatRelativeTime } from '@/lib/format';
import { pangolinEstateResourceDetailQuery } from '@/features/infrastructure/api/queries';
import ProxyResourceRow from '@/features/infrastructure/components/proxy-resource-row';
import AdoptPangolinResourceDialog from './adopt-resource-dialog';
import type { PangolinEstateResourceDto } from '@/server/pangolin-estate-functions';

/**
 * Live `listTargets`/`listRules` for one UNDECLARED resource — fetched only
 * once this component mounts, which only happens once the operator expands
 * the row (the parent gates mounting on `open`). Read-only: a raw
 * `PangolinRuleFact` carries no Loxep `proxy_resource_rules.id` to
 * retire/enable against, so no control renders here — see the module doc.
 */
function LiveResourceDetail({
  connectionId,
  resourceId
}: {
  connectionId: string;
  resourceId: string;
}) {
  const { data, isPending, isError, refetch } = useQuery(
    pangolinEstateResourceDetailQuery(connectionId, resourceId)
  );

  if (isPending) {
    return (
      <p className='text-muted-foreground text-sm'>Reading targets and rules from Pangolin…</p>
    );
  }
  if (isError) {
    return (
      <div className='flex items-center justify-between gap-2 text-sm'>
        <span className='text-destructive'>Could not read this resource&apos;s targets/rules.</span>
        <Button size='sm' variant='outline' onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-3'>
      <div>
        <p className='mb-1 text-sm font-medium'>Targets ({data.targets.length})</p>
        {data.targets.length === 0 ? (
          <p className='text-muted-foreground text-sm'>No targets.</p>
        ) : (
          <ul className='flex flex-col gap-1'>
            {data.targets.map((target, index) => (
              // Pangolin's own numeric id, when present, is the natural key;
              // an unmatched `null` (never observed live) falls back to
              // position, matching this list's own read-only, unmatchable
              // shape — nothing here is ever reordered or diffed by key.
              <li
                key={target.targetId ?? index}
                className='flex flex-wrap items-center gap-2 rounded-md border px-2 py-1 text-sm'
              >
                <span className='font-mono'>
                  {target.ip ?? '—'}
                  {target.port !== null && `:${target.port}`}
                </span>
                {target.method && <Badge variant='outline'>{target.method}</Badge>}
                {target.siteId !== null && (
                  <span className='text-muted-foreground'>site {target.siteId}</span>
                )}
                {!target.enabled && <Badge variant='secondary'>disabled</Badge>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className='mb-1 text-sm font-medium'>Rules ({data.rules.length})</p>
        {data.rules.length === 0 ? (
          <p className='text-muted-foreground text-sm'>No rules.</p>
        ) : (
          <ul className='flex flex-col gap-1'>
            {data.rules.map((rule, index) => (
              <li
                key={rule.ruleId ?? index}
                className='flex flex-wrap items-center gap-2 rounded-md border px-2 py-1 text-sm'
              >
                <Badge variant='outline'>{rule.action ?? '—'}</Badge>
                <Badge variant='outline'>{rule.match ?? '—'}</Badge>
                <span className='font-mono'>{rule.value ?? '—'}</span>
                <span className='text-muted-foreground tabular-nums'>
                  priority {rule.priority ?? '—'}
                </span>
                {!rule.enabled && <Badge variant='secondary'>disabled</Badge>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className='text-muted-foreground text-xs'>
        Read just now ({formatRelativeTime(data.readAt)}) — never stored. No control here: this
        resource is not declared in Loxep yet — adopt it above to unlock retire/re-enable.
      </p>
    </div>
  );
}

/**
 * One live Pangolin resource. Verbatim provider-truth in the header
 * (fullDomain, mode, enabled, ssl, SSO/whitelist PRESENCE only —
 * `PangolinResourceFact`'s own "presence only, never a whitelist's
 * contents" rule). A resource already matched to a declared `proxy_resources`
 * row (`resource.declared`) renders that row with the SAME
 * `ProxyResourceRow` component the domain/fleet detail pages use — retire/
 * re-enable included, control mounted where it already lives. An unmatched
 * resource instead offers "Adopt as declared resource" and, on expand, a
 * READ-ONLY live rules/targets read (rate-budget-aware — see the module
 * doc's own "ON EXPAND only" rule).
 */
export default function PangolinEstateResourceCard({
  connectionId,
  resource
}: {
  connectionId: string;
  resource: PangolinEstateResourceDto;
}) {
  const [open, setOpen] = React.useState(false);
  const [adopting, setAdopting] = React.useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className='flex flex-col gap-2 rounded-md border p-3'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='font-mono text-sm font-medium'>
              {resource.fullDomain ?? resource.name ?? 'Unnamed resource'}
            </span>
            {resource.mode && <Badge variant='outline'>{resource.mode}</Badge>}
            {!resource.ssl && <Badge variant='secondary'>no TLS</Badge>}
            {!resource.enabled && <Badge variant='secondary'>disabled</Badge>}
            {resource.blockAccess && <Badge variant='destructive'>access blocked</Badge>}
            {resource.sso === true && <Badge variant='outline'>SSO</Badge>}
            {resource.emailWhitelistEnabled === true && (
              <Badge variant='outline'>email whitelist</Badge>
            )}
            {resource.health && <Badge variant='secondary'>{resource.health}</Badge>}
          </div>
          <div className='flex items-center gap-2'>
            {resource.declared === null ? (
              <Button size='sm' variant='outline' onClick={() => setAdopting(true)}>
                <Icons.add />
                Adopt as declared resource
              </Button>
            ) : (
              <Badge variant='success'>
                <Icons.circleCheck />
                declared in Loxep
              </Badge>
            )}
            <CollapsibleTrigger asChild>
              <Button size='sm' variant='ghost'>
                {open ? <Icons.chevronUp /> : <Icons.chevronDown />}
                {open ? 'Hide' : 'Rules & targets'}
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>

        <CollapsibleContent className='flex flex-col gap-2 pt-2'>
          {resource.declared !== null ? (
            <ProxyResourceRow
              resource={resource.declared}
              linkTo={{
                to: '/infrastructure/fleet/$name',
                params: { name: resource.declared.hostingTargetName },
                label: resource.declared.hostingTargetName
              }}
            />
          ) : resource.resourceId === null ? (
            <p className='text-muted-foreground text-sm'>
              Pangolin returned no numeric id for this resource — nothing to drill into.
            </p>
          ) : open ? (
            <LiveResourceDetail
              connectionId={connectionId}
              resourceId={String(resource.resourceId)}
            />
          ) : null}
        </CollapsibleContent>
      </div>

      {resource.declared === null && (
        <AdoptPangolinResourceDialog
          open={adopting}
          onOpenChange={setAdopting}
          connectionId={connectionId}
          resource={resource}
        />
      )}
    </Collapsible>
  );
}
