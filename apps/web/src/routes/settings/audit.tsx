import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import AuditTable from '@/features/settings/components/audit-table';
import { SettingsPage } from '@/features/settings/components/settings-page';

/**
 * `page`/`perPage`/`sort` mirror `useDataTable`'s own reserved keys
 * (`orders.index.tsx`'s convention); `actorUserId`/`action`/`resourceType`/
 * `occurredAt` are the audit table's own filters, declared here so
 * `validateSearch` doesn't strip them off the URL (loxep-161).
 */
const auditSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(25),
  sort: z.string().optional(),
  actorUserId: z.string().optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  occurredAt: z.string().optional()
});

export const Route = createFileRoute('/settings/audit')({
  validateSearch: zodValidator(auditSearchSchema),
  component: SettingsAudit
});

function SettingsAudit() {
  return (
    <SettingsPage
      title='Audit log'
      description='Every configuration change — settings, connections, secrets, entities, and more — with who changed it and what it was before.'
    >
      <AuditTable />
    </SettingsPage>
  );
}
