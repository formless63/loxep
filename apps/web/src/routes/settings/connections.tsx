import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { toast } from 'sonner';
import ConnectionsTable from '@/features/settings/components/connections-table';
import { SettingsPage } from '@/features/settings/components/settings-page';

/**
 * `?ebay=<status>&connection=<id>` — the query params
 * `handleEbayConsentCallback` (`@/server/ebay-oauth`) redirects back to after
 * the eBay consent screen. Read once, surfaced as a toast, then stripped from
 * the URL so a refresh doesn't re-show it. `?etsy=<status>` is the same
 * shape for `handleEtsyConsentCallback` (`@/server/etsy-oauth-callback`).
 */
const connectionsSearchSchema = z.object({
  ebay: z.enum(['connected', 'declined', 'failed']).optional(),
  etsy: z.enum(['connected', 'declined', 'failed']).optional(),
  connection: z.string().optional()
});

export const Route = createFileRoute('/settings/connections')({
  validateSearch: zodValidator(connectionsSearchSchema),
  component: SettingsConnections
});

const EBAY_CALLBACK_MESSAGES = {
  connected: { ok: true, message: 'eBay account connected.' },
  declined: { ok: false, message: 'eBay consent was declined — no account was connected.' },
  failed: {
    ok: false,
    message: 'eBay connection failed. Check the connection row for the recorded error.'
  }
} as const;

const ETSY_CALLBACK_MESSAGES = {
  connected: { ok: true, message: 'Etsy shop connected.' },
  declined: { ok: false, message: 'Etsy consent was declined — no shop was connected.' },
  failed: {
    ok: false,
    message: 'Etsy connection failed. Check the connection row for the recorded error.'
  }
} as const;

function SettingsConnections() {
  const { auth } = Route.useRouteContext();
  const isAdmin = auth?.roles.includes('admin') ?? false;
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  React.useEffect(() => {
    if (search.ebay === undefined) return;
    const outcome = EBAY_CALLBACK_MESSAGES[search.ebay];
    if (outcome.ok) toast.success(outcome.message);
    else toast.error(outcome.message);
    navigate({ search: {}, replace: true });
  }, [search.ebay, navigate]);

  React.useEffect(() => {
    if (search.etsy === undefined) return;
    const outcome = ETSY_CALLBACK_MESSAGES[search.etsy];
    if (outcome.ok) toast.success(outcome.message);
    else toast.error(outcome.message);
    navigate({ search: {}, replace: true });
  }, [search.etsy, navigate]);

  return (
    <SettingsPage
      title='Connections'
      description='The accounts, stores, and services this installation is connected to, grouped by service.'
    >
      <ConnectionsTable isAdmin={isAdmin} />
    </SettingsPage>
  );
}
