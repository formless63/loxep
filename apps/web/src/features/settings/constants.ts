/**
 * Client-safe constants for the settings workspace. Server-package imports
 * here are type-only so nothing heavy reaches the client bundle; the
 * `satisfies Record<...>` maps keep every union member covered — adding a
 * kind/status upstream fails typechecking here instead of silently drifting.
 */
import type { EconomicEntityKind } from '@loxep/db/schema';
import type { ConnectionStatus } from '@loxep/domain';
import type { StorageDriverFamily } from '@loxep/storage';

const ENTITY_KIND_LABELS = {
  individual: 'Individual',
  sole_proprietorship: 'Sole proprietorship',
  llc: 'LLC',
  partnership: 'Partnership',
  corporation: 'Corporation',
  assumed_name: 'Assumed name',
  operating_unit: 'Operating unit',
  other: 'Other'
} satisfies Record<EconomicEntityKind, string>;

export const ECONOMIC_ENTITY_KIND_VALUES = Object.keys(
  ENTITY_KIND_LABELS
) as readonly EconomicEntityKind[];

export const entityKindOptions = ECONOMIC_ENTITY_KIND_VALUES.map((value) => ({
  value,
  label: ENTITY_KIND_LABELS[value]
}));

export function entityKindLabel(kind: EconomicEntityKind | string): string {
  return ENTITY_KIND_LABELS[kind as EconomicEntityKind] ?? kind;
}

export const CONNECTION_STATUS_LABELS = {
  active: 'Active',
  disabled: 'Disabled',
  error: 'Error'
} satisfies Record<ConnectionStatus, string>;

export const STORAGE_DRIVER_LABELS = {
  local: 'Local filesystem',
  s3: 'S3-compatible'
} satisfies Record<StorageDriverFamily, string>;

/** No-attribution sentinel for entity selects (Radix Select rejects ''). */
export const NO_ENTITY_VALUE = '__none__';
