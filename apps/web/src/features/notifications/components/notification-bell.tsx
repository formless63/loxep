/**
 * The PRODUCT notification bell (loxep-oii), reading the real
 * `notification_events` ledger.
 *
 * This is the successor loxep-67w required: the donor `NotificationCenter`
 * and its `mockNotifications` store stay exactly where they are, inside
 * `/starter`, and re-enabling the bell on product surfaces replaced the DATA
 * SOURCE rather than restoring the fiction.
 *
 * Each row is rendered server-side by the same pure renderer that produces
 * the outbound ntfy message (`@loxep/notifications/render`), so the bell and
 * the push can never describe the same fact differently.
 *
 * Read state is a client-side "last opened" mark, deliberately not a
 * server-side per-user read table: the ledger is a feed of installation
 * facts, and Loxep has installation-wide roles rather than per-user
 * notification preferences (ADR-0023's open question 2).
 */
import React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { formatRelativeTime } from '@/lib/format';
import { notificationFeedQuery } from '@/features/settings/api/queries';
import { notificationEventClassLabel } from '@/features/settings/constants';
import type { NotificationFeedItemDto } from '@/server/admin-functions';

const LAST_SEEN_STORAGE_KEY = 'loxep.notifications.lastSeenAt';
const MAX_VISIBLE = 8;

function readLastSeen(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(LAST_SEEN_STORAGE_KEY);
  } catch {
    // Private browsing / storage disabled: everything simply reads as unseen.
    return null;
  }
}

export function NotificationBell() {
  const [lastSeenAt, setLastSeenAt] = React.useState<string | null>(null);
  React.useEffect(() => {
    setLastSeenAt(readLastSeen());
  }, []);

  const { data } = useQuery(notificationFeedQuery);
  const items: NotificationFeedItemDto[] = data ?? [];
  const unreadCount =
    lastSeenAt === null
      ? items.length
      : items.filter((item) => item.occurredAt > lastSeenAt).length;

  function markSeen() {
    const now = new Date().toISOString();
    setLastSeenAt(now);
    try {
      window.localStorage.setItem(LAST_SEEN_STORAGE_KEY, now);
    } catch {
      // Nothing to recover: the badge simply keeps its count this session.
    }
  }

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) markSeen();
      }}
    >
      <PopoverTrigger asChild>
        <Button variant='ghost' size='icon' className='relative h-8 w-8'>
          <Icons.notification className='h-4 w-4' />
          {unreadCount > 0 && (
            <span className='bg-destructive text-destructive-foreground absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium'>
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
          <span className='sr-only'>Notifications</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[calc(100vw-2rem)] p-0 sm:w-[380px]' sideOffset={8}>
        <div className='flex items-center justify-between px-4 py-3'>
          <Link to='/settings/notifications' className='group flex items-center gap-1'>
            <h4 className='text-sm font-semibold group-hover:underline'>Notifications</h4>
            <Icons.chevronRight className='text-muted-foreground h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5' />
          </Link>
          {unreadCount > 0 && (
            <span className='bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs'>
              {unreadCount} new
            </span>
          )}
        </div>
        <Separator />
        {items.length === 0 ? (
          <p className='text-muted-foreground px-4 py-6 text-sm'>
            Nothing yet. Loxep records an event here whenever something needs you — a price drop, an
            ingested purchase, a confirmed document, a recorded sale, or an integration changing
            health.
          </p>
        ) : (
          <ScrollArea className='max-h-[22rem]'>
            <ul className='divide-border divide-y'>
              {items.slice(0, MAX_VISIBLE).map((item) => (
                <li key={item.id} className='px-4 py-3'>
                  <NotificationRow
                    item={item}
                    unseen={lastSeenAt === null || item.occurredAt > lastSeenAt}
                  />
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}

function NotificationRow({ item, unseen }: { item: NotificationFeedItemDto; unseen: boolean }) {
  const content = (
    <div className='space-y-1'>
      <div className='flex items-start justify-between gap-2'>
        <p className='text-sm leading-snug font-medium'>{item.title}</p>
        {unseen && <span className='bg-primary mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full' />}
      </div>
      <p className='text-muted-foreground text-xs whitespace-pre-line'>{item.body}</p>
      <div className='flex items-center gap-2'>
        <Badge variant='outline' className='text-[10px]'>
          {notificationEventClassLabel(item.eventClass)}
        </Badge>
        <span className='text-muted-foreground text-[11px]'>
          {formatRelativeTime(item.occurredAt)}
        </span>
        {item.deliveredCount > 0 && (
          <span className='text-muted-foreground text-[11px]'>sent to {item.deliveredCount}</span>
        )}
      </div>
    </div>
  );
  return item.href === null ? (
    content
  ) : (
    <Link to={item.href} className='block hover:opacity-80'>
      {content}
    </Link>
  );
}
