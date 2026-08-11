import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { FieldGroup } from '@/components/ui/field';
import { useAppForm } from '@/lib/form';
import { createConnection, createStoreConnection, type EntityDto } from '@/server/admin-functions';
import { startEbayConsent } from '@/server/ebay-oauth';
import { connectionsQuery } from '@/features/settings/api/queries';
import { NO_ENTITY_VALUE } from '@/features/settings/constants';
import type { IntegrationService } from '@/features/settings/integrations-catalog';

/**
 * Guided "Add account" dialog — one form per catalog service.
 *
 * The service is chosen BEFORE this dialog opens (from the per-service
 * "Add account" action on `/settings/connections`), so `provider` and `kind`
 * come from the catalog entry and are never typed, and there is no raw JSON
 * config box anywhere in this path. Secret fields are write-only: they are
 * submitted once, stored encrypted server-side, and never read back.
 */
export default function ConnectionAddDialog({
  service,
  open,
  onOpenChange,
  entities
}: {
  service: IntegrationService;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entities: EntityDto[];
}) {
  const accounts = service.accounts;
  if (accounts === null) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[520px]'>
        <DialogHeader>
          <DialogTitle>{accounts.addLabel}</DialogTitle>
          <DialogDescription>{accounts.formHint}</DialogDescription>
        </DialogHeader>
        {accounts.form === 'ebay-consent' ? (
          <EbayAccountForm service={service} entities={entities} onDone={onOpenChange} />
        ) : accounts.form === 'woo-api' ? (
          <WooAccountForm entities={entities} onDone={onOpenChange} />
        ) : (
          <MedusaAccountForm entities={entities} onDone={onOpenChange} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function entityOptionsFrom(entities: EntityDto[]) {
  return [
    { value: NO_ENTITY_VALUE, label: 'No attribution' },
    ...entities
      .filter((entity) => entity.active)
      .map((entity) => ({ value: entity.id, label: entity.name }))
  ];
}

function entityIdFrom(value: string): string | null {
  return value === NO_ENTITY_VALUE ? null : value;
}

const ENTITY_FIELD_DESCRIPTION = 'Business context only — grants and restricts nothing.';

function FormActions({
  onCancel,
  submitLabel,
  pending
}: {
  onCancel: () => void;
  submitLabel: string;
  pending: boolean;
}) {
  return (
    <div className='flex justify-end gap-2'>
      <Button type='button' variant='outline' onClick={onCancel}>
        Cancel
      </Button>
      <Button type='submit' disabled={pending}>
        {submitLabel}
      </Button>
    </div>
  );
}

const ebayAccountSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  economicEntityId: z.string()
});

/**
 * eBay: the connection row is created first, then the browser is sent to
 * eBay's consent screen through a full top-level navigation — the CSRF nonce
 * lives in a same-browser httpOnly cookie that only a real navigation carries
 * back through the callback (see `startEbayConsent` in `@/server/ebay-oauth`).
 */
function EbayAccountForm({
  service,
  entities,
  onDone
}: {
  service: IntegrationService;
  entities: EntityDto[];
  onDone: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const accounts = service.accounts;

  const mutation = useMutation({
    mutationFn: async (values: z.infer<typeof ebayAccountSchema>) => {
      const created = await createConnection({
        data: {
          provider: accounts?.provider ?? 'ebay',
          kind: accounts?.kind ?? 'marketplace_account',
          name: values.name,
          config: {},
          economicEntityId: entityIdFrom(values.economicEntityId)
        }
      });
      return startEbayConsent({ data: { connectionId: created.id } });
    },
    onSuccess: (consent) => {
      queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
      window.location.href = consent.url;
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to start the eBay consent flow');
    }
  });

  const form = useAppForm({
    defaultValues: { name: '', economicEntityId: NO_ENTITY_VALUE },
    validators: { onSubmit: ebayAccountSchema },
    onSubmit: ({ value }) => mutation.mutate(value)
  });

  return (
    <form
      className='space-y-6'
      onSubmit={(e) => {
        e.preventDefault();
        form.handleSubmit();
      }}
    >
      <FieldGroup>
        <form.AppField
          name='name'
          children={(field) => (
            <field.TextField
              label='Account name'
              required
              placeholder='Shop account'
              description='How this eBay account is labelled inside Loxep.'
            />
          )}
        />
        <form.AppField
          name='economicEntityId'
          children={(field) => (
            <field.SelectField
              label='Economic entity'
              options={entityOptionsFrom(entities)}
              placeholder='No attribution'
              description={ENTITY_FIELD_DESCRIPTION}
            />
          )}
        />
      </FieldGroup>
      <p className='text-muted-foreground text-sm'>
        Continuing opens eBay&apos;s consent screen in this tab. eBay sends you back here once you
        accept or decline.
      </p>
      <FormActions
        onCancel={() => onDone(false)}
        submitLabel='Continue to eBay'
        pending={mutation.isPending}
      />
    </form>
  );
}

const wooAccountSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  baseUrl: z.url('Enter the full store URL, including https://'),
  consumerKey: z.string().trim().min(1, 'Consumer key is required'),
  consumerSecret: z.string().trim().min(1, 'Consumer secret is required'),
  economicEntityId: z.string()
});

function WooAccountForm({
  entities,
  onDone
}: {
  entities: EntityDto[];
  onDone: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof wooAccountSchema>) =>
      createStoreConnection({
        data: {
          service: 'woocommerce',
          name: values.name,
          baseUrl: values.baseUrl,
          consumerKey: values.consumerKey,
          consumerSecret: values.consumerSecret,
          economicEntityId: entityIdFrom(values.economicEntityId)
        }
      }),
    onSuccess: () => {
      toast.success('WooCommerce store connected');
      queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
      onDone(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to connect the store');
    }
  });

  const form = useAppForm({
    defaultValues: {
      name: '',
      baseUrl: '',
      consumerKey: '',
      consumerSecret: '',
      economicEntityId: NO_ENTITY_VALUE
    },
    validators: { onSubmit: wooAccountSchema },
    onSubmit: ({ value }) => mutation.mutate(value)
  });

  return (
    <form
      className='space-y-6'
      onSubmit={(e) => {
        e.preventDefault();
        form.handleSubmit();
      }}
    >
      <FieldGroup>
        <form.AppField
          name='name'
          children={(field) => (
            <field.TextField
              label='Store name'
              required
              placeholder='Main store'
              description='How this store is labelled inside Loxep.'
            />
          )}
        />
        <form.AppField
          name='baseUrl'
          children={(field) => (
            <field.TextField
              label='Store URL'
              required
              placeholder='https://store.example.com'
              description='The site root, not the REST path.'
            />
          )}
        />
        <form.AppField
          name='consumerKey'
          children={(field) => (
            <field.TextField
              label='Consumer key'
              required
              autoComplete='off'
              placeholder='ck_…'
              description='Create a read-only REST API key in WooCommerce under Settings → Advanced → REST API.'
            />
          )}
        />
        <form.AppField
          name='consumerSecret'
          children={(field) => (
            <field.TextField
              label='Consumer secret'
              required
              type='password'
              autoComplete='new-password'
              placeholder='cs_…'
              description='Write-only: stored encrypted, never displayed again.'
            />
          )}
        />
        <form.AppField
          name='economicEntityId'
          children={(field) => (
            <field.SelectField
              label='Economic entity'
              options={entityOptionsFrom(entities)}
              placeholder='No attribution'
              description={ENTITY_FIELD_DESCRIPTION}
            />
          )}
        />
      </FieldGroup>
      <FormActions
        onCancel={() => onDone(false)}
        submitLabel='Connect store'
        pending={mutation.isPending}
      />
    </form>
  );
}

const medusaAccountSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  baseUrl: z.url('Enter the full backend URL, including https://'),
  apiToken: z.string().trim().min(1, 'API key is required'),
  economicEntityId: z.string()
});

function MedusaAccountForm({
  entities,
  onDone
}: {
  entities: EntityDto[];
  onDone: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof medusaAccountSchema>) =>
      createStoreConnection({
        data: {
          service: 'medusa',
          name: values.name,
          baseUrl: values.baseUrl,
          apiToken: values.apiToken,
          economicEntityId: entityIdFrom(values.economicEntityId)
        }
      }),
    onSuccess: () => {
      toast.success('Medusa backend connected');
      queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
      onDone(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to connect the backend');
    }
  });

  const form = useAppForm({
    defaultValues: {
      name: '',
      baseUrl: '',
      apiToken: '',
      economicEntityId: NO_ENTITY_VALUE
    },
    validators: { onSubmit: medusaAccountSchema },
    onSubmit: ({ value }) => mutation.mutate(value)
  });

  return (
    <form
      className='space-y-6'
      onSubmit={(e) => {
        e.preventDefault();
        form.handleSubmit();
      }}
    >
      <FieldGroup>
        <form.AppField
          name='name'
          children={(field) => (
            <field.TextField
              label='Backend name'
              required
              placeholder='Main backend'
              description='How this backend is labelled inside Loxep.'
            />
          )}
        />
        <form.AppField
          name='baseUrl'
          children={(field) => (
            <field.TextField
              label='Backend URL'
              required
              placeholder='https://admin.example.com'
              description='The backend root, not the /admin API path.'
            />
          )}
        />
        <form.AppField
          name='apiToken'
          children={(field) => (
            <field.TextField
              label='Secret API key'
              required
              type='password'
              autoComplete='new-password'
              placeholder='sk_…'
              description='Create one in the Medusa dashboard under Settings → Developer → Secret API keys. Write-only: stored encrypted, never displayed again.'
            />
          )}
        />
        <form.AppField
          name='economicEntityId'
          children={(field) => (
            <field.SelectField
              label='Economic entity'
              options={entityOptionsFrom(entities)}
              placeholder='No attribution'
              description={ENTITY_FIELD_DESCRIPTION}
            />
          )}
        />
      </FieldGroup>
      <FormActions
        onCancel={() => onDone(false)}
        submitLabel='Connect backend'
        pending={mutation.isPending}
      />
    </form>
  );
}
