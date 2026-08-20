import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle
} from '@/components/ui/responsive-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { FieldGroup, FieldLabel } from '@/components/ui/field';
import { StackedStatusBar } from '@/components/ui/stacked-status-bar';
import { Icons } from '@/components/icons';
import { formatDateTime, formatQuantity } from '@/lib/format';
import {
  storageBackendOptionsQuery,
  storageMigrationsQuery,
  storageMigrationStatusQuery
} from '@/features/settings/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { STORAGE_DRIVER_LABELS } from '@/features/settings/constants';
import type { StorageDriverFamily } from '@loxep/storage';
import {
  cleanupStorageMigrationSources,
  resumeStorageMigration,
  startStorageMigration
} from '@/server/storage-migration-functions';

function backendLabel(
  backends: { id: string; name: string; driver: string }[] | undefined,
  id: string
): string {
  const backend = backends?.find((candidate) => candidate.id === id);
  if (!backend) return id;
  const driverLabel =
    STORAGE_DRIVER_LABELS[backend.driver as StorageDriverFamily] ?? backend.driver;
  return `${backend.name} (${driverLabel})`;
}

const MIGRATION_STATUS_TONE = {
  running: 'warning',
  completed: 'success',
  completed_with_errors: 'destructive'
} as const;

function migrationStatusTone(status: string) {
  return MIGRATION_STATUS_TONE[status as keyof typeof MIGRATION_STATUS_TONE] ?? 'outline';
}

/** The `/settings/storage` create-migration dialog — source/destination backend pickers. */
function StartMigrationDialog({
  open,
  onOpenChange,
  onStarted
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (migrationId: string) => void;
}) {
  const { data: backends } = useQuery({ ...storageBackendOptionsQuery, enabled: open });
  const queryClient = useQueryClient();
  const [sourceBackendId, setSourceBackendId] = React.useState<string | undefined>(undefined);
  const [destinationBackendId, setDestinationBackendId] = React.useState<string | undefined>(
    undefined
  );

  const mutation = useMutation({
    mutationFn: () => {
      if (!sourceBackendId || !destinationBackendId) {
        throw new Error('Choose a source and a destination backend');
      }
      return startStorageMigration({ data: { sourceBackendId, destinationBackendId } });
    },
    onSuccess: (result) => {
      toast.success('Migration started');
      void queryClient.invalidateQueries({ queryKey: storageMigrationsQuery.queryKey });
      onStarted(result.id);
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to start migration');
    }
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='sm:max-w-[440px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Migrate objects</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Every object on the source backend is copied, verified byte-for-byte (sha256), and cut
            over — one job per object, resumable if the worker stops mid-run. Source objects are
            never deleted here; cleanup is a separate, later step once the migration completes.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className='space-y-6'>
          <FieldGroup>
            <div>
              <FieldLabel>Source backend</FieldLabel>
              <Select value={sourceBackendId} onValueChange={setSourceBackendId}>
                <SelectTrigger className='w-full'>
                  <SelectValue placeholder='Choose a source' />
                </SelectTrigger>
                <SelectContent>
                  {(backends ?? []).map((backend) => (
                    <SelectItem key={backend.id} value={backend.id}>
                      {backendLabel(backends, backend.id)}
                      {backend.isDefault ? ' — default' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <FieldLabel>Destination backend</FieldLabel>
              <Select value={destinationBackendId} onValueChange={setDestinationBackendId}>
                <SelectTrigger className='w-full'>
                  <SelectValue placeholder='Choose a destination' />
                </SelectTrigger>
                <SelectContent>
                  {(backends ?? [])
                    .filter((backend) => backend.id !== sourceBackendId)
                    .map((backend) => (
                      <SelectItem key={backend.id} value={backend.id}>
                        {backendLabel(backends, backend.id)}
                        {backend.isDefault ? ' — default' : ''}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type='button'
              disabled={
                mutation.isPending ||
                !sourceBackendId ||
                !destinationBackendId ||
                sourceBackendId === destinationBackendId
              }
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending && <Icons.spinner className='animate-spin' />}
              Start migration
            </Button>
          </div>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/** Live progress for one in-flight or completed migration, polled while `running`. */
function MigrationStatusCard({ migrationId }: { migrationId: string }) {
  const queryClient = useQueryClient();
  const { data: backends } = useQuery(storageBackendOptionsQuery);
  const { data, isPending } = useQuery({
    ...storageMigrationStatusQuery(migrationId),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 3000 : false)
  });

  const resumeMutation = useMutation({
    mutationFn: () => resumeStorageMigration({ data: { id: migrationId } }),
    onSuccess: (result) => {
      toast.success(
        result.enqueued === 0
          ? 'Nothing pending — every object already has a job in flight'
          : `Re-enqueued ${result.enqueued} pending object(s)`
      );
      void queryClient.invalidateQueries({
        queryKey: storageMigrationStatusQuery(migrationId).queryKey
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to resume migration');
    }
  });

  const cleanupMutation = useMutation({
    mutationFn: () => cleanupStorageMigrationSources({ data: { id: migrationId } }),
    onSuccess: (result) => {
      toast.success(
        `Cleaned up ${result.deleted} source object(s)` +
          (result.failures.length > 0 ? `, ${result.failures.length} failed` : '')
      );
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to clean up source objects');
    }
  });

  if (isPending || !data) {
    return <p className='text-muted-foreground text-sm'>Loading migration status…</p>;
  }

  const canCleanUp = data.status === 'completed' || data.status === 'completed_with_errors';

  return (
    <Card>
      <CardHeader className='flex flex-row items-start justify-between gap-2'>
        <div>
          <CardTitle className='flex items-center gap-2 text-base'>
            {backendLabel(backends, data.sourceBackendId)}
            <Icons.arrowRight className='size-3.5' />
            {backendLabel(backends, data.destinationBackendId)}
            <Badge variant={migrationStatusTone(data.status)}>
              {data.status.replaceAll('_', ' ')}
            </Badge>
          </CardTitle>
          <CardDescription>
            Started {formatDateTime(data.startedAt)}
            {data.completedAt && <> · completed {formatDateTime(data.completedAt)}</>}
          </CardDescription>
        </div>
        <div className='flex gap-2'>
          {data.counts.pending > 0 && (
            <Button
              size='sm'
              variant='outline'
              disabled={resumeMutation.isPending}
              onClick={() => resumeMutation.mutate()}
            >
              <Icons.refresh className='size-3.5' />
              Resume
            </Button>
          )}
          {canCleanUp && (
            <Button
              size='sm'
              variant='outline'
              disabled={cleanupMutation.isPending}
              onClick={() => cleanupMutation.mutate()}
            >
              <Icons.trash className='size-3.5' />
              Clean up source objects
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className='flex flex-col gap-3'>
        <StackedStatusBar
          segments={[
            { key: 'done', label: 'Done', count: data.counts.done, color: 'var(--success)' },
            {
              key: 'pending',
              label: 'Pending',
              count: data.counts.pending,
              color: 'var(--warning)'
            },
            {
              key: 'skipped',
              label: 'Skipped',
              count: data.counts.skipped,
              color: 'var(--muted-foreground)'
            },
            {
              key: 'failed',
              label: 'Failed',
              count: data.counts.failed,
              color: 'var(--destructive)'
            }
          ]}
        />
        <p className='text-muted-foreground text-sm tabular-nums'>
          {formatQuantity(data.counts.done)} done · {formatQuantity(data.counts.pending)} pending ·{' '}
          {formatQuantity(data.counts.skipped)} skipped · {formatQuantity(data.counts.failed)}{' '}
          failed
          {' · '}
          {formatQuantity(data.counts.total)} total
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Past and running migrations, newest first — `StorageMigrationService.listMigrations`
 * (added this session precisely so this panel could survive a reload,
 * loxep-4wa) via `fetchStorageMigrations`. Selecting a row loads its live
 * progress below through the existing `MigrationStatusCard`.
 */
function MigrationHistoryList({
  selectedId,
  onSelect
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { data: backends } = useQuery(storageBackendOptionsQuery);
  const { data, isPending, isError, error, refetch } = useQuery(storageMigrationsQuery);

  if (isPending) {
    return <p className='text-muted-foreground text-sm'>Loading migration history…</p>;
  }

  if (isError) {
    return (
      <QueryErrorAlert
        error={error}
        title='Could not load migration history'
        onRetry={() => refetch()}
      />
    );
  }

  if (data.length === 0) {
    return (
      <Alert>
        <Icons.info />
        <AlertTitle>No migrations yet</AlertTitle>
        <AlertDescription>
          Start one above. Every migration this installation runs is listed here, newest first, so a
          page reload never loses track of one still in flight.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className='flex flex-col gap-1'>
      {data.map((migration) => (
        <button
          key={migration.id}
          type='button'
          onClick={() => onSelect(migration.id)}
          className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground ${
            migration.id === selectedId ? 'border-primary bg-accent/50' : 'border-border'
          }`}
        >
          <span className='flex items-center gap-2'>
            {backendLabel(backends, migration.sourceBackendId)}
            <Icons.arrowRight className='size-3.5' />
            {backendLabel(backends, migration.destinationBackendId)}
          </span>
          <span className='flex items-center gap-2'>
            <span className='text-muted-foreground text-xs tabular-nums'>
              {formatQuantity(migration.counts.done)}/{formatQuantity(migration.counts.total)} done
              · {formatDateTime(migration.createdAt)}
            </span>
            <Badge variant={migrationStatusTone(migration.status)}>
              {migration.status.replaceAll('_', ' ')}
            </Badge>
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * `StorageMigrationService` (loxep-7fs, A15) — a complete, tested, resumable
 * copy→verify→cutover→cleanup workflow with zero importers before this
 * pass, and this exact spot was a placeholder Alert promising "a migration
 * UI arrives in a later phase". Registering a new backend and making it
 * default silently splits the corpus without this — the old backend can
 * never be retired otherwise (ADR-0012, ADR-0014).
 *
 * `listMigrations` (loxep-rh0) lets `MigrationHistoryList` above read every
 * past/running migration from the server, so a page reload no longer loses
 * track of one still in flight — only the ACTIVE selection (which row is
 * expanded below) is local UI state, not the migration list itself.
 */
export default function StorageMigrationPanel() {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [migrationId, setMigrationId] = React.useState<string | null>(null);
  const { data: migrations } = useQuery(storageMigrationsQuery);

  // Default the selection to the newest running migration (or, failing
  // that, the newest migration at all) the first time the list loads —
  // never overrides an explicit user selection afterward.
  const defaultedRef = React.useRef(false);
  React.useEffect(() => {
    if (defaultedRef.current || migrations === undefined) return;
    defaultedRef.current = true;
    if (migrationId !== null) return;
    const running = migrations.find((migration) => migration.status === 'running');
    const fallback = running ?? migrations[0];
    if (fallback) setMigrationId(fallback.id);
  }, [migrations, migrationId]);

  return (
    <div className='flex flex-col gap-4'>
      <Card>
        <CardHeader className='flex flex-row items-start justify-between gap-2'>
          <div>
            <CardTitle className='text-base'>Backend migration</CardTitle>
            <CardDescription>
              Move objects between backends using the resumable copy → verify → cutover → cleanup
              workflow.
            </CardDescription>
          </div>
          <Button size='sm' onClick={() => setDialogOpen(true)}>
            <Icons.refresh />
            Migrate objects
          </Button>
        </CardHeader>
        <CardContent>
          <MigrationHistoryList selectedId={migrationId} onSelect={setMigrationId} />
        </CardContent>
      </Card>

      {migrationId !== null && <MigrationStatusCard migrationId={migrationId} />}

      <StartMigrationDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onStarted={setMigrationId}
      />
    </div>
  );
}
