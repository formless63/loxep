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
        ) : accounts.form === 'termix-api' ? (
          <TermixAccountForm entities={entities} onDone={onOpenChange} />
        ) : accounts.form === 'gatus-api' ? (
          <GatusAccountForm entities={entities} onDone={onOpenChange} />
        ) : accounts.form === 'beszel-login' ? (
          <BeszelAccountForm entities={entities} onDone={onOpenChange} />
        ) : (
          <DockhandAccountForm entities={entities} onDone={onOpenChange} />
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

const TAILSCALE_CREDENTIAL_MODES = ['oauth_client', 'api_access_token'] as const;
type TailscaleCredentialMode = (typeof TAILSCALE_CREDENTIAL_MODES)[number];

const TAILSCALE_MODE_OPTIONS: { value: TailscaleCredentialMode; label: string }[] = [
  {
    value: 'oauth_client',
    label: 'OAuth client — recommended. Does not expire; Loxep renews it hourly on its own.'
  },
  {
    value: 'api_access_token',
    label: 'API access token — expires in at most 90 days, with no renewal.'
  }
];

const tailscaleAccountSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required'),
    tailnet: z.string().trim(),
    mode: z.enum(TAILSCALE_CREDENTIAL_MODES),
    clientId: z.string().trim(),
    clientSecret: z.string().trim(),
    apiAccessToken: z.string().trim(),
    // `.or(z.undefined())` rather than `.optional()`: the latter makes the
    // KEY optional in the inferred type, which mismatches `useAppForm`'s
    // `defaultValues` (a required key whose VALUE is `Date | undefined`, the
    // shape `DatePickerField`'s `useFieldContext<Date | undefined>()` wants).
    expiresOn: z.date().or(z.undefined()),
    economicEntityId: z.string()
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'oauth_client') {
      if (value.clientId === '') {
        ctx.addIssue({
          code: 'custom',
          path: ['clientId'],
          message: 'OAuth client id is required'
        });
      }
      if (value.clientSecret === '') {
        ctx.addIssue({
          code: 'custom',
          path: ['clientSecret'],
          message: 'OAuth client secret is required'
        });
      }
    } else if (value.apiAccessToken === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['apiAccessToken'],
        message: 'API access token is required'
      });
    }
  });

/** `Date` from the picker → `YYYY-MM-DD` in the browser's own local calendar, not UTC. */
function toDateOnlyString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Tailscale (loxep-4su, extended by loxep-50t §2.2): two documented
 * credential modes, verified against
 * https://tailscale.com/docs/reference/tailscale-api and
 * https://tailscale.com/docs/features/oauth-clients, 2026-08-13. The OAuth
 * client is the DEFAULT and RECOMMENDED branch — it never expires because
 * Loxep re-exchanges the short-lived minted token automatically — because
 * shipping only the API-access-token branch (as this form did before
 * loxep-50t) makes an unattended credential that WILL silently die the only
 * option.
 */
function TailscaleSetupGuidance({ mode }: { mode: TailscaleCredentialMode }) {
  return (
    <SetupGuidance>
      {mode === 'oauth_client' ? (
        <>
          <GuidanceSteps>
            <GuidanceStep>
              Sign in to the Tailscale admin console as an Owner, Admin, IT admin, or Network admin
              of the tailnet.
            </GuidanceStep>
            <GuidanceStep>
              Open <strong>Settings</strong> → <strong>OAuth clients</strong> and generate a new
              client.
            </GuidanceStep>
            <GuidanceStep>
              Grant it exactly the <code className='font-mono'>devices:core:read</code> scope.
              <GuidanceNote>
                <code className='font-mono'>devices:core</code> without the{' '}
                <code className='font-mono'>read</code> suffix also grants write access.
                Loxep&apos;s read-only-ness is enforced in its own adapter code, not by this scope —
                but the narrower scope is still the right default, and there is no reason to grant
                more.
              </GuidanceNote>
            </GuidanceStep>
            <GuidanceStep>
              Copy the client ID and client secret into the fields below; Tailscale shows the secret
              once.
            </GuidanceStep>
          </GuidanceSteps>
          <GuidanceCallout>
            <p>
              An OAuth client&apos;s minted access token lives one hour; Loxep re-exchanges it
              automatically on every poll, so there is nothing to renew by hand and nothing that
              silently expires.
            </p>
            <p>
              Leave the tailnet field blank to use <code>-</code>, Tailscale&apos;s shorthand for
              &ldquo;the default tailnet of this credential&rdquo; — the right choice unless the
              account belongs to more than one tailnet.
            </p>
          </GuidanceCallout>
        </>
      ) : (
        <>
          <GuidanceSteps>
            <GuidanceStep>
              Sign in to the Tailscale admin console as an Owner, Admin, IT admin, or Network admin
              of the tailnet.
            </GuidanceStep>
            <GuidanceStep>
              Open the <strong>Keys</strong> page and generate a new API access token.
              <GuidanceNote>
                Choose an expiry of up to 90 days — Tailscale does not offer a longer or
                auto-renewing option for this credential, which is exactly why the OAuth client
                branch above is the recommended default.
              </GuidanceNote>
            </GuidanceStep>
            <GuidanceStep>
              Copy the token before leaving the page; Tailscale will not show it again.
            </GuidanceStep>
          </GuidanceSteps>
          <GuidanceCallout>
            <p>
              This token <strong>expires</strong> on the schedule you chose — there is no
              auto-renewal. When it does, Loxep reports the connection as unable to authenticate;
              come back here and paste a freshly generated token.
            </p>
            <p>
              Leave the tailnet field blank to use <code>-</code>, Tailscale&apos;s shorthand for
              &ldquo;the default tailnet of this token&rdquo; — the right choice unless the account
              belongs to more than one tailnet.
            </p>
          </GuidanceCallout>
        </>
      )}
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
    mutationFn: (values: z.infer<typeof tailscaleAccountSchema>) => {
      const tailnet = values.tailnet === '' ? {} : { tailnet: values.tailnet };
      const economicEntityId = entityIdFrom(values.economicEntityId);
      return values.mode === 'oauth_client'
        ? createStoreConnection({
            data: {
              service: 'tailscale',
              mode: 'oauth_client',
              name: values.name,
              ...tailnet,
              clientId: values.clientId,
              clientSecret: values.clientSecret,
              economicEntityId
            }
          })
        : createStoreConnection({
            data: {
              service: 'tailscale',
              mode: 'api_access_token',
              name: values.name,
              ...tailnet,
              apiAccessToken: values.apiAccessToken,
              ...(values.expiresOn === undefined
                ? {}
                : { credentialExpiresAt: toDateOnlyString(values.expiresOn) }),
              economicEntityId
            }
          });
    },
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
      mode: 'oauth_client' as TailscaleCredentialMode,
      clientId: '',
      clientSecret: '',
      apiAccessToken: '',
      expiresOn: undefined as Date | undefined,
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
      <form.Subscribe selector={(state) => state.values.mode}>
        {(mode) => <TailscaleSetupGuidance mode={mode} />}
      </form.Subscribe>
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
              placeholder='- (default tailnet of the credential)'
              description='Non-secret; kept as ordinary connection configuration. Leave blank for “-”.'
            />
          )}
        />
        <form.AppField
          name='mode'
          children={(field) => (
            <field.RadioGroupField
              label='Credential type'
              required
              options={TAILSCALE_MODE_OPTIONS}
            />
          )}
        />
        <form.Subscribe selector={(state) => state.values.mode}>
          {(mode) =>
            mode === 'oauth_client' ? (
              <>
                <form.AppField
                  name='clientId'
                  children={(field) => (
                    <field.TextField
                      label='OAuth client ID'
                      required
                      autoComplete='off'
                      description='Write-only: stored encrypted, never displayed again.'
                    />
                  )}
                />
                <form.AppField
                  name='clientSecret'
                  children={(field) => (
                    <field.TextField
                      label='OAuth client secret'
                      required
                      type='password'
                      autoComplete='new-password'
                      description='Write-only: stored encrypted, never displayed again.'
                    />
                  )}
                />
              </>
            ) : (
              <>
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
                  name='expiresOn'
                  children={(field) => (
                    <field.DatePickerField
                      label='Recorded expiry (optional)'
                      description="Tailscale showed an expiry when you generated this token. Record it and Loxep will warn you before it dies. Leave blank if you don't know."
                    />
                  )}
                />
              </>
            )
          }
        </form.Subscribe>
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

const gatusAccountSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required'),
    baseUrl: z.url(),
    username: z.string().trim(),
    password: z.string().trim(),
    economicEntityId: z.string()
  })
  .refine((value) => (value.username === '') === (value.password === ''), {
    message: 'Provide both username and password, or leave both blank',
    path: ['password']
  });

/**
 * Gatus (Phase 8 milestone 4, loxep-ovj.4): unlike every other self-hosted
 * fleet companion here, the credential pair is OPTIONAL. Verified against
 * `github.com/TwiN/gatus` v5.36.0's own Go source (gatus.io/docs is a
 * client-rendered SPA and unusable as a reference) — `api/api.go` only ever
 * attaches auth middleware to the protected route group when a `security`
 * block exists, so an instance with none configured is fully open, and
 * `security/oidc.go` gives OIDC no server-to-server bearer path at all
 * (session cookie only). Loxep probes which of the three states applies at
 * read time and always shows which one it is in — see
 * `packages/integrations/gatus/src/adapter.ts`.
 */
function GatusSetupGuidance() {
  return (
    <SetupGuidance title='Basic auth, OIDC, or nothing at all'>
      <GuidanceSteps>
        <GuidanceStep>
          If your Gatus instance&apos;s YAML has a <code className='font-mono'>security.basic</code>{' '}
          block, use that username and the matching password below — Loxep sends it as an ordinary
          Basic auth header on every read.
        </GuidanceStep>
        <GuidanceStep>
          If it has no <code className='font-mono'>security</code> block at all, its read API is
          fully open. Leave both fields blank.
        </GuidanceStep>
        <GuidanceStep>
          If it has a <code className='font-mono'>security.oidc</code> block, leave both fields
          blank too — OIDC only ever grants a browser session cookie, and there is no credential
          Loxep could hold for it.
        </GuidanceStep>
      </GuidanceSteps>
      <GuidanceCallout>
        <p>
          Loxep probes the instance&apos;s own unauthenticated{' '}
          <code className='font-mono'>/api/v1/config</code> endpoint on every read to find out which
          of the three applies. Against an OIDC-secured instance it automatically falls back to
          Gatus&apos;s unauthenticated per-endpoint routes rather than failing outright — and the
          connection always shows which mode it is reading in, never a silently partial view.
        </p>
        <p>
          Password is write-only: stored encrypted, never displayed again. Leaving both fields blank
          is a normal, supported state — not every Gatus instance needs a credential at all.
        </p>
      </GuidanceCallout>
    </SetupGuidance>
  );
}

function GatusAccountForm({
  entities,
  onDone
}: {
  entities: EntityDto[];
  onDone: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof gatusAccountSchema>) =>
      createStoreConnection({
        data: {
          service: 'gatus',
          name: values.name,
          baseUrl: values.baseUrl,
          ...(values.username === '' ? {} : { username: values.username }),
          ...(values.password === '' ? {} : { password: values.password }),
          economicEntityId: entityIdFrom(values.economicEntityId)
        }
      }),
    onSuccess: () => {
      toast.success('Gatus instance connected');
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
    validators: { onSubmit: gatusAccountSchema },
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
      <GatusSetupGuidance />
      <FieldGroup>
        <form.AppField
          name='name'
          children={(field) => (
            <field.TextField
              label='Instance name'
              required
              placeholder='Main Gatus instance'
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
              placeholder='https://status.example.com'
              description='The instance root, including https:// and the port if non-standard.'
            />
          )}
        />
        <form.AppField
          name='username'
          children={(field) => (
            <field.TextField
              label='Username'
              placeholder='Optional — Basic auth only'
              description='Leave blank if this Gatus instance has no security configured, or uses OIDC.'
            />
          )}
        />
        <form.AppField
          name='password'
          children={(field) => (
            <field.TextField
              label='Password'
              type='password'
              autoComplete='new-password'
              placeholder='Optional — Basic auth only'
              description='Write-only: stored encrypted, never displayed again. Provide together with username, or leave both blank.'
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

const beszelAccountSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  baseUrl: z.url(),
  email: z.string().trim().min(1, 'Email is required'),
  password: z.string().trim().min(1, 'Password is required'),
  economicEntityId: z.string()
});

/**
 * Beszel (loxep-rf4 scope (b), loxep-y64 §7 slice 1): a dedicated READONLY
 * user, not an API token — Beszel issues none. Verified against upstream's
 * own documentation of the `users` collection's roles
 * (`beszel_credentials` in `@loxep/domain` records the full citation): the
 * lowest role can view only the systems an admin has shared with it and
 * cannot create or delete systems. This form must never describe the
 * credential as a token of any kind — see that bundle doc for the
 * correction this label exists to make.
 */
function BeszelSetupGuidance() {
  return (
    <SetupGuidance title='Beszel readonly user'>
      <GuidanceSteps>
        <GuidanceStep>Sign in to the Beszel hub as an admin or superuser.</GuidanceStep>
        <GuidanceStep>
          In the hub&apos;s Users collection, create a new user and give it its own email — a
          dedicated account, not the one you sign in with day to day.
        </GuidanceStep>
        <GuidanceStep>
          Set its role to the lowest one Beszel offers for the Users collection.
          <GuidanceNote>
            That role can view any system an admin has shared with it, but cannot create or delete
            systems. It is deliberately not the admin or superuser role.
          </GuidanceNote>
        </GuidanceStep>
        <GuidanceStep>
          Share the systems this account should observe with it — or share all of them, if that is
          the intent — then enter its email and password below.
        </GuidanceStep>
      </GuidanceSteps>
      <GuidanceCallout>
        <p>
          Beszel issues no scoped key of any kind for this purpose; the readonly login itself is the
          whole credential, exchanged for a short-lived session on every read. The password is
          write-only here: stored encrypted, never displayed again.
        </p>
      </GuidanceCallout>
    </SetupGuidance>
  );
}

function BeszelAccountForm({
  entities,
  onDone
}: {
  entities: EntityDto[];
  onDone: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof beszelAccountSchema>) =>
      createStoreConnection({
        data: {
          service: 'beszel',
          name: values.name,
          baseUrl: values.baseUrl,
          email: values.email,
          password: values.password,
          economicEntityId: entityIdFrom(values.economicEntityId)
        }
      }),
    onSuccess: () => {
      toast.success('Beszel hub connected');
      queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
      onDone(false);
    },
    onError: (error) => toastError(error, 'Failed to connect the hub')
  });

  const form = useAppForm({
    defaultValues: {
      name: '',
      baseUrl: '',
      email: '',
      password: '',
      economicEntityId: NO_ENTITY_VALUE
    },
    validators: { onSubmit: beszelAccountSchema },
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
      <BeszelSetupGuidance />
      <FieldGroup>
        <form.AppField
          name='name'
          children={(field) => (
            <field.TextField
              label='Hub name'
              required
              placeholder='Main Beszel hub'
              description='How this hub is labelled inside Loxep.'
            />
          )}
        />
        <form.AppField
          name='baseUrl'
          children={(field) => (
            <field.TextField
              label='Hub base URL'
              required
              placeholder='https://beszel.example.com'
              description='The hub root, including https:// and the port if non-standard.'
            />
          )}
        />
        <form.AppField
          name='email'
          children={(field) => (
            <field.TextField
              label='Email'
              required
              type='email'
              autoComplete='off'
              description='The dedicated Beszel readonly user’s email.'
            />
          )}
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
          <form.SubmitButton>Connect hub</form.SubmitButton>
        </form.AppForm>
      </div>
    </form>
  );
}

const dockhandAccountSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  baseUrl: z.url(),
  username: z.string().trim().min(1, 'Username is required'),
  password: z.string().trim().min(1, 'Password is required'),
  economicEntityId: z.string()
});

/**
 * Dockhand (loxep-rf4 scope (b), loxep-hb7 §1.7): an ordinary session login
 * — Dockhand's published API reference documents exactly one machine-usable
 * authentication mode, an HTTP-only session cookie from `POST
 * /api/auth/login`, and no API key or personal access token anywhere
 * (`dockhand_credentials` in `@loxep/domain` records the full citation).
 * This form must say "Dockhand username and password", never describe the
 * credential as a token of any kind.
 */
function DockhandSetupGuidance() {
  return (
    <SetupGuidance title='Dockhand username and password'>
      <GuidanceSteps>
        <GuidanceStep>Sign in to the Dockhand instance as an admin.</GuidanceStep>
        <GuidanceStep>
          Create a new user for Loxep to sign in as — not the admin account you use yourself.
        </GuidanceStep>
        <GuidanceStep>
          Grant it exactly these four permissions:{' '}
          <code className='font-mono'>environments:view</code>,{' '}
          <code className='font-mono'>environments:edit</code>,{' '}
          <code className='font-mono'>containers:view</code>, and{' '}
          <code className='font-mono'>stacks:view</code>.
          <GuidanceNote>
            The same session that can read a container list can, at Dockhand&apos;s own API, start
            and stop containers. Loxep never does — that restraint is enforced in Loxep&apos;s own
            adapter code, not by anything this account&apos;s permissions withhold — but a
            dedicated, narrowly-permissioned account is still the right account to hand over.
          </GuidanceNote>
        </GuidanceStep>
        <GuidanceStep>Enter that account&apos;s username and password below.</GuidanceStep>
      </GuidanceSteps>
      <GuidanceCallout>
        <p>
          Dockhand issues no scoped key of any kind — this login is the whole credential. The
          password is write-only here: stored encrypted, never displayed again, and re-exchanged for
          a session on each poll.
        </p>
      </GuidanceCallout>
    </SetupGuidance>
  );
}

function DockhandAccountForm({
  entities,
  onDone
}: {
  entities: EntityDto[];
  onDone: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof dockhandAccountSchema>) =>
      createStoreConnection({
        data: {
          service: 'dockhand',
          name: values.name,
          baseUrl: values.baseUrl,
          username: values.username,
          password: values.password,
          economicEntityId: entityIdFrom(values.economicEntityId)
        }
      }),
    onSuccess: () => {
      toast.success('Dockhand instance connected');
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
    validators: { onSubmit: dockhandAccountSchema },
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
      <DockhandSetupGuidance />
      <FieldGroup>
        <form.AppField
          name='name'
          children={(field) => (
            <field.TextField
              label='Instance name'
              required
              placeholder='Main Dockhand instance'
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
              placeholder='https://dockhand.example.com'
              description='The instance root, including https:// and the port if non-standard. A pasted API URL is normalized automatically.'
            />
          )}
        />
        <form.AppField
          name='username'
          children={(field) => <field.TextField label='Username' required autoComplete='off' />}
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
