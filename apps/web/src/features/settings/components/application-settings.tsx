import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { applicationSettingsQuery } from '@/features/settings/api/queries';

function formatValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return '—';
  return serialized.length > 120 ? `${serialized.slice(0, 120)}…` : serialized;
}

/**
 * Application settings (ADR-0016): the typed registry (`defineSetting`) plus
 * a read-only listing of raw `application_settings` rows for keys written
 * outside the registry (e.g. jobs' runtime.heartbeat) — keys and provenance
 * only, values deliberately uninterpreted.
 */
export default function ApplicationSettings() {
  const { data, isPending } = useQuery(applicationSettingsQuery);

  if (isPending) {
    return <Skeleton className='h-64 w-full' />;
  }

  const registered = data?.registered ?? [];
  const raw = data?.raw ?? [];

  return (
    <div className='flex flex-col gap-4'>
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Registered settings</CardTitle>
        </CardHeader>
        <CardContent>
          {registered.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No registered settings</EmptyTitle>
                <EmptyDescription>
                  Settings are declared in code through the typed registry (defineSetting) and
                  appear here as features register them — the registry is empty in this build.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {registered.map((entry) => (
                  <TableRow key={entry.key}>
                    <TableCell className='font-mono text-xs'>{entry.key}</TableCell>
                    <TableCell className='text-muted-foreground max-w-md'>
                      {entry.description}
                    </TableCell>
                    <TableCell className='font-mono text-xs'>{formatValue(entry.value)}</TableCell>
                    <TableCell>
                      <Badge variant={entry.isSet ? 'secondary' : 'outline'}>
                        {entry.isSet ? 'stored' : 'default'}
                      </Badge>
                    </TableCell>
                    <TableCell className='text-muted-foreground'>
                      {entry.updatedAt
                        ? format(new Date(entry.updatedAt), 'yyyy-MM-dd HH:mm')
                        : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Raw stored rows</CardTitle>
        </CardHeader>
        <CardContent className='flex flex-col gap-3'>
          <p className='text-muted-foreground text-sm'>
            Every stored application_settings row — including keys written outside the registry —
            listed without value interpretation.
          </p>
          {raw.length === 0 ? (
            <p className='text-muted-foreground text-sm'>No rows stored yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Schema version</TableHead>
                  <TableHead>Updated by</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {raw.map((row) => (
                  <TableRow key={row.key}>
                    <TableCell className='font-mono text-xs'>{row.key}</TableCell>
                    <TableCell className='text-muted-foreground'>{row.schemaVersion}</TableCell>
                    <TableCell className='text-muted-foreground'>
                      {row.updatedByUserId ?? 'system'}
                    </TableCell>
                    <TableCell className='text-muted-foreground'>
                      {format(new Date(row.updatedAt), 'yyyy-MM-dd HH:mm')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
