import '@tanstack/react-start/server-only';

import { findRegisteredSetting } from '@loxep/domain';
import { z } from 'zod';
import type { JsonValue } from '@/server/admin-functions';

/**
 * Convert a registered setting's authoritative server-side Zod schema into
 * serializable JSON Schema data for the generic settings renderer.
 */
export function settingJsonSchema(key: string): JsonValue {
  const definition = findRegisteredSetting(key);
  if (definition === undefined) {
    throw new Error(`no registered setting definition found for "${key}"`);
  }
  return z.toJSONSchema(definition.schema) as unknown as JsonValue;
}
