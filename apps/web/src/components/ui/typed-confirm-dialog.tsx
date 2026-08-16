import * as React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * The typed-confirmation primitive the Pangolin chain design's write-risk
 * model calls for (rule 6): a destructive/high-stakes primary action stays
 * disabled until the operator types an exact string naming the object the
 * action touches.
 *
 * ## Why the plain `AlertDialog` isn't enough for THIS class of action
 *
 * Loxep's existing destructive confirmation
 * (`hosting-target-tokens-panel.tsx`'s token-roll `AlertDialog`) is a single
 * "Cancel" / "Roll token" choice with no typed step. The design rules that
 * pattern insufficient for a lockout-class Pangolin write: *"a roll costs a
 * redeployment while a wrongly retired access rule costs the way back in."*
 * This component is the one shared answer, so the next lockout-class action
 * (M7's rule retirement) inherits it rather than reinventing it.
 *
 * ## Provenance note (loxep-acj.3 / loxep-acj.4, 2026-08-16)
 *
 * The write-risk model reserves this primitive for milestone 3
 * (`loxep-acj.3`, "a typed-confirmation primitive in
 * `apps/web/src/components/ui/`"). M3 had not landed a component here when
 * M4's own apply UX needed one, so this is that primitive, built to the
 * design's own specification — the tier-1 apply action this milestone ships
 * does not strictly require it (tier 1 is additive/reversible; the design's
 * rule 6 gates TIER-3, lockout-class actions specifically), but M4 uses it
 * anyway for the Pangolin apply affordance as the conservative choice for a
 * provider the design calls out as "the first integration in Loxep whose
 * writes can lock the owner out of their own services" — and so the
 * component exists, tested, before the tier-3 action that strictly requires
 * it is built.
 */
export interface TypedConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  /** The exact, case-sensitive string the operator must type — typically the object's full name/domain. */
  confirmText: string;
  /** Label above the input. Defaults to naming `confirmText` directly. */
  confirmLabel?: string;
  actionLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  variant?: 'default' | 'destructive';
}

export default function TypedConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  confirmLabel,
  actionLabel,
  onConfirm,
  pending = false,
  variant = 'default'
}: TypedConfirmDialogProps) {
  const [typed, setTyped] = React.useState('');
  const inputId = React.useId();
  const matches = typed === confirmText;

  React.useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className='flex flex-col gap-3'>
              <div>{description}</div>
              <div className='flex flex-col gap-1.5'>
                <Label htmlFor={inputId}>
                  {confirmLabel ?? (
                    <>
                      Type <span className='font-mono font-medium'>{confirmText}</span> to confirm
                    </>
                  )}
                </Label>
                <Input
                  id={inputId}
                  autoComplete='off'
                  spellCheck={false}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  className='font-mono'
                />
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!matches || pending}
            data-variant={variant}
            className={
              variant === 'destructive' ? 'bg-destructive hover:bg-destructive/90' : undefined
            }
            onClick={(event) => {
              // AlertDialogAction closes the dialog on click by default;
              // the mutation's own onSettled/onSuccess handles closing so a
              // failed apply keeps the dialog open with its typed state.
              event.preventDefault();
              onConfirm();
            }}
          >
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
