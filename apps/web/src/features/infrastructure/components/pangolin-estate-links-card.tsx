import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Icons } from '@/components/icons';
import { pangolinConnectionOptionsQuery } from '@/features/infrastructure/api/queries';

/**
 * "Pangolin estates" — the infrastructure overview's entry point into the
 * per-connection estate browser (loxep-pq2), one row per Pangolin
 * connection. Absent entirely when no Pangolin connection exists yet,
 * matching `UnmatchedContainerHostsCard`'s own "punch list, not a status
 * row" discipline — there is nothing useful to show a install with no
 * Pangolin connection at all.
 */
export default function PangolinEstateLinksCard() {
  const { data: connections } = useQuery(pangolinConnectionOptionsQuery);
  const list = connections ?? [];
  if (list.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Pangolin estates</CardTitle>
        <CardDescription>
          Sites, resources, and org domains for each connected instance — read live.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className='flex flex-col gap-1'>
          {list.map((connection) => (
            <li key={connection.id}>
              <Link
                to='/infrastructure/proxy/$connectionId'
                params={{ connectionId: connection.id }}
                className='flex items-center justify-between gap-2 rounded-md px-2 py-1.5 outline-none transition-colors hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring'
              >
                <span className='flex items-center gap-2 font-medium'>
                  <Icons.integrations className='h-4 w-4' />
                  {connection.name}
                </span>
                <Icons.arrowRight className='text-muted-foreground h-4 w-4' />
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
