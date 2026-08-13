import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { createConnection, createStoreConnection, type EntityDto } from '@/server/admin-functions';
import {
  DEFAULT_EBAY_CONSENT_TIER,
  EBAY_CONSENT_TIER_DESCRIPTIONS,
  EBAY_CONSENT_TIER_IDS,
  EBAY_CONSENT_TIER_LABELS,
  startEbayConsent
} from '@/server/ebay-oauth';
import {
  DEFAULT_ETSY_CONSENT_TIER,
  ETSY_CONSENT_TIER_DESCRIPTIONS,
  ETSY_CONSENT_TIER_IDS,
  ETSY_CONSENT_TIER_LABELS,
  startEtsyConsent
} from '@/server/etsy-oauth';
import {
  connectionsQuery,
  ebayKeysetStatusQuery,
  etsyKeysetStatusQuery
} from '@/features/settings/api/queries';
import { NO_ENTITY_VALUE } from '@/features/settings/constants';
import { submitFormEvent } from '@/features/settings/lib/dialog-form';
import {
  GuidanceCallout,
  GuidanceLink,
  GuidanceNote,
  GuidanceStep,
  GuidanceSteps,
  SetupGuidance
} from '@/features/settings/components/setup-guidance';
import type { IntegrationService } from '@/features/settings/integrations-catalog';

/**
 * Guided "Add account" dialog — one form per catalog service.
 *
 * The service is chosen BEFORE this dialog opens (from the per-service
 * "Add account" action on `/settings/connections`), so `provider` and `kind`
 * come from the catalog entry and are never typed, and there is no raw JSON
 * config box anywhere in this path. Secret fields are write-only: they are
 * submitted once, stored encrypted server-side, and never read back.
 *
 * Every form also carries the provider's own credential-acquisition path
 * inline (`@/features/settings/components/setup-guidance`), because a form
 * that only labels its fields sends the operator out of the app to find out
 * what to type. The eBay form has no credentials to explain — its consent
 * hand-off is what needs teaching, in particular the sandbox-test-user rule.
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
        ) : accounts.form === 'etsy-consent' ? (
          <EtsyAccountForm service={service} entities={entities} onDone={onOpenChange} />
        ) : accounts.form === 'woo-api' ? (
          <WooAccountForm entities={entities} onDone={onOpenChange} />
        ) : accounts.form === 'medusa-api' ? (
          <MedusaAccountForm entities={entities} onDone={onOpenChange} />
        ) : (
          <InvoiceNinjaAccountForm entities={entities} onDone={onOpenChange} />
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

const ebayAccountSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  economicEntityId: z.string(),
  consentTier: z.enum(EBAY_CONSENT_TIER_IDS)
});

/**
 * The scope-tier choice (loxep-ld0). Only the TIER ID travels — the scopes it
 * resolves to are chosen server-side from the eBay package's constants, so
 * nothing here can widen a consent.
 */
const EBAY_CONSENT_TIER_OPTIONS = EBAY_CONSENT_TIER_IDS.map((tier) => ({
  value: tier,
  label: EBAY_CONSENT_TIER_LABELS[tier]
}));

const EBAY_CONSENT_TIER_FIELD_DESCRIPTION = `${EBAY_CONSENT_TIER_LABELS.watchlist}: ${EBAY_CONSENT_TIER_DESCRIPTIONS.watchlist} ${EBAY_CONSENT_TIER_LABELS.orders}: ${EBAY_CONSENT_TIER_DESCRIPTIONS.orders}`;

const EBAY_SANDBOX_USER_DOCS_URL =
  'https://developer.ebay.com/api-docs/static/gs_create-a-test-sandbox-user.html';

/**
 * Consent-step guidance. Nothing is copied from a portal here, so this
 * explains the hand-off instead — and, when the installation's keyset is a
 * sandbox one, the fact that stops most first attempts: eBay's sandbox
 * sign-in only accepts sandbox test users.
 */
function EbayConsentGuidance() {
  const { data } = useQuery(ebayKeysetStatusQuery);
  const environment = data?.environment ?? null;

  return (
    <SetupGuidance title='What happens next'>
      <GuidanceSteps>
        <GuidanceStep>
          Loxep records the account, then sends this tab to eBay&apos;s consent screen.
        </GuidanceStep>
        <GuidanceStep>
          Sign in there as the eBay account you want Loxep to watch, and accept the requested
          access.
        </GuidanceStep>
        <GuidanceStep>
          eBay returns you here. The account shows as connected once the token is stored; declining
          leaves the record in place, unconnected, so you can retry.
        </GuidanceStep>
      </GuidanceSteps>
      {environment === 'sandbox' && (
        <GuidanceCallout>
          <p>
            This installation&apos;s keyset is a <strong>sandbox</strong> keyset, so the consent
            screen is eBay&apos;s sandbox sign-in. Only a <strong>sandbox test user</strong> can
            sign in there — a real eBay account cannot, however valid it is.
          </p>
          <p>
            Register one in the eBay developer portal under <strong>User Access Tokens</strong> →{' '}
            <strong>Register a new Sandbox user</strong>; sandbox usernames are always prefixed{' '}
            <code className='font-mono'>TESTUSER_</code>.{' '}
            <GuidanceLink href={EBAY_SANDBOX_USER_DOCS_URL}>eBay&apos;s instructions</GuidanceLink>
          </p>
        </GuidanceCallout>
      )}
      {environment === 'production' && (
        <GuidanceCallout>
          <p>
            This installation&apos;s keyset is a <strong>production</strong> keyset, so the consent
            screen is the live eBay sign-in — use the real eBay account whose activity you want
            Loxep to observe.
          </p>
        </GuidanceCallout>
      )}
      <GuidanceNote>
        Pick the narrower access if you are unsure. eBay rejects the whole consent — not just the
        extra permission — when the installation&apos;s keyset was never granted the order scope,
        and an account connected for watchlists can be re-consented for orders later from its{' '}
        <strong>Grant order access</strong> action.
      </GuidanceNote>
      <GuidanceNote>
        Loxep only ever reads from eBay. Consent can be withdrawn from eBay&apos;s own account
        settings, and removing the connection here deletes the stored token.
      </GuidanceNote>
    </SetupGuidance>
  );
}

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
      return startEbayConsent({ data: { connectionId: created.id, tier: values.consentTier } });
    },
    onSuccess: (consent) => {
      queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
      window.location.href = consent.url;
    },
    onError: (error) => toastError(error, 'Failed to start the eBay consent flow')
  });

  const form = useAppForm({
    defaultValues: {
      name: '',
      economicEntityId: NO_ENTITY_VALUE,
      consentTier: DEFAULT_EBAY_CONSENT_TIER
    },
    validators: { onSubmit: ebayAccountSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
      <EbayConsentGuidance />
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
        <form.AppField
          name='consentTier'
          children={(field) => (
            <field.RadioGroupField
              label='Access to request'
              required
              options={EBAY_CONSENT_TIER_OPTIONS}
              description={EBAY_CONSENT_TIER_FIELD_DESCRIPTION}
            />
          )}
        />
      </FieldGroup>
      <div className='flex justify-end gap-2'>
        <Button type='button' variant='outline' onClick={() => onDone(false)}>
          Cancel
        </Button>
        <form.AppForm>
          <form.SubmitButton>Continue to eBay</form.SubmitButton>
        </form.AppForm>
      </div>
    </form>
  );
}

const etsyAccountSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  shopExternalId: z.string().trim().min(1, 'Etsy shop id is required'),
  economicEntityId: z.string(),
  consentTier: z.enum(ETSY_CONSENT_TIER_IDS)
});

const ETSY_CONSENT_TIER_OPTIONS = ETSY_CONSENT_TIER_IDS.map((tier) => ({
  value: tier,
  label: ETSY_CONSENT_TIER_LABELS[tier]
}));

const ETSY_CONSENT_TIER_FIELD_DESCRIPTION = `${ETSY_CONSENT_TIER_LABELS.shop}: ${ETSY_CONSENT_TIER_DESCRIPTIONS.shop} ${ETSY_CONSENT_TIER_LABELS.orders}: ${ETSY_CONSENT_TIER_DESCRIPTIONS.orders}`;

/**
 * Consent-step guidance, mirroring `EbayConsentGuidance`'s shape. Etsy has
 * no sandbox, so there is no environment-dependent branch to show — every
 * connection here talks to the real Etsy site the moment the keyset is
 * approved.
 */
function EtsyConsentGuidance() {
  const { data } = useQuery(etsyKeysetStatusQuery);

  return (
    <SetupGuidance title='What happens next'>
      <GuidanceSteps>
        <GuidanceStep>
          Loxep records the shop, then sends this tab to Etsy&apos;s consent screen.
        </GuidanceStep>
        <GuidanceStep>
          Sign in there as the Etsy account that owns the shop, and accept the requested access.
        </GuidanceStep>
        <GuidanceStep>
          Etsy returns you here. The shop shows as connected once the token is stored; declining
          leaves the record in place, unconnected, so you can retry.
        </GuidanceStep>
      </GuidanceSteps>
      {data?.configured === true && (
        <GuidanceCallout>
          <p>
            Etsy has no sandbox — this consent talks to the real Etsy site. Sign in as the account
            that actually owns the shop you want Loxep to observe.
          </p>
        </GuidanceCallout>
      )}
      <GuidanceNote>
        Pick the narrower access if you are unsure — order access is not yet used by Loxep&apos;s
        polling, so <strong>Shop &amp; listings</strong> is the right choice for observation.
      </GuidanceNote>
      <GuidanceNote>
        Loxep only ever reads from Etsy. Consent can be withdrawn from Etsy&apos;s own account
        settings, and removing the connection here deletes the stored token.
      </GuidanceNote>
    </SetupGuidance>
  );
}

/**
 * Etsy: the connection row is created first (carrying the shop's non-secret
 * id in `config.etsy.shopExternalId`), then the browser is sent to Etsy's
 * PKCE consent screen through a full top-level navigation — the CSRF nonce
 * AND the PKCE code_verifier live in same-browser httpOnly cookies that
 * only a real navigation carries back through the callback (see
 * `startEtsyConsent` in `@/server/etsy-oauth`).
 */
function EtsyAccountForm({
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
    mutationFn: async (values: z.infer<typeof etsyAccountSchema>) => {
      const created = await createConnection({
        data: {
          provider: accounts?.provider ?? 'etsy',
          kind: accounts?.kind ?? 'marketplace_account',
          name: values.name,
          config: { etsy: { shopExternalId: values.shopExternalId } },
          economicEntityId: entityIdFrom(values.economicEntityId)
        }
      });
      return startEtsyConsent({ data: { connectionId: created.id, tier: values.consentTier } });
    },
    onSuccess: (consent) => {
      queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
      window.location.href = consent.url;
    },
    onError: (error) => toastError(error, 'Failed to start the Etsy consent flow')
  });

  const form = useAppForm({
    defaultValues: {
      name: '',
      shopExternalId: '',
      economicEntityId: NO_ENTITY_VALUE,
      consentTier: DEFAULT_ETSY_CONSENT_TIER
    },
    validators: { onSubmit: etsyAccountSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
      <EtsyConsentGuidance />
      <FieldGroup>
        <form.AppField
          name='name'
          children={(field) => (
            <field.TextField
              label='Shop name'
              required
              placeholder='My Etsy shop'
              description='How this shop is labelled inside Loxep.'
            />
          )}
        />
        <form.AppField
          name='shopExternalId'
          children={(field) => (
            <field.TextField
              label='Etsy shop id'
              required
              placeholder='e.g. 12345678'
              description="The numeric shop id Etsy assigns — visible in the shop's dashboard URL, not the shop's name."
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
        <form.AppField
          name='consentTier'
          children={(field) => (
            <field.RadioGroupField
              label='Access to request'
              required
              options={ETSY_CONSENT_TIER_OPTIONS}
              description={ETSY_CONSENT_TIER_FIELD_DESCRIPTION}
            />
          )}
        />
      </FieldGroup>
      <div className='flex justify-end gap-2'>
        <Button type='button' variant='outline' onClick={() => onDone(false)}>
          Cancel
        </Button>
        <form.AppForm>
          <form.SubmitButton>Continue to Etsy</form.SubmitButton>
        </form.AppForm>
      </div>
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

const WOO_REST_API_DOCS_URL = 'https://woocommerce.com/document/woocommerce-rest-api/';

/** The WooCommerce admin path that issues a REST API key pair. */
function WooSetupGuidance() {
  return (
    <SetupGuidance>
      <GuidanceSteps>
        <GuidanceStep>
          Sign in to the store&apos;s WordPress admin as a user with the shop-manager or
          administrator role.
        </GuidanceStep>
        <GuidanceStep>
          Go to <strong>WooCommerce</strong> → <strong>Settings</strong> → <strong>Advanced</strong>{' '}
          → <strong>REST API</strong>, then choose <strong>Add key</strong>.
        </GuidanceStep>
        <GuidanceStep>
          Give it a description you will recognise later, pick the user the key acts as, and set
          Permissions to <strong>Read</strong>.
          <GuidanceNote>
            Loxep never writes to a store, so a read/write key buys nothing and risks the catalogue.
          </GuidanceNote>
        </GuidanceStep>
        <GuidanceStep>
          Choose <strong>Generate API key</strong> and copy the consumer key (
          <code className='font-mono'>ck_…</code>) and consumer secret (
          <code className='font-mono'>cs_…</code>) into the fields below.
        </GuidanceStep>
        <GuidanceStep>
          The store URL is the site root —{' '}
          <code className='font-mono'>https://store.example.com</code> — not the{' '}
          <code className='font-mono'>/wp-json/</code> REST path.
        </GuidanceStep>
      </GuidanceSteps>
      <GuidanceCallout>
        <p>
          WooCommerce shows the key pair once. If you leave that screen without copying both halves,
          revoke the key and generate a new one.
        </p>
        <p>
          The REST API needs pretty permalinks enabled and the store served over HTTPS.{' '}
          <GuidanceLink href={WOO_REST_API_DOCS_URL}>WooCommerce&apos;s documentation</GuidanceLink>
        </p>
      </GuidanceCallout>
    </SetupGuidance>
  );
}

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
    onError: (error) => toastError(error, 'Failed to connect the store')
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
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
      <WooSetupGuidance />
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
              description='From the read-only REST API key generated in the store admin.'
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
      <div className='flex justify-end gap-2'>
        <Button type='button' variant='outline' onClick={() => onDone(false)}>
          Cancel
        </Button>
        <form.AppForm>
          <form.SubmitButton>Connect store</form.SubmitButton>
        </form.AppForm>
      </div>
    </form>
  );
}

const medusaAccountSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  baseUrl: z.url('Enter the full backend URL, including https://'),
  apiToken: z.string().trim().min(1, 'API key is required'),
  economicEntityId: z.string()
});

const MEDUSA_SECRET_KEY_DOCS_URL =
  'https://docs.medusajs.com/user-guide/settings/developer/secret-api-keys';

/** Where a Medusa v2 admin dashboard issues a secret API key. */
function MedusaSetupGuidance() {
  return (
    <SetupGuidance>
      <GuidanceSteps>
        <GuidanceStep>
          Sign in to the backend&apos;s Medusa Admin dashboard as an admin user.
        </GuidanceStep>
        <GuidanceStep>
          Open <strong>Settings</strong> → <strong>Secret API Keys</strong>, then{' '}
          <strong>Create</strong>.
          <GuidanceNote>
            Older dashboards group the same screen under Settings → Developer → API key management.
          </GuidanceNote>
        </GuidanceStep>
        <GuidanceStep>
          Copy the generated key into the field below.{' '}
          <GuidanceLink href={MEDUSA_SECRET_KEY_DOCS_URL}>Medusa&apos;s documentation</GuidanceLink>
        </GuidanceStep>
        <GuidanceStep>
          The backend URL is the server root —{' '}
          <code className='font-mono'>https://commerce.example.com</code> — not the{' '}
          <code className='font-mono'>/admin</code> API path.
        </GuidanceStep>
      </GuidanceSteps>
      <GuidanceCallout>
        <p>
          Medusa shows a secret key once, when it is created. Medusa also does not scope secret keys
          read-only, so treat the key as full admin access to that backend — Loxep itself only ever
          reads.
        </p>
      </GuidanceCallout>
    </SetupGuidance>
  );
}

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
    onError: (error) => toastError(error, 'Failed to connect the backend')
  });

  const form = useAppForm({
    defaultValues: {
      name: '',
      baseUrl: '',
      apiToken: '',
      economicEntityId: NO_ENTITY_VALUE
    },
    validators: { onSubmit: medusaAccountSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
      <MedusaSetupGuidance />
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
              description='From Settings → Secret API Keys in the Medusa dashboard. Write-only: stored encrypted, never displayed again.'
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
      <div className='flex justify-end gap-2'>
        <Button type='button' variant='outline' onClick={() => onDone(false)}>
          Cancel
        </Button>
        <form.AppForm>
          <form.SubmitButton>Connect backend</form.SubmitButton>
        </form.AppForm>
      </div>
    </form>
  );
}

const invoiceNinjaAccountSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  baseUrl: z.url('Enter the full instance URL, including https://'),
  apiToken: z.string().trim().min(1, 'API token is required'),
  economicEntityId: z.string()
});

/** Where a self-hosted Invoice Ninja instance issues a company API token. */
function InvoiceNinjaSetupGuidance() {
  return (
    <SetupGuidance>
      <GuidanceSteps>
        <GuidanceStep>Sign in to the instance as an admin user.</GuidanceStep>
        <GuidanceStep>
          Open <strong>Settings</strong> → <strong>Account Management</strong> →{' '}
          <strong>API Tokens</strong>, then <strong>Add token</strong>.
          <GuidanceNote>
            If the labels differ from these, look for the API-token area within Account Management
            settings.
          </GuidanceNote>
        </GuidanceStep>
        <GuidanceStep>
          Name it something you will recognise and confirm. Copy the generated token into the field
          below.
        </GuidanceStep>
        <GuidanceStep>
          The instance URL is the site root —{' '}
          <code className='font-mono'>https://billing.example.com</code> — not the{' '}
          <code className='font-mono'>/api/v1</code> API path.
        </GuidanceStep>
      </GuidanceSteps>
      <GuidanceCallout>
        <p>
          Invoice Ninja shows a token once, when it is created. Invoice Ninja does not scope company
          tokens read-only, so treat the token as full access to that user&apos;s company — Loxep
          only pushes invoice drafts and client records it created itself, and never pulls invoice
          lines back once issued.
        </p>
      </GuidanceCallout>
    </SetupGuidance>
  );
}

function InvoiceNinjaAccountForm({
  entities,
  onDone
}: {
  entities: EntityDto[];
  onDone: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof invoiceNinjaAccountSchema>) =>
      createStoreConnection({
        data: {
          service: 'invoiceninja',
          name: values.name,
          baseUrl: values.baseUrl,
          apiToken: values.apiToken,
          economicEntityId: entityIdFrom(values.economicEntityId)
        }
      }),
    onSuccess: () => {
      toast.success('Invoice Ninja instance connected');
      queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
      onDone(false);
    },
    onError: (error) => toastError(error, 'Failed to connect the instance')
  });

  const form = useAppForm({
    defaultValues: {
      name: '',
      baseUrl: '',
      apiToken: '',
      economicEntityId: NO_ENTITY_VALUE
    },
    validators: { onSubmit: invoiceNinjaAccountSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
      <InvoiceNinjaSetupGuidance />
      <FieldGroup>
        <form.AppField
          name='name'
          children={(field) => (
            <field.TextField
              label='Instance name'
              required
              placeholder='Main billing instance'
              description='How this instance is labelled inside Loxep.'
            />
          )}
        />
        <form.AppField
          name='baseUrl'
          children={(field) => (
            <field.TextField
              label='Instance URL'
              required
              placeholder='https://billing.example.com'
              description='The instance root, not the /api/v1 path.'
            />
          )}
        />
        <form.AppField
          name='apiToken'
          children={(field) => (
            <field.TextField
              label='API token'
              required
              type='password'
              autoComplete='new-password'
              description='From Settings → Account Management → API Tokens. Write-only: stored encrypted, never displayed again.'
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
      <div className='flex justify-end gap-2'>
        <Button type='button' variant='outline' onClick={() => onDone(false)}>
          Cancel
        </Button>
        <form.AppForm>
          <form.SubmitButton>Connect instance</form.SubmitButton>
        </form.AppForm>
      </div>
    </form>
  );
}
