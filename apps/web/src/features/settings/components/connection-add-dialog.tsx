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
        ) : accounts.form === 'reverb-api' ? (
          <ReverbAccountForm entities={entities} onDone={onOpenChange} />
        ) : accounts.form === 'woo-api' ? (
          <WooAccountForm entities={entities} onDone={onOpenChange} />
        ) : accounts.form === 'medusa-api' ? (
          <MedusaAccountForm entities={entities} onDone={onOpenChange} />
        ) : accounts.form === 'invoiceninja-api' ? (
          <InvoiceNinjaAccountForm entities={entities} onDone={onOpenChange} />
        ) : accounts.form === 'cloudflare-api' ? (
          <CloudflareAccountForm entities={entities} onDone={onOpenChange} />
        ) : accounts.form === 'purelymail-api' ? (
          <PurelymailAccountForm entities={entities} onDone={onOpenChange} />
        ) : accounts.form === 'tailscale-api' ? (
          <TailscaleAccountForm entities={entities} onDone={onOpenChange} />
        ) : (
          <TermixAccountForm entities={entities} onDone={onOpenChange} />
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

const reverbAccountSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  personalAccessToken: z.string().trim().min(1, 'Personal Access Token is required'),
  economicEntityId: z.string()
});

/**
 * Reverb's Personal Access Token is minted in the operator's own account
 * settings, self-service and instant — no application review, no approval
 * wait, unlike eBay's/Etsy's consent flows above. Scopes are chosen by the
 * OPERATOR when minting the token in Reverb's own UI; Loxep cannot request
 * or negotiate them the way it negotiates an OAuth consent, so this
 * guidance names the scopes to grant rather than a tier picker.
 */
function ReverbSetupGuidance() {
  return (
    <SetupGuidance>
      <GuidanceSteps>
        <GuidanceStep>Sign in to the Reverb account Loxep should observe.</GuidanceStep>
        <GuidanceStep>
          Open <strong>Settings</strong> → <strong>API tokens</strong> (or the equivalent path in
          Reverb&apos;s current account settings) and create a new Personal Access Token.
        </GuidanceStep>
        <GuidanceStep>
          Grant at least <code className='font-mono'>public</code> and{' '}
          <code className='font-mono'>read_listings</code>. Skip every{' '}
          <code className='font-mono'>write_*</code> scope — Loxep only ever reads.
        </GuidanceStep>
        <GuidanceStep>
          Copy the token into the field below. Paste it now: Reverb, like most personal-token
          systems, shows it once.
        </GuidanceStep>
      </GuidanceSteps>
      <GuidanceCallout>
        <p>
          Reverb Personal Access Tokens do not expire and carry no separate application keyset — the
          token itself is the whole credential, and there is no shop id to enter: Loxep always
          observes the token owner&apos;s own account.
        </p>
      </GuidanceCallout>
    </SetupGuidance>
  );
}

function ReverbAccountForm({
  entities,
  onDone
}: {
  entities: EntityDto[];
  onDone: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof reverbAccountSchema>) =>
      createStoreConnection({
        data: {
          service: 'reverb',
          name: values.name,
          personalAccessToken: values.personalAccessToken,
          economicEntityId: entityIdFrom(values.economicEntityId)
        }
      }),
    onSuccess: () => {
      toast.success('Reverb account connected');
      queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
      onDone(false);
    },
    onError: (error) => toastError(error, 'Failed to connect the account')
  });

  const form = useAppForm({
    defaultValues: {
      name: '',
      personalAccessToken: '',
      economicEntityId: NO_ENTITY_VALUE
    },
    validators: { onSubmit: reverbAccountSchema },
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
      <ReverbSetupGuidance />
      <FieldGroup>
        <form.AppField
          name='name'
          children={(field) => (
            <field.TextField
              label='Account name'
              required
              placeholder='Main Reverb account'
              description='How this account is labelled inside Loxep.'
            />
          )}
        />
        <form.AppField
          name='personalAccessToken'
          children={(field) => (
            <field.TextField
              label='Personal Access Token'
              required
              type='password'
              autoComplete='new-password'
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
          <form.SubmitButton>Connect account</form.SubmitButton>
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

const cloudflareAccountSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  accountId: z.string().trim(),
  apiToken: z.string().trim().min(1, 'API token is required'),
  economicEntityId: z.string()
});

const CLOUDFLARE_TOKEN_DOCS_URL =
  'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/';

/**
 * Where the Infrastructure control plane's own Cloudflare token comes from
 * (ADR-0009, loxep-lmy.1). The legacy global API key is deliberately never
 * accepted — see `cloudflare_credentials` in `@loxep/domain`'s bundle
 * registry and `@loxep/integration-cloudflare/config.ts` for the same call.
 */
function CloudflareSetupGuidance() {
  return (
    <SetupGuidance>
      <GuidanceSteps>
        <GuidanceStep>
          Sign in to the Cloudflare dashboard, then open <strong>My Profile</strong> →{' '}
          <strong>API Tokens</strong> (or <strong>Manage Account</strong> →{' '}
          <strong>API Tokens</strong> for a token owned by the account rather than your user).
        </GuidanceStep>
        <GuidanceStep>
          Choose <strong>Create Token</strong>, then use the <strong>Edit zone DNS</strong> template
          — or build a custom token with <strong>Zone · DNS · Edit</strong> and{' '}
          <strong>Zone · Zone · Read</strong>.
        </GuidanceStep>
        <GuidanceStep>
          Under <strong>Zone Resources</strong>, scope the token to the specific zone or zones Loxep
          should manage, not to all zones on the account.
          <GuidanceNote>
            A token that cannot see a zone fails with an authentication error on that zone, not a
            not-found — narrower is safer, but it must cover every zone this connection manages.
          </GuidanceNote>
        </GuidanceStep>
        <GuidanceStep>
          Continue, review the summary, and choose <strong>Create Token</strong>. Cloudflare shows
          the token once — copy it into the field below.{' '}
          <GuidanceLink href={CLOUDFLARE_TOKEN_DOCS_URL}>
            Cloudflare&apos;s instructions
          </GuidanceLink>
        </GuidanceStep>
      </GuidanceSteps>
      <GuidanceCallout>
        <p>
          The legacy global API key is not supported here — it carries every permission on the
          account with no scoping, and Loxep only ever sends a scoped token as{' '}
          <code className='font-mono'>Authorization: Bearer &lt;token&gt;</code>.
        </p>
        <p>
          Account id is optional: a zone-scoped token can list its own zones without one. Leave it
          blank unless a zone-scoped token alone does not resolve for your account.
        </p>
      </GuidanceCallout>
    </SetupGuidance>
  );
}

function CloudflareAccountForm({
  entities,
  onDone
}: {
  entities: EntityDto[];
  onDone: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof cloudflareAccountSchema>) =>
      createStoreConnection({
        data: {
          service: 'cloudflare',
          name: values.name,
          apiToken: values.apiToken,
          ...(values.accountId.trim() === '' ? {} : { accountId: values.accountId.trim() }),
          economicEntityId: entityIdFrom(values.economicEntityId)
        }
      }),
    onSuccess: () => {
      toast.success('Cloudflare account connected');
      queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
      onDone(false);
    },
    onError: (error) => toastError(error, 'Failed to connect the account')
  });

  const form = useAppForm({
    defaultValues: {
      name: '',
      accountId: '',
      apiToken: '',
      economicEntityId: NO_ENTITY_VALUE
    },
    validators: { onSubmit: cloudflareAccountSchema },
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
      <CloudflareSetupGuidance />
      <FieldGroup>
        <form.AppField
          name='name'
          children={(field) => (
            <field.TextField
              label='Account name'
              required
              placeholder='Main Cloudflare account'
              description='How this account is labelled inside Loxep.'
            />
          )}
        />
        <form.AppField
          name='accountId'
          children={(field) => (
            <field.TextField
              label='Account id'
              placeholder='Optional'
              description='Non-secret; kept as ordinary connection configuration. Leave blank for a zone-scoped token.'
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
              description='A scoped Cloudflare API token, never the legacy global key. Write-only: stored encrypted, never displayed again.'
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
          <form.SubmitButton>Connect account</form.SubmitButton>
        </form.AppForm>
      </div>
    </form>
  );
}

const purelymailAccountSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  apiToken: z.string().trim().min(1, 'API token is required'),
  economicEntityId: z.string()
});

/**
 * Purelymail has no token scoping at all (loxep-lmy.2's live-verified note:
 * "one token does everything incl. deleteDomain"), and its account UI is not
 * publicly documented step-by-step the way Cloudflare's is — so this stays
 * deliberately general rather than naming labels that cannot be verified
 * against the provider's own documentation.
 */
function PurelymailSetupGuidance() {
  return (
    <SetupGuidance>
      <GuidanceSteps>
        <GuidanceStep>Sign in to your Purelymail account.</GuidanceStep>
        <GuidanceStep>
          Open the account&apos;s API settings and generate a new API token.
          <GuidanceNote>
            Purelymail&apos;s dashboard labels this area differently across accounts — look for an
            API or developer-access section of account settings.
          </GuidanceNote>
        </GuidanceStep>
        <GuidanceStep>
          Copy the token before leaving the page. Purelymail shows it once and cannot display it
          again.
        </GuidanceStep>
      </GuidanceSteps>
      <GuidanceCallout>
        <p>
          Purelymail tokens are not scoped — the one token can do everything the API exposes,
          including deleting a domain. Treat it as full account access and keep it to a Purelymail
          account you control; Loxep itself only registers domains, polls delegation, and syncs
          mailboxes from the template you configure.
        </p>
        <p>
          Every DNS record Loxep computes for a mail domain — the MX record, the SPF TXT record, all
          three DKIM CNAMEs (Purelymail rotates three keys; publishing fewer makes mail verify only
          intermittently), and the DMARC CNAME — is applied with proxying turned off. A mail record
          must never be proxied through Cloudflare or any other CDN: a proxied MX or DKIM record
          breaks mail delivery, and Loxep enforces this at the schema level as well as here.
        </p>
      </GuidanceCallout>
    </SetupGuidance>
  );
}

function PurelymailAccountForm({
  entities,
  onDone
}: {
  entities: EntityDto[];
  onDone: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof purelymailAccountSchema>) =>
      createStoreConnection({
        data: {
          service: 'purelymail',
          name: values.name,
          apiToken: values.apiToken,
          economicEntityId: entityIdFrom(values.economicEntityId)
        }
      }),
    onSuccess: () => {
      toast.success('Purelymail account connected');
      queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
      onDone(false);
    },
    onError: (error) => toastError(error, 'Failed to connect the account')
  });

  const form = useAppForm({
    defaultValues: {
      name: '',
      apiToken: '',
      economicEntityId: NO_ENTITY_VALUE
    },
    validators: { onSubmit: purelymailAccountSchema },
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
      <PurelymailSetupGuidance />
      <FieldGroup>
        <form.AppField
          name='name'
          children={(field) => (
            <field.TextField
              label='Account name'
              required
              placeholder='Main Purelymail account'
              description='How this account is labelled inside Loxep.'
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
          <form.SubmitButton>Connect account</form.SubmitButton>
        </form.AppForm>
      </div>
    </form>
  );
}

const tailscaleAccountSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  tailnet: z.string().trim(),
  apiAccessToken: z.string().trim().min(1, 'API access token is required'),
  economicEntityId: z.string()
});

/**
 * Tailscale (loxep-4su): a personal API access token, the simplest of the
 * two documented auth modes (an OAuth client is the better fit for
 * unattended long-lived polling and is a follow-up — see the adapter
 * package). Verified against
 * https://tailscale.com/docs/reference/tailscale-api and
 * https://tailscale.com/docs/features/oauth-clients, 2026-08-13.
 */
function TailscaleSetupGuidance() {
  return (
    <SetupGuidance>
      <GuidanceSteps>
        <GuidanceStep>
          Sign in to the Tailscale admin console as an Owner, Admin, IT admin, or Network admin of
          the tailnet.
        </GuidanceStep>
        <GuidanceStep>
          Open the <strong>Keys</strong> page and generate a new API access token.
          <GuidanceNote>
            Choose an expiry of up to 90 days — Tailscale does not offer a longer or auto-renewing
            option for this credential.
          </GuidanceNote>
        </GuidanceStep>
        <GuidanceStep>
          Copy the token before leaving the page; Tailscale will not show it again.
        </GuidanceStep>
      </GuidanceSteps>
      <GuidanceCallout>
        <p>
          This token <strong>expires</strong> on the schedule you chose — there is no auto-renewal.
          When it does, Loxep reports the connection as unable to authenticate; come back here and
          paste a freshly generated token.
        </p>
        <p>
          Leave the tailnet field blank to use <code>-</code>, Tailscale&apos;s shorthand for
          &ldquo;the default tailnet of this token&rdquo; — the right choice unless the account
          belongs to more than one tailnet.
        </p>
      </GuidanceCallout>
    </SetupGuidance>
  );
}

function TailscaleAccountForm({
  entities,
  onDone
}: {
  entities: EntityDto[];
  onDone: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof tailscaleAccountSchema>) =>
      createStoreConnection({
        data: {
          service: 'tailscale',
          name: values.name,
          apiAccessToken: values.apiAccessToken,
          ...(values.tailnet === '' ? {} : { tailnet: values.tailnet }),
          economicEntityId: entityIdFrom(values.economicEntityId)
        }
      }),
    onSuccess: () => {
      toast.success('Tailscale tailnet connected');
      queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
      onDone(false);
    },
    onError: (error) => toastError(error, 'Failed to connect the tailnet')
  });

  const form = useAppForm({
    defaultValues: {
      name: '',
      tailnet: '',
      apiAccessToken: '',
      economicEntityId: NO_ENTITY_VALUE
    },
    validators: { onSubmit: tailscaleAccountSchema },
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
      <TailscaleSetupGuidance />
      <FieldGroup>
        <form.AppField
          name='name'
          children={(field) => (
            <field.TextField
              label='Tailnet name'
              required
              placeholder='Main tailnet'
              description='How this tailnet is labelled inside Loxep.'
            />
          )}
        />
        <form.AppField
          name='tailnet'
          children={(field) => (
            <field.TextField
              label='Tailnet'
              placeholder='- (default tailnet of the token)'
              description='Non-secret; kept as ordinary connection configuration. Leave blank for “-”.'
            />
          )}
        />
        <form.AppField
          name='apiAccessToken'
          children={(field) => (
            <field.TextField
              label='API access token'
              required
              type='password'
              autoComplete='new-password'
              description='Write-only: stored encrypted, never displayed again. Expires on the schedule chosen when it was generated.'
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
          <form.SubmitButton>Connect tailnet</form.SubmitButton>
        </form.AppForm>
      </div>
    </form>
  );
}

const termixAccountSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  baseUrl: z.url(),
  username: z.string().trim().min(1, 'Username is required'),
  password: z.string().trim().min(1, 'Password is required'),
  economicEntityId: z.string()
});

/**
 * Termix (loxep-g3f): an ordinary username/password login — Termix issues
 * no scoped read-only token. Verified against its published OpenAPI
 * document (`Termix-SSH/Docs`), 2026-08-13.
 */
function TermixSetupGuidance() {
  return (
    <SetupGuidance>
      <GuidanceSteps>
        <GuidanceStep>
          Note the URL of your Termix instance&apos;s front door — the single reverse-proxied origin
          you sign in to, not one of its internal service ports.
        </GuidanceStep>
        <GuidanceStep>
          Decide which Termix user account Loxep should sign in as.
          <GuidanceNote>
            Termix does not publish a scoped read-only role. Loxep only ever calls its host-list,
            host-status, session-list, and identity endpoints — never a terminal, Docker, or file
            action — but that restraint is enforced in Loxep&apos;s own code, not by anything this
            account&apos;s permissions withhold. Use an account you are comfortable with in that
            light.
          </GuidanceNote>
        </GuidanceStep>
      </GuidanceSteps>
      <GuidanceCallout>
        <p>
          The password is write-only: stored encrypted, never displayed again. Loxep exchanges it
          for a short-lived session token on each poll and does not store the token.
        </p>
      </GuidanceCallout>
    </SetupGuidance>
  );
}

function TermixAccountForm({
  entities,
  onDone
}: {
  entities: EntityDto[];
  onDone: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof termixAccountSchema>) =>
      createStoreConnection({
        data: {
          service: 'termix',
          name: values.name,
          baseUrl: values.baseUrl,
          username: values.username,
          password: values.password,
          economicEntityId: entityIdFrom(values.economicEntityId)
        }
      }),
    onSuccess: () => {
      toast.success('Termix instance connected');
      queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
      onDone(false);
    },
    onError: (error) => toastError(error, 'Failed to connect the instance')
  });

  const form = useAppForm({
    defaultValues: {
      name: '',
      baseUrl: '',
      username: '',
      password: '',
      economicEntityId: NO_ENTITY_VALUE
    },
    validators: { onSubmit: termixAccountSchema },
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
      <TermixSetupGuidance />
      <FieldGroup>
        <form.AppField
          name='name'
          children={(field) => (
            <field.TextField
              label='Instance name'
              required
              placeholder='Home lab Termix'
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
              placeholder='https://termix.example.com'
              description='The single reverse-proxied front door for this instance.'
            />
          )}
        />
        <form.AppField
          name='username'
          children={(field) => <field.TextField label='Username' required />}
        />
        <form.AppField
          name='password'
          children={(field) => (
            <field.TextField
              label='Password'
              required
              type='password'
              autoComplete='new-password'
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
          <form.SubmitButton>Connect instance</form.SubmitButton>
        </form.AppForm>
      </div>
    </form>
  );
}
