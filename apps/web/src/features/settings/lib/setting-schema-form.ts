/**
 * Pure logic behind the generic schema-driven settings form (loxep-8ja.2,
 * settings-ux-design.md §2.2). Given a `RegisteredSettingDto.jsonSchema` —
 * plain JSON Schema data produced server-side by `z.toJSONSchema()`
 * (loxep-8ja.1) — this maps it to a small, renderer-agnostic field
 * description the React layer (`schema-setting-form.tsx`) turns into
 * `useAppForm` fields. No React import here on purpose: the shape mapping is
 * the part worth unit-testing directly, without mounting a component.
 *
 * The browser never runs the setting's live Zod schema (§2.1) — this module
 * only ever reads the JSON Schema DTO, never a `z.ZodType`.
 */

/** A JSON Schema node, loosely typed — this module only reads known keys. */
type JsonSchemaNode = Record<string, unknown>;

function isRecord(value: unknown): value is JsonSchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `intervalSeconds` -> `Interval seconds`, `watchlistItemsPerPoll` ->
 * `Watchlist items per poll`. Sentence case, matching the short hand-written
 * labels already in `GatusPushCard`/`ProvisioningCard` ("Push token", "Base
 * URL") rather than Title Case.
 */
export function humanizeFieldName(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  return spaced.length === 0 ? spaced : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** `read_only` -> `Read only`, `parts_donor` -> `Parts donor`. */
export function humanizeEnumValue(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').toLowerCase();
  return spaced.length === 0 ? spaced : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

interface BaseWidget {
  /** The field's own path — the object property name, or `value` for a bare (non-object) setting. */
  name: string;
  label: string;
  description?: string;
}

export type SettingFieldWidget =
  | (BaseWidget & { kind: 'switch' })
  | (BaseWidget & { kind: 'select'; options: { value: string; label: string }[] })
  | (BaseWidget & { kind: 'number'; min?: number; max?: number })
  | (BaseWidget & { kind: 'tags' })
  | (BaseWidget & { kind: 'text'; nullable: boolean });

export type SettingFormShape =
  /** `{ type: 'object', properties: {...} }` — one Card field per property, in declaration order. */
  | { kind: 'object'; fields: SettingFieldWidget[] }
  /** A bare, non-object top-level schema (setting #13's shape) — one field, no FieldGroup wrapper. */
  | { kind: 'bare'; field: SettingFieldWidget }
  /**
   * A record (`z.record`), a nested object, or any shape §2.2's table does
   * not cover — the advanced JSON escape hatch renders instead. Never a
   * thrown error: an unmappable shape is an expected, permanent case
   * (class (b)/(c) settings, `integration.tailscale.ignored_devices`, …),
   * not a bug.
   */
  | { kind: 'unmappable' };

/** Maps one JSON Schema node — an object's property, or a bare top-level schema — to a widget. */
function mapFieldSchema(name: string, schema: JsonSchemaNode): SettingFieldWidget | null {
  const label = humanizeFieldName(name);
  const description = typeof schema.description === 'string' ? schema.description : undefined;

  if (schema.type === 'boolean') {
    return { kind: 'switch', name, label, description };
  }

  if (schema.type === 'string' && Array.isArray(schema.enum)) {
    const values = schema.enum.filter((entry): entry is string => typeof entry === 'string');
    // Every enum member must be a string — a mixed enum isn't a shape §2.2 covers.
    if (values.length !== schema.enum.length || values.length === 0) return null;
    return {
      kind: 'select',
      name,
      label,
      description,
      options: values.map((value) => ({ value, label: humanizeEnumValue(value) }))
    };
  }

  if (schema.type === 'integer' || schema.type === 'number') {
    return {
      kind: 'number',
      name,
      label,
      description,
      min: typeof schema.minimum === 'number' ? schema.minimum : undefined,
      max: typeof schema.maximum === 'number' ? schema.maximum : undefined
    };
  }

  if (schema.type === 'array' && isRecord(schema.items) && schema.items.type === 'string') {
    return { kind: 'tags', name, label, description };
  }

  if (schema.type === 'string') {
    return { kind: 'text', name, label, description, nullable: false };
  }

  // Nullable string: `z.string().nullable()` -> `anyOf: [{type:'string',...}, {type:'null'}]`.
  if (Array.isArray(schema.anyOf) && schema.anyOf.length === 2) {
    const branches = schema.anyOf.filter(isRecord);
    const hasNullBranch = branches.some((branch) => branch.type === 'null');
    const stringBranch = branches.find((branch) => branch.type === 'string');
    if (hasNullBranch && stringBranch !== undefined && branches.length === 2) {
      return { kind: 'text', name, label, description, nullable: true };
    }
  }

  return null;
}

/**
 * Maps a `RegisteredSettingDto.jsonSchema` to a form shape per §2.2's table.
 * Never throws — an unrecognized shape maps to `{ kind: 'unmappable' }`
 * rather than crashing the settings page, per this bead's own requirement.
 */
export function mapSettingJsonSchema(jsonSchema: unknown): SettingFormShape {
  if (!isRecord(jsonSchema)) return { kind: 'unmappable' };

  // `{ type: 'object', properties: {...} }` — the generic per-field Card body.
  if (isRecord(jsonSchema.properties)) {
    const fields: SettingFieldWidget[] = [];
    for (const [name, propertySchema] of Object.entries(jsonSchema.properties)) {
      if (!isRecord(propertySchema)) return { kind: 'unmappable' };
      const widget = mapFieldSchema(name, propertySchema);
      if (widget === null) return { kind: 'unmappable' };
      fields.push(widget);
    }
    if (fields.length === 0) return { kind: 'unmappable' };
    return { kind: 'object', fields };
  }

  // `{ type: 'object', additionalProperties: {...} }` — a z.record, per §2.2
  // deliberately NOT handled generically here (rows 16-18 of the inventory:
  // go find where the map's keys are already enumerated).
  if ('additionalProperties' in jsonSchema) return { kind: 'unmappable' };

  // Bare (non-object) top-level schema, e.g. `z.boolean()` (setting #13).
  const widget = mapFieldSchema('value', jsonSchema);
  if (widget === null) return { kind: 'unmappable' };
  return { kind: 'bare', field: widget };
}

export interface SettingValidationIssue {
  path: string;
  message: string;
}

/**
 * `SettingsService`'s `parseIncoming` (`packages/domain/src/settings.ts`)
 * formats a rejected write as one string:
 * `value for setting "<key>" failed validation (schema version <n>): <path>: <message>; <path2>: <message2>`
 * — `(root)` when a bare (non-object) schema's own value fails. TanStack
 * Start server functions surface a thrown error's `.message` verbatim on the
 * client (the existing raw-JSON dialog already relies on this), so this
 * parses that same string back into per-field issues instead of inventing a
 * second, structured error channel the server does not send.
 *
 * Returns `null` when the message doesn't match the expected shape (a
 * non-validation error, e.g. a network failure) — the caller's job is then a
 * single top-of-form error, never a crash.
 */
export function parseSettingValidationIssues(message: string): SettingValidationIssue[] | null {
  const match = /^value for setting "[^"]*" failed validation \(schema version \d+\): (.+)$/su.exec(
    message
  );
  if (match === null) return null;
  const [, issuesText] = match;
  if (issuesText === undefined) return null;

  const issues: SettingValidationIssue[] = [];
  for (const part of issuesText.split('; ')) {
    const separatorIndex = part.indexOf(': ');
    if (separatorIndex === -1) return null;
    const rawPath = part.slice(0, separatorIndex);
    // The bare-schema case's synthetic field name matches mapSettingJsonSchema's 'value'.
    const path = rawPath === '(root)' ? 'value' : rawPath;
    issues.push({ path, message: part.slice(separatorIndex + 2) });
  }
  return issues;
}
