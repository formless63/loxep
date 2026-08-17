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
 * The one real behavioral addition: `Drawer`'s content otherwise has no
 * scroll mechanism of its own (only a per-direction `max-h`), so a form
 * taller than the viewport would silently overflow off-screen. Adding
 * `overflow-y-auto` is purely additive against vaul's existing `max-h-*`
 * classes (no conflicting utility to fight), so it is the only class this
 * wrapper adds beyond the caller's own `className` — everything else about
 * sizing/spacing is exactly what the caller already passed for `Dialog`.
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
      <DrawerContent className={cn('overflow-y-auto', className)} {...props}>
        {children}
      </DrawerContent>
    );
  }

  return (
    <DialogContent className={className} showCloseButton={showCloseButton} {...props}>
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
