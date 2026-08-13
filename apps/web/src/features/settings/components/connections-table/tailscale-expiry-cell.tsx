import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { FieldGroup } from '@/components/ui/field';
import { formatDate } from '@/lib/format';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { ToneBadge } from '@/features/settings/components/status-tone';
import { submitFormEvent } from '@/features/settings/lib/dialog-form';
import { connectionsQuery } from '@/features/settings/api/queries';
import type { ConnectionDto } from '@/server/admin-functions';
import { updateTailscaleCredentialExpiry } from './tailscale-expiry-functions';

export const TAILSCALE_PROVIDER = 'tailscale';

/**
 * Days-remaining threshold for the attention-worthy tone below (loxep-50t
 * §2.2b/§2.2d). Mirrors `integrations-catalog.ts`'s own
 * `TAILSCALE_EXPIRY_WARNING_DAYS` — that constant is not exported, and
 * `integrations-catalog.ts` is outside this bead's write fence, so this is a
 * deliberate re-declaration (same convention `@/server/order-sync-functions`
 * uses for `@loxep/commerce` constants it cannot import across a package
 * boundary). A constant, not a per-connection setting: "how early to warn"
 * is a knob nobody tunes.
 */
const TAILSCALE_EXPIRY_WARNING_DAYS = 14;

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tailscaleCredentialMode(
  connection: ConnectionDto
): 'oauth_client' | 'api_access_token' | null {
  const mode = readObject(connection.config['tailscale'])['credentialMode'];
  return mode === 'oauth_client' || mode === 'api_access_token' ? mode : null;
}

function tailscaleCredentialExpiresAt(connection: ConnectionDto): string | null {
  const value = readObject(connection.config['tailscale'])['credentialExpiresAt'];
  return typeof value === 'string' ? value : null;
}

/** Whole days remaining until the recorded expiry, or `null` if unparsable. */
function daysUntil(isoDate: string): number | null {
  const expiresAt = new Date(isoDate);
  if (Number.isNaN(expiresAt.getTime())) return null;
  return Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

/** Whether this connection's provider carries the Tailscale credential-expiry concept at all. */
export function supportsTailscaleExpiry(connection: ConnectionDto): boolean {
  return connection.provider === TAILSCALE_PROVIDER;
}

/**
 * Whether the "Record token expiry" row action should be offered
 * (`cell-action.tsx`) — token-mode only (an OAuth client renews itself, so
 * there is nothing to record) and never on an archived/retired row.
 */
export function tailscaleExpiryEditable(connection: ConnectionDto): boolean {
  return (
    connection.status !== 'archived' && tailscaleCredentialMode(connection) === 'api_access_token'
  );
}

const expiryFormSchema = z
  .object({
    // `.or(z.undefined())` rather than a bare `z.date()`: `useAppForm`'s
    // `defaultValues` needs a required KEY whose VALUE is `Date | undefined`
    // — the shape `DatePickerField`'s `useFieldContext<Date | undefined>()`
    // wants — so the schema must accept `undefined` at the type level too.
    // `superRefine` below still enforces that a date was actually picked.
    // Same pattern `connection-add-dialog.tsx`'s `tailscaleAccountSchema`
    // uses for its own `expiresOn` field.
    expiresOn: z.date().or(z.undefined())
  })
  .superRefine((value, ctx) => {
    if (value.expiresOn === undefined) {
      ctx.addIssue({ code: 'custom', path: ['expiresOn'], message: 'Recorded expiry is required' });
    }
  });

/**
 * Admin-only dialog that records/updates a token-mode Tailscale connection's
 * expiry — opened from `cell-action.tsx`'s row menu, which is itself only
 * rendered for admins (mirrors every other connection mutation on this
 * table: order sync, purchase sync, archive, delete all live there too, not
 * inside the plain read cell below).
 */
export function TailscaleExpiryDialog({
  connection,
  open,
  onOpenChange
}: {
  connection: ConnectionDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const recordedAt = tailscaleCredentialExpiresAt(connection);

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof expiryFormSchema>) => {
      // `superRefine` above already blocks submission without a date; this
      // narrows the type for the `Date`-only arithmetic below rather than
      // trusting that validation ran (defense in depth, not dead code).
      if (values.expiresOn === undefined) {
        return Promise.reject(new Error('Recorded expiry is required'));
      }
      const year = values.expiresOn.getFullYear();
      const month = String(values.expiresOn.getMonth() + 1).padStart(2, '0');
      const day = String(values.expiresOn.getDate()).padStart(2, '0');
      return updateTailscaleCredentialExpiry({
        data: { connectionId: connection.id, credentialExpiresAt: `${year}-${month}-${day}` }
      });
    },
    onSuccess: () => {
      toast.success('Recorded expiry updated');
      queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to record expiry')
  });

  const form = useAppForm({
    defaultValues: {
      expiresOn: (recordedAt ? new Date(recordedAt) : undefined) as Date | undefined
    },
    validators: { onSubmit: expiryFormSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-[420px]'>
        <DialogHeader>
          <DialogTitle>Record token expiry — {connection.name}</DialogTitle>
          <DialogDescription>
            Tailscale showed an expiry when this API access token was generated. Recording it here
            lets Loxep warn you before the token dies; it never changes the token itself.
          </DialogDescription>
        </DialogHeader>
        <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
          <FieldGroup>
            <form.AppField
              name='expiresOn'
              children={(field) => <field.DatePickerField label='Recorded expiry' required />}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>Save</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Read-only credential-expiry state for the connections table's
 * "Credentials" column, Tailscale rows only (loxep-50t §2.2b) — parallels
 * `EbayCredentialStatus`. Three states, matched to the design exactly:
 *
 * - `oauth_client`: an ordinary chip, "auto-renewing" — Loxep re-exchanges
 *   the minted token hourly, so there is nothing for the operator to track.
 * - `api_access_token` with no recorded expiry: NEVER a green checkmark —
 *   pretending Loxep knows is the one failure this affordance exists to
 *   avoid. Reads "expiry not recorded" in `warning` tone, same as every
 *   other operator-caused (not-yet-failed) gap on this table.
 * - `api_access_token` with a recorded expiry: shows the date; within
 *   `TAILSCALE_EXPIRY_WARNING_DAYS` days (or already past) it becomes
 *   attention-worthy (`warning`); otherwise a neutral `outline` chip.
 *
 * The actual edit control is `TailscaleExpiryDialog`, opened from
 * `cell-action.tsx`'s admin-only row menu — see that component's doc for why
 * the mutation trigger does not live in this read cell.
 */
export function TailscaleCredentialExpiryCell({ connection }: { connection: ConnectionDto }) {
  const mode = tailscaleCredentialMode(connection);
  if (mode === 'oauth_client') {
    return <Badge variant='secondary'>auto-renewing</Badge>;
  }

  const recordedAt = tailscaleCredentialExpiresAt(connection);
  if (recordedAt === null) {
    return (
      <ToneBadge
        tone='warning'
        title="Tailscale's admin console shows this token's expiry — record it from the row menu so Loxep can warn you before it dies."
      >
        expiry not recorded
      </ToneBadge>
    );
  }

  const remaining = daysUntil(recordedAt);
  const attentionWorthy = remaining !== null && remaining <= TAILSCALE_EXPIRY_WARNING_DAYS;
  return (
    <ToneBadge
      tone={attentionWorthy ? 'warning' : 'outline'}
      title={
        remaining === null
          ? undefined
          : remaining <= 0
            ? 'Recorded expiry has passed'
            : `${remaining} day${remaining === 1 ? '' : 's'} remaining`
      }
    >
      {formatDate(recordedAt)}
    </ToneBadge>
  );
}
