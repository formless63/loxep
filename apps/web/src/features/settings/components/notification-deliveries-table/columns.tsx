import type { Column, ColumnDef } from '@tanstack/react-table';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatQuantity, formatTimestampPrecise } from '@/lib/format';
import { ToneBadge, type Tone } from '@/features/settings/components/status-tone';
import {
  DELIVERY_STATUS_LABELS,
  deliveryStatusLabel,
  notificationEventClassLabel,
  notificationEventTypeLabel
} from '@/features/settings/constants';
import type { DeliveryStatus } from '@loxep/notifications';
import type { NotificationDeliveryDto } from '@/server/admin-functions';

/** `pending` is in-flight, not at-risk — neutral, not warning or destructive. */
const DELIVERY_STATUS_TONE = {
  pending: 'outline',
  delivered: 'success',
  failed: 'destructive'
} as const satisfies Record<DeliveryStatus, Tone>;

const STATUS_OPTIONS = (Object.keys(DELIVERY_STATUS_LABELS) as DeliveryStatus[]).map((value) => ({
  value,
  label: DELIVERY_STATUS_LABELS[value]
}));

export const columns: ColumnDef<DataTableFeatures, NotificationDeliveryDto>[] = [
  {
    id: 'eventClass',
    accessorKey: 'eventClass',
    header: 'Class',
    cell: ({ cell }) => (
      <span className='text-muted-foreground'>
        {notificationEventClassLabel(cell.getValue<string>())}
      </span>
    )
  },
  {
    id: 'eventType',
    accessorKey: 'eventType',
    header: ({
      column
    }: {
      column: Column<DataTableFeatures, NotificationDeliveryDto, unknown>;
    }) => <DataTableColumnHeader column={column} title='Event type' />,
    cell: ({ cell }) => notificationEventTypeLabel(cell.getValue<string>())
  },
  {
    id: 'endpointName',
    accessorKey: 'endpointName',
    header: 'Endpoint',
    cell: ({ cell }) => <span className='text-muted-foreground'>{cell.getValue<string>()}</span>,
    meta: {
      label: 'Endpoint',
      placeholder: 'Search endpoint...',
      variant: 'text' as const,
      icon: Icons.text
    },
    enableColumnFilter: true
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: ({
      column
    }: {
      column: Column<DataTableFeatures, NotificationDeliveryDto, unknown>;
    }) => <DataTableColumnHeader column={column} title='Status' />,
    cell: ({ cell }) => {
      const status = cell.getValue<DeliveryStatus>();
      return (
        <ToneBadge tone={DELIVERY_STATUS_TONE[status]}>{deliveryStatusLabel(status)}</ToneBadge>
      );
    },
    enableColumnFilter: true,
    meta: { label: 'status', variant: 'multiSelect' as const, options: STATUS_OPTIONS }
  },
  {
    id: 'attemptCount',
    accessorKey: 'attemptCount',
    header: ({
      column
    }: {
      column: Column<DataTableFeatures, NotificationDeliveryDto, unknown>;
    }) => <DataTableColumnHeader column={column} title='Attempts' />,
    cell: ({ cell }) => (
      <div className='text-right tabular-nums'>{formatQuantity(cell.getValue<number>())}</div>
    )
  },
  {
    id: 'lastError',
    header: 'Last error',
    cell: ({ row }) => (
      <span className='text-destructive max-w-xs truncate'>{row.original.lastError ?? '—'}</span>
    )
  },
  {
    id: 'deliveredAt',
    accessorKey: 'deliveredAt',
    header: ({
      column
    }: {
      column: Column<DataTableFeatures, NotificationDeliveryDto, unknown>;
    }) => <DataTableColumnHeader column={column} title='Delivered at' />,
    cell: ({ cell }) => (
      <span className='text-muted-foreground'>
        {formatTimestampPrecise(cell.getValue<string | null>())}
      </span>
    )
  }
];
