import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import {
  mailConnectionOptionsQuery,
  managedDomainQuery
} from '@/features/infrastructure/api/queries';
import { ToneBadge } from '@/features/settings/components/status-tone';
import {
  applyDefaultMailboxTemplate,
  enableMailForDomain
} from '@/server/infrastructure-functions';
import type { MailboxDto, MailStateDto } from '@/server/infrastructure-functions';
import MailTemplatesDialog from '@/features/infrastructure/components/mail-templates-dialog';

function EnableMailForm({ domainId, domainName }: { domainId: string; domainName: string }) {
  const queryClient = useQueryClient();
  const { data: connections } = useQuery(mailConnectionOptionsQuery);
  const [connectionId, setConnectionId] = React.useState<string>('');

  const mutation = useMutation({
    mutationFn: () => enableMailForDomain({ data: { domainId, mailConnectionId: connectionId } }),
    onSuccess: async () => {
      toast.success('Mail registration enqueued');
      await queryClient.invalidateQueries({ queryKey: managedDomainQuery(domainName).queryKey });
    },
    onError: (error) => toastError(error, 'Failed to enable mail')
  });

  if (connections !== undefined && connections.length === 0) {
    return (
      <Empty className='p-0'>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.notification />
          </EmptyMedia>
          <EmptyTitle>No mail connection yet</EmptyTitle>
          <EmptyDescription>
            Add a mail-provider connection under Settings → Integrations → Infrastructure first.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor='mail-connection'>Mail connection</FieldLabel>
        <Select value={connectionId} onValueChange={setConnectionId}>
          <SelectTrigger id='mail-connection'>
            <SelectValue placeholder='Select a mail provider connection' />
          </SelectTrigger>
          <SelectContent>
            {(connections ?? []).map((connection) => (
              <SelectItem key={connection.id} value={connection.id}>
                {connection.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Button
        size='sm'
        disabled={connectionId === '' || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        Enable mail
      </Button>
    </FieldGroup>
  );
}

function MailboxRow({ mailbox }: { mailbox: MailboxDto }) {
  return (
    <li className='flex items-center justify-between gap-2 rounded-md border px-3 py-2'>
      <div className='flex items-center gap-2'>
        <span className='font-mono text-sm'>{mailbox.localPart}</span>
        <Badge variant='outline'>{mailbox.kind}</Badge>
        {mailbox.forwardTo && (
          <span className='text-muted-foreground text-sm'>→ {mailbox.forwardTo}</span>
        )}
      </div>
      {mailbox.desiredDeletedAt ? (
        <Badge variant='secondary'>removing</Badge>
      ) : mailbox.providerCreatedAt ? (
        <Badge variant='success'>
          <Icons.circleCheck />
          provisioned
        </Badge>
      ) : (
        <Badge variant='warning'>
          <Icons.clock />
          pending
        </Badge>
      )}
    </li>
  );
}

export default function MailPanel({
  domainId,
  domainName,
  mailEnabled,
  mail,
  mailboxes
}: {
  domainId: string;
  domainName: string;
  mailEnabled: boolean;
  mail: MailStateDto | null;
  mailboxes: MailboxDto[];
}) {
  const queryClient = useQueryClient();
  const [templatesOpen, setTemplatesOpen] = React.useState(false);

  const templateMutation = useMutation({
    mutationFn: () => applyDefaultMailboxTemplate({ data: { domainId } }),
    onSuccess: async (result) => {
      toast.success(
        `Template applied — ${result.created} created, ${result.resurrected} restored, ${result.unchanged} unchanged`
      );
      await queryClient.invalidateQueries({ queryKey: managedDomainQuery(domainName).queryKey });
    },
    onError: (error) => toastError(error, 'Failed to apply the mailbox template')
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Mail</CardTitle>
        <CardDescription>
          Provider registration, ownership verification, and mailboxes.
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-4'>
        {!mailEnabled ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.notification />
              </EmptyMedia>
              <EmptyTitle>Mail is disabled for this domain</EmptyTitle>
              <EmptyDescription>
                Enable it from the domain's intent to register mail.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : mail === null ? (
          <EnableMailForm domainId={domainId} domainName={domainName} />
        ) : (
          <>
            <div className='flex flex-wrap items-center gap-2'>
              {mail.ownershipVerifiedAt !== null ? (
                <ToneBadge tone='success'>Ownership verified</ToneBadge>
              ) : mail.providerAddedAt !== null ? (
                <ToneBadge tone='warning'>Awaiting ownership verification</ToneBadge>
              ) : (
                <ToneBadge tone='secondary'>Not yet registered at provider</ToneBadge>
              )}
              {mail.verifyAttempts > 0 && (
                <span className='text-muted-foreground text-sm'>
                  {mail.verifyAttempts} verify attempt{mail.verifyAttempts === 1 ? '' : 's'}
                </span>
              )}
            </div>
            {mail.lastVerifyError && (
              <p className='text-muted-foreground text-sm'>
                Last attempt ({formatDateTime(mail.lastVerifyAt)}): {mail.lastVerifyError}
              </p>
            )}

            <div className='flex flex-col gap-2'>
              <div className='flex items-center justify-between'>
                <h3 className='text-sm font-medium'>Mailboxes</h3>
                <div className='flex items-center gap-2'>
                  <Button size='sm' variant='ghost' onClick={() => setTemplatesOpen(true)}>
                    View templates
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={templateMutation.isPending}
                    onClick={() => templateMutation.mutate()}
                  >
                    Apply default template
                  </Button>
                </div>
              </div>
              <MailTemplatesDialog open={templatesOpen} onOpenChange={setTemplatesOpen} />
              {mailboxes.length === 0 ? (
                <p className='text-muted-foreground text-sm'>No mailboxes declared yet.</p>
              ) : (
                <ul className='flex flex-col gap-2'>
                  {mailboxes.map((mailbox) => (
                    <MailboxRow key={mailbox.id} mailbox={mailbox} />
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
