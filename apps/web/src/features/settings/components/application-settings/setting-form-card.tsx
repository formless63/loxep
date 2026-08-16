import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { RegisteredSettingDto } from '@/server/admin-functions';
import { SchemaSettingForm, SettingReadOnlyView } from './schema-setting-form';

/**
 * One class (a) setting's Card on `/settings/application` (loxep-8ja.3,
 * settings-ux-design.md §3) — the grouped-Cards replacement for the old
 * flat "Registered settings" table's row + Edit-dialog shape (and for the
 * loxep-8ja.2 proof-of-concept's `SchemaSettingDialog`, now retired: every
 * class (a) setting renders inline instead of behind a dialog). Header is
 * the setting's own key/description (the same content that dialog's title
 * carried, moved onto an inline Card); body is the generic form for admins,
 * or the same fields read-only for everyone else — `updateApplicationSetting`
 * is admin-only server-side regardless, but showing an editable form nobody
 * may submit is a dead end, not a permission boundary, so the UI mirrors
 * the boundary.
 *
 * No `onCancel`/`onSaved` is threaded through: an inline Card has no dialog
 * to close and no separate "editing" mode to leave, matching
 * `GatusPushCard`/`ProvisioningCard`'s existing inline-Card shape (Save
 * only, no Cancel).
 */
export function SettingFormCard({
  setting,
  isAdmin,
  banner
}: {
  setting: RegisteredSettingDto;
  isAdmin: boolean;
  banner?: (values: Record<string, unknown>) => ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className='font-mono text-sm break-all'>{setting.key}</CardTitle>
        <CardDescription>{setting.description}</CardDescription>
      </CardHeader>
      <CardContent>
        {isAdmin ? (
          <SchemaSettingForm setting={setting} banner={banner} />
        ) : (
          <SettingReadOnlyView setting={setting} />
        )}
      </CardContent>
    </Card>
  );
}
