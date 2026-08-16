import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import type { RegisteredSettingDto } from '@/server/admin-functions';
import { SchemaSettingForm } from './schema-setting-form';

/**
 * Dialog wrapper around the generic schema-driven form
 * (`SchemaSettingForm`, loxep-8ja.2), for editing surfaces that already open
 * a `Dialog` per setting (mirrors `SettingEditDialog` exactly — same
 * shell, same `key`-per-setting remount convention).
 *
 * PROOF-OF-CONCEPT (loxep-8ja.2): mounted for exactly one class (a) setting
 * — `documents.parser_id`, the smallest class (a) shape (one bare string
 * field) — in `application-settings/index.tsx`, replacing `SettingEditDialog`
 * for that one key only. Every other registered setting keeps the raw-JSON
 * dialog until `/settings/application`'s grouped-Cards rebuild (loxep-8ja.3).
 */
export default function SchemaSettingDialog({
  open,
  onOpenChange,
  setting
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setting: RegisteredSettingDto;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-[560px]'>
        <DialogHeader>
          <DialogTitle className='font-mono text-sm break-all'>{setting.key}</DialogTitle>
          <DialogDescription>{setting.description}</DialogDescription>
        </DialogHeader>
        <SchemaSettingForm
          setting={setting}
          onSaved={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
