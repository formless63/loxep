import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Icons } from '@/components/icons';
import { CopyableValue } from '@/features/settings/components/setup-guidance';

/**
 * ADR-0022's one-time reveal, rendered exactly once per minted or rolled
 * value: shown in the response to the creating/rolling action, with a copy
 * button and an explicit "will not be shown again" affordance. After this
 * dialog closes there is no read-back path anywhere in the product — closing
 * it is treated as final, not as "dismiss for now".
 */
export default function RevealOnceDialog({
  open,
  onOpenChange,
  title,
  description,
  value
}: {
  open: boolean;
  /** Closing always discards the value from this component's memory. */
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  value: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className='sm:max-w-[520px]'
        // No "click outside to dismiss without acknowledging" — the operator
        // must use the explicit "I've saved this" action below.
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Alert variant='warning'>
          <Icons.warning />
          <AlertTitle>You will not see this value again</AlertTitle>
          <AlertDescription>
            Copy it now and paste it into the host's configuration. Loxep stores only an encrypted
            copy with no read-back path — a lost value means rolling a new one, not recovering this
            one.
          </AlertDescription>
        </Alert>
        <CopyableValue label='Token value' value={value} copyLabel='Copy value' />
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>I've saved this value</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
