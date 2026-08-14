'use client';

import * as React from 'react';
import { CheckIcon, ChevronRightIcon, CircleIcon } from 'lucide-react';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

/**
 * loxep-wwp — PROVISIONAL fix, chosen deliberately over dropping the exit
 * animation. See the full writeup on `DropdownMenuContent` below; this
 * context is the plumbing that fix needs.
 *
 * `DropdownMenuContent` carries `data-[state=closed]:animate-out`, so Radix's
 * `Presence` keeps the content — and its `DismissableLayer` — mounted for the
 * ~150ms exit animation. A `pointerdown` on the trigger inside that window is
 * seen twice: the trigger toggles the menu OPEN, then the still-mounted
 * closing layer treats the same press as an outside interaction and closes
 * it again a few ms later, so the reopen is silently swallowed (measured 5/9
 * failures on immediate reopen, 0/6 with a 150ms pause; see bead loxep-wwp).
 *
 * The fix is to have `DropdownMenuContent` recognize a press on its own
 * trigger as never being "outside," so only the trigger's own toggle acts on
 * the event. Doing that needs the content to know which element its trigger
 * is. Radix's `DropdownMenu` does track a `triggerRef` internally, but the
 * context hook that holds it (`useDropdownMenuContext`) is not part of
 * `@radix-ui/react-dropdown-menu`'s public API — only `createDropdownMenuScope`
 * is exported, confirmed against the installed 2.1.24 `dist/index.d.ts`.
 * Reaching into Radix's private module scope isn't viable, so this primitive
 * grows its own small ref-sharing context instead: `DropdownMenu` owns the
 * ref, `DropdownMenuTrigger` populates it (composed with any ref a caller
 * passes), and `DropdownMenuContent` reads it. This generalizes the
 * per-instance guard from loxep-6i1 to every dropdown built on this
 * primitive, with no per-call-site wiring required.
 */
const DropdownMenuTriggerRefContext =
  React.createContext<React.RefObject<HTMLButtonElement | null> | null>(null);

function composeTriggerRefs<T>(...refs: Array<React.Ref<T> | undefined | null>) {
  return (node: T | null) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.RefObject<T | null>).current = node;
    }
  };
}

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenuTriggerRefContext.Provider value={triggerRef}>
      <DropdownMenuPrimitive.Root data-slot='dropdown-menu' {...props} />
    </DropdownMenuTriggerRefContext.Provider>
  );
}

function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return <DropdownMenuPrimitive.Portal data-slot='dropdown-menu-portal' {...props} />;
}

function DropdownMenuTrigger({
  ref,
  ...props
}: React.ComponentPropsWithRef<typeof DropdownMenuPrimitive.Trigger>) {
  const sharedTriggerRef = React.useContext(DropdownMenuTriggerRefContext);
  const composedRef = React.useMemo(
    () => (sharedTriggerRef ? composeTriggerRefs(ref, sharedTriggerRef) : ref),
    [ref, sharedTriggerRef]
  );
  return (
    <DropdownMenuPrimitive.Trigger data-slot='dropdown-menu-trigger' ref={composedRef} {...props} />
  );
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  onPointerDownOutside,
  onFocusOutside,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  const triggerRef = React.useContext(DropdownMenuTriggerRefContext);
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot='dropdown-menu-content'
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className
        )}
        // loxep-wwp — a press on our own trigger is never "outside" this
        // menu, it's the toggle. Cancel the dismiss so only the trigger's
        // toggle acts on the event; see the PROVISIONAL note above
        // `DropdownMenuTriggerRefContext` for the full mechanism and why.
        //
        // Radix's `DismissableLayer` dismisses on EITHER a pointerdown
        // outside OR a focus-in outside (`onFocusOutside`), as two
        // independent listeners — cancelling only one leaves the other
        // path live. Reopening moves focus onto the trigger via the click
        // that reopened it, which is itself "outside" the still-mounted
        // closing layer, so both have to be guarded the same way or the
        // reopened menu can still close again through the focus path
        // instead of the pointerdown path.
        onPointerDownOutside={(event) => {
          if (triggerRef?.current?.contains(event.target as Node)) {
            event.preventDefault();
          }
          onPointerDownOutside?.(event);
        }}
        onFocusOutside={(event) => {
          if (triggerRef?.current?.contains(event.target as Node)) {
            event.preventDefault();
          }
          onFocusOutside?.(event);
        }}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot='dropdown-menu-group' {...props} />;
}

function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: 'default' | 'destructive';
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot='dropdown-menu-item'
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:*:[svg]:text-destructive!",
        className
      )}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot='dropdown-menu-checkbox-item'
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      checked={checked}
      {...props}
    >
      <span className='pointer-events-none absolute left-2 flex size-3.5 items-center justify-center'>
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className='size-4' />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot='dropdown-menu-radio-group' {...props} />;
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot='dropdown-menu-radio-item'
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span className='pointer-events-none absolute left-2 flex size-3.5 items-center justify-center'>
        <DropdownMenuPrimitive.ItemIndicator>
          <CircleIcon className='size-2 fill-current' />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot='dropdown-menu-label'
      data-inset={inset}
      className={cn('px-2 py-1.5 text-sm font-medium data-[inset]:pl-8', className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot='dropdown-menu-separator'
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot='dropdown-menu-shortcut'
      className={cn('ml-auto text-xs tracking-widest text-muted-foreground', className)}
      {...props}
    />
  );
}

function DropdownMenuSub({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot='dropdown-menu-sub' {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot='dropdown-menu-sub-trigger'
      data-inset={inset}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[inset]:pl-8 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className='ml-auto size-4' />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot='dropdown-menu-sub-content'
      className={cn(
        'z-50 min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-lg data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
        className
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
};
