import { Icons } from '@/components/icons';
import { SidebarMenuAction } from '@/components/ui/sidebar';
import { useIsPinned, usePinnedPagesStore, type PinnedPage } from '@/hooks/use-pinned-pages';

/**
 * The pin/unpin affordance rendered on every leaf sidebar nav item, across
 * every workspace (loxep-koj). A `SidebarMenuAction` — the same primitive
 * `nav-projects.tsx`'s row menu already uses — so it inherits the sanctioned
 * hover/focus reveal and the 40px mobile hit box (M4) for free.
 *
 * Mobile carries a reduced-opacity default (rather than `showOnHover`'s
 * fully-hidden-until-hover default) so the affordance is discoverable
 * without a hover state a touch device doesn't have; desktop stays hidden
 * until hover/focus, the calmer default for a mouse-driven surface.
 */
export function NavPinToggle({ page }: { page: PinnedPage }) {
  const pinned = useIsPinned(page.url);
  const togglePin = usePinnedPagesStore((state) => state.togglePin);

  return (
    <SidebarMenuAction
      showOnHover
      className='opacity-60 md:opacity-0'
      aria-label={pinned ? `Unpin ${page.title}` : `Pin ${page.title}`}
      aria-pressed={pinned}
      onClick={(event) => {
        // The action lives inside a `SidebarMenuItem` whose sibling is a
        // navigating `Link` — stop the click from bubbling into it.
        event.preventDefault();
        event.stopPropagation();
        togglePin(page);
      }}
    >
      {pinned ? <Icons.pinFilled className='text-primary' /> : <Icons.pin />}
      <span className='sr-only'>{pinned ? 'Unpin' : 'Pin'}</span>
    </SidebarMenuAction>
  );
}
