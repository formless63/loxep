import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { SettingsPage } from '@/features/settings/components/settings-page';
import DiagnosticsStatTiles from '@/features/settings/components/diagnostics/stat-tiles';
import JobsTable from '@/features/settings/components/diagnostics/jobs-table';

export const Route = createFileRoute('/settings/diagnostics')({
  component: SettingsDiagnostics
});

/**
 * The dead-letter surface (loxep-6ea, audit finding A1). Before this page,
 * `graphile_worker`'s failed/stuck jobs reached the browser only as an
 * opaque prose string inside `/settings/overview`'s worker-jobs health
 * check, and only in a deployment where the embedded worker happened to be
 * running in THIS process — see `@/server/diagnostics-functions`'s module
 * doc for why this page reads the table directly instead and works in every
 * `LOXEP_MODE`.
 *
 * Retry and Discard are real actions against `graphile_worker` (its own
 * `reschedule_jobs` function, and a guarded delete matching what
 * `complete_job` itself does) — not stubs. Both are documented in
 * `@/server/diagnostics-functions`.
 */
function SettingsDiagnostics() {
  const { auth } = Route.useRouteContext();
  const isAdmin = auth?.roles.includes('admin') ?? false;

  return (
    <SettingsPage
      title='Diagnostics'
      description='The job queue: what is pending, what failed, and why — across every LOXEP_MODE, not just this process.'
    >
      {isAdmin ? (
        <div className='flex flex-col gap-4'>
          <DiagnosticsStatTiles />
          <Card>
            <CardHeader>
              <CardTitle>Failed and stuck jobs</CardTitle>
              <CardDescription>
                Jobs whose attempts are exhausted, plus the oldest jobs still waiting past their run
                time. Retry resets the attempt count and runs the job again now; Discard removes the
                row outright.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <JobsTable />
            </CardContent>
          </Card>
        </div>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Admin role required</EmptyTitle>
            <EmptyDescription>
              Job queue diagnostics are restricted to administrators.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </SettingsPage>
  );
}
