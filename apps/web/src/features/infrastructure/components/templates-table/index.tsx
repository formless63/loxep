import * as React from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { DataTableToolbar } from '@/components/ui/table/data-table-toolbar';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import { useDataTable } from '@/hooks/use-data-table';
import { toastError } from '@/lib/errors';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { provisioningTemplatesQuery } from '@/features/infrastructure/api/queries';
import { createProvisioningTemplateFromExample } from '@/server/provisioning-functions';
import type { ProvisioningTemplateDto } from '@/server/provisioning-functions';
import { getColumns } from './columns';

const CLIENT_COLUMNS: ClientColumnSpec<ProvisioningTemplateDto>[] = [
  { id: 'name', accessor: (row) => row.name, filterVariant: 'text' }
];

/**
 * The "create from example" affordance — the design's own open question 10,
 * resolved exactly like `mailbox_templates`: SHIP NO SEEDED ROW. This button
 * creates the 'new domain' template on an admin's explicit click instead.
 */
function CreateFromExampleButton() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => createProvisioningTemplateFromExample(),
    onSuccess: async (result) => {
      toast.success('"New domain" template created');
      await queryClient.invalidateQueries({ queryKey: provisioningTemplatesQuery.queryKey });
      await navigate({ to: '/infrastructure/templates/$id', params: { id: result.id } });
    },
    onError: (error) => toastError(error, 'Could not create the example template')
  });

  return (
    <Button
      size='sm'
      variant='outline'
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      <Icons.sparkles />
      Create from example
    </Button>
  );
}

export default function TemplatesTable() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;

  const { data, isPending, isError, error, refetch } = useQuery(provisioningTemplatesQuery);
  const columns = React.useMemo(() => getColumns(), []);
  const action = <CreateFromExampleButton />;

  if (isPending) {
    return <DataTableSkeleton columnCount={columns.length} filterCount={1} />;
  }
  if (isError) {
    return (
      <QueryErrorAlert error={error} title='Failed to load templates' onRetry={() => refetch()} />
    );
  }
  if (data.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.integrations />
          </EmptyMedia>
          <EmptyTitle>No provisioning templates yet</EmptyTitle>
          <EmptyDescription>
            A template is a strictly ordered list of idempotent steps — declare a domain, point DNS
            at a target, ensure a Pangolin resource and its rules, enable mail, ensure a mailbox.
            Create one from the &ldquo;New domain&rdquo; example, or build your own.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>{action}</EmptyContent>
      </Empty>
    );
  }

  const { rows, pageCount } = applyClientTableState(data, CLIENT_COLUMNS, search, page, perPage);
  return <TemplatesDataTable rows={rows} pageCount={pageCount} columns={columns} action={action} />;
}

function TemplatesDataTable({
  rows,
  pageCount,
  columns,
  action
}: {
  rows: ProvisioningTemplateDto[];
  pageCount: number;
  columns: ReturnType<typeof getColumns>;
  action: React.ReactNode;
}) {
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    getRowId: (template) => template.id,
    shallow: true,
    debounceMs: 500
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table}>{action}</DataTableToolbar>
    </DataTable>
  );
}
