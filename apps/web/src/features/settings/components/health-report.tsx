import { useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { healthReportQuery } from '@/features/settings/api/queries';
import { StatusBadge } from '@/features/settings/components/settings-page';

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function CheckTable({
  title,
  entries
}: {
  title: string;
  entries: [string, { ok: boolean; detail?: string }][];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className='text-muted-foreground text-sm'>None reported.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map(([name, result]) => (
                <TableRow key={name}>
                  <TableCell className='font-medium'>{name}</TableCell>
                  <TableCell>
                    <StatusBadge ok={result.ok} okLabel='ok' failLabel='failing' />
                  </TableCell>
                  <TableCell className='text-muted-foreground max-w-xl whitespace-normal break-words'>
                    {result.detail ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Readiness/health detail (ADR-0018): overall status, mode, uptime, and the
 * per-component/per-check results including DB, migrations, worker, and job
 * queue statistics carried in the check detail strings.
 */
export default function HealthReport() {
  const { data, isPending, isError, error } = useQuery(healthReportQuery);

  if (isPending) {
    return (
      <div className='flex flex-col gap-4'>
        <Skeleton className='h-24 w-full' />
        <Skeleton className='h-48 w-full' />
      </div>
    );
  }

  if (isError) {
    return (
      <Alert variant='destructive'>
        <AlertTitle>Health report unavailable</AlertTitle>
        <AlertDescription>
          {error instanceof Error ? error.message : 'Unknown error'}
        </AlertDescription>
      </Alert>
    );
  }

  const isDev = data.mode === 'dev';
  const components = Object.entries(data.components);
  const checks = Object.entries(data.checks);

  return (
    <div className='flex flex-col gap-4'>
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Runtime</CardTitle>
        </CardHeader>
        <CardContent className='flex flex-wrap items-center gap-6 text-sm'>
          <div className='flex items-center gap-2'>
            <span className='text-muted-foreground'>Status</span>
            <StatusBadge ok={data.status === 'ok'} okLabel='ok' failLabel='unready' />
          </div>
          <div className='flex items-center gap-2'>
            <span className='text-muted-foreground'>Mode</span>
            <Badge variant='outline'>{data.mode}</Badge>
          </div>
          <div className='flex items-center gap-2'>
            <span className='text-muted-foreground'>Uptime</span>
            <span>{data.uptimeSeconds === null ? '—' : formatUptime(data.uptimeSeconds)}</span>
          </div>
        </CardContent>
      </Card>

      {isDev && (
        <Alert>
          <AlertTitle>Dev mode</AlertTitle>
          <AlertDescription>
            No runtime state is available under the vite dev server — component and dependency
            checks report only when the app runs via the Loxep entrypoint (bin/loxep).
          </AlertDescription>
        </Alert>
      )}

      <CheckTable title='Components' entries={components} />
      <CheckTable title='Dependency checks' entries={checks} />
    </div>
  );
}
