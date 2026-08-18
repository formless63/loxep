import * as React from 'react';

import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger
} from '@/components/ui/drawer';

/**
 * Rule M3: the same compositional API as `Dialog` (Trigger/Content/Header/
 * Title/Description/Footer/Close), rendering `Dialog` at >=768px and the
 * vaul `Drawer` below it via `useIsMobile`. Every FORM dialog on a product
 * surface uses this instead of `Dialog` directly — `AlertDialog` confirms
 * and the command palette are deliberately excluded (see frontend-standards
 * "Density and mobile"; a small centered confirm, and the palette, are both
 * correct at every size).
 *
 * At >=768px every subcomponent below renders the *exact* `Dialog*`
 * component it wraps with props passed straight through and no added
 * attributes — the desktop DOM is byte-identical to a bare `Dialog` (this
 * is what keeps the existing desktop e2e suite, which targets
 * `getByRole('dialog')` and label selectors, passing unchanged). vaul's
 * `Drawer.Content` also renders `role="dialog"` under the hood, so mobile
 * behaves the same for that same class of selector.
 */
function ResponsiveDialog(props: React.ComponentProps<typeof Dialog>) {
  const isMobile = useIsMobile();
  return isMobile ? <Drawer {...props} /> : <Dialog {...props} />;
}

function ResponsiveDialogTrigger(props: React.ComponentProps<typeof DialogTrigger>) {
  const isMobile = useIsMobile();
  return isMobile ? <DrawerTrigger {...props} /> : <DialogTrigger {...props} />;
}

function ResponsiveDialogClose(props: React.ComponentProps<typeof DialogClose>) {
  const isMobile = useIsMobile();
  return isMobile ? <DrawerClose {...props} /> : <DialogClose {...props} />;
}

/**
 * Two behavioral additions on top of vaul's own `Drawer.Content`, both
 * discovered against a REAL tall form at a 390px viewport (loxep-pso, W5's
 * mobile QA pass — every credential dialog's `SetupGuidance` panel defaults
 * open and routinely makes the form taller than the drawer's own
 * `max-h-[85vh]`):
 *
 * - **`overflow-y-auto`.** `Drawer`'s content otherwise has no scroll
 *   mechanism of its own (only a per-direction `max-h`), so a form taller
 *   than the viewport would silently overflow off-screen. Purely additive
 *   against vaul's existing `max-h-*` classes — no conflicting utility to
 *   fight.
 * - **`after:pointer-events-none`.** vaul injects its OWN `::after` on every
 *   `[data-vaul-drawer]` element — an invisible "overscroll fill" so the
 *   drawer's background color extends during an elastic rubber-band drag,
 *   sized `top: 100%` / `height: 200%` of the drawer's own box. That sizing
 *   assumes vaul's DEFAULT (non-scrolling) content box; once THIS wrapper's
 *   own `overflow-y-auto` makes the content scrollable and taller than the
 *   drawer, the pseudo-element's positioning no longer stays harmlessly
 *   below the visible drawer — it ends up geometrically on top of real form
 *   controls (verified via `document.elementsFromPoint`: the drawer's own
 *   `::after` was the TOPMOST hit at a submit button's own coordinates,
 *   silently swallowing every click). vaul sets no `pointer-events` on it at
 *   all, so this class neutralizes it; a compiled Tailwind utility present
 *   in the document from initial page load reliably wins the cascade tie
 *   against vaul's `<style>` tag (equal specificity, but vaul's is injected
 *   into the document later, at runtime, on first mount — CSS's source-order
 *   tiebreak resolves in this class's favor). A caller's own `className`
 *   still composes after both, exactly as before.
 */
function ResponsiveDialogContent({
  className,
  children,
  showCloseButton,
  ...props
}: React.ComponentProps<typeof DialogContent>) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <DrawerContent
        className={cn('overflow-y-auto after:pointer-events-none', className)}
        {...props}
      >
        {children}
      </DrawerContent>
    );
  }

  return (
    // `max-h-[85vh] overflow-y-auto` for the same reason the Drawer branch
    // above carries its own scroll: the donor `DialogContent` sets NO height
    // bound, so a form taller than the viewport simply extends past it and
    // its submit button becomes unreachable — found live when the trading-
    // partner dialog (kind, name, legal name, currency, notes, eight role
    // checkboxes) pushed "Create" off-screen at 1280x720 (2026-08-18). A
    // caller's own className still composes last.
    <DialogContent
      className={cn('max-h-[85vh] overflow-y-auto', className)}
      showCloseButton={showCloseButton}
      {...props}
    >
      {children}
    </DialogContent>
  );
}

function ResponsiveDialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  const isMobile = useIsMobile();
  return isMobile ? (
    <DrawerHeader className={className} {...props} />
  ) : (
    <DialogHeader className={className} {...props} />
  );
}

function ResponsiveDialogFooter({
  className,
  ...props
}: React.ComponentProps<typeof DialogFooter>) {
  const isMobile = useIsMobile();
  return isMobile ? (
    <DrawerFooter className={className} {...props} />
  ) : (
    <DialogFooter className={className} {...props} />
  );
}

function ResponsiveDialogTitle(props: React.ComponentProps<typeof DialogTitle>) {
  const isMobile = useIsMobile();
  return isMobile ? <DrawerTitle {...props} /> : <DialogTitle {...props} />;
}

function ResponsiveDialogDescription(props: React.ComponentProps<typeof DialogDescription>) {
  const isMobile = useIsMobile();
  return isMobile ? <DrawerDescription {...props} /> : <DialogDescription {...props} />;
}

export {
  ResponsiveDialog,
  ResponsiveDialogClose,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger
};
