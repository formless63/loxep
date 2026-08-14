import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Icons } from '@/components/icons';
import type {
  IntegrationService,
  IntegrationStatusInput
} from '@/features/settings/integrations-catalog';
import {
  isIntegrationEnabled,
  type IntegrationEnabledMap
} from '@/features/settings/integrations-catalog';
import { PROVIDER_DISABLED_EXPLANATION } from './columns';

/**
 * Toolbar "Add connection" action (loxep-4t7) — replaces the N per-service
 * buttons the old per-provider-section layout scattered down the page with
 * one menu, in the DataTable stack's sanctioned toolbar slot
 * (`DataTableToolbar`'s `children`).
 *
 * `services` is already filtered to "visible" ones by the container
 * (`index.tsx`): a disabled provider (loxep-dgg) with zero connections is
 * not in this list at all, so it contributes no menu item here, mirroring
 * the old layout's whole-section disappearance. A disabled provider that
 * DOES have connections stays in `services` — its connections remain
 * visible, functional rows in the table — but its item here is disabled
 * with `PROVIDER_DISABLED_EXPLANATION`, same as any other unmet
 * prerequisite (a missing eBay keyset, say). The toggle is a display
 * preference, never a kill switch, so the add-action being blocked is as
 * far as "disabled" ever reaches — existing rows never lose function.
 */
export function AddConnectionMenu({
  services,
  statusInput,
  enabledMap,
  onSelect
}: {
  services: IntegrationService[];
  statusInput: IntegrationStatusInput;
  enabledMap: IntegrationEnabledMap;
  onSelect: (serviceId: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size='sm'>
          <Icons.add />
          Add connection
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-80'>
        <DropdownMenuLabel>Add an account</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {services.map((service) => {
          const disabledHere = !isIntegrationEnabled(enabledMap, service.id);
          const blockedReason = disabledHere
            ? PROVIDER_DISABLED_EXPLANATION
            : (service.accounts?.blockedReason(statusInput) ?? null);
          return (
            <DropdownMenuItem
              key={service.id}
              disabled={blockedReason !== null}
              onSelect={() => onSelect(service.id)}
            >
              <div className='flex flex-col gap-0.5 py-0.5'>
                <span>{service.accounts?.addLabel ?? `Add ${service.name} account`}</span>
                {blockedReason !== null && (
                  <span className='text-muted-foreground text-xs text-wrap'>{blockedReason}</span>
                )}
              </div>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to='/settings/integrations'>
            <Icons.externalLink /> Open integrations
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
