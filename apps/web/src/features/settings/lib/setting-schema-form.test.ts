/**
 * Unit tests for the generic settings-form shape mapping (loxep-8ja.2,
 * settings-ux-design.md §2.2). Run with Bun's built-in test runner, matching
 * `admin-functions.test.ts`'s precedent for pure-logic modules in this
 * feature: `bun test apps/web/src/features/settings/lib/setting-schema-form.test.ts`.
 *
 * These exercise `mapSettingJsonSchema` against real `z.toJSONSchema()`
 * output for every registered class (a) setting (via `@loxep/domain`), so a
 * drift between the domain schema and this mapping fails here rather than
 * only being caught by eye in the rendered UI.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  caaPolicySetting,
  documentsParserIdSetting,
  ebayRateBudgetSetting,
  integrationsEnabledSetting,
  inventoryDefaultSaleModeSetting,
  monitorObservationCapsSetting,
  orderPayloadRetentionSetting
} from '@loxep/domain';
import {
  humanizeEnumValue,
  humanizeFieldName,
  mapSettingJsonSchema,
  parseSettingValidationIssues
} from './setting-schema-form.ts';

describe('humanizeFieldName', () => {
  test('splits camelCase into sentence-case words', () => {
    expect(humanizeFieldName('intervalSeconds')).toBe('Interval seconds');
    expect(humanizeFieldName('watchlistItemsPerPoll')).toBe('Watchlist items per poll');
  });

  test('leaves a single lowercase word capitalized', () => {
    expect(humanizeFieldName('value')).toBe('Value');
  });
});

describe('humanizeEnumValue', () => {
  test('turns snake_case into sentence case', () => {
    expect(humanizeEnumValue('read_only')).toBe('Read only');
    expect(humanizeEnumValue('parts_donor')).toBe('Parts donor');
  });

  test('leaves an already-bare word capitalized', () => {
    expect(humanizeEnumValue('keep')).toBe('Keep');
  });
});

describe('mapSettingJsonSchema — field-mapping table (settings-ux-design.md §2.2)', () => {
  test('boolean -> switch', () => {
    const shape = mapSettingJsonSchema(
      z.toJSONSchema(z.strictObject({ enabled: z.boolean().describe('Whether it runs') }))
    );
    expect(shape.kind).toBe('object');
    if (shape.kind !== 'object') throw new Error('expected object shape');
    expect(shape.fields).toEqual([
      { kind: 'switch', name: 'enabled', label: 'Enabled', description: 'Whether it runs' }
    ]);
  });

  test('enum -> select, with humanized option labels', () => {
    const shape = mapSettingJsonSchema(z.toJSONSchema(orderPayloadRetentionSetting.schema));
    expect(shape.kind).toBe('object');
    if (shape.kind !== 'object') throw new Error('expected object shape');
    const mode = shape.fields.find((field) => field.name === 'mode');
    expect(mode?.kind).toBe('select');
    if (mode?.kind !== 'select') throw new Error('expected select field');
    expect(mode.options).toEqual([
      { value: 'redact', label: 'Redact' },
      { value: 'keep', label: 'Keep' }
    ]);
  });

  test('number (with min/max) -> number, with unit-bearing description carried through', () => {
    const shape = mapSettingJsonSchema(z.toJSONSchema(ebayRateBudgetSetting.schema));
    expect(shape.kind).toBe('object');
    if (shape.kind !== 'object') throw new Error('expected object shape');
    const capacity = shape.fields.find((field) => field.name === 'capacity');
    expect(capacity?.kind).toBe('number');
    if (capacity?.kind !== 'number') throw new Error('expected number field');
    expect(capacity.min).toBe(1);
    expect(capacity.max).toBe(1000);
    expect(capacity.description).toBe('Burst size, in provider calls');
  });

  test('string[] -> tags', () => {
    const shape = mapSettingJsonSchema(z.toJSONSchema(caaPolicySetting.schema));
    expect(shape.kind).toBe('object');
    if (shape.kind !== 'object') throw new Error('expected object shape');
    const issuers = shape.fields.find((field) => field.name === 'issuers');
    expect(issuers?.kind).toBe('tags');
  });

  test('bare string (no enum) -> text, not nullable', () => {
    const shape = mapSettingJsonSchema(z.toJSONSchema(documentsParserIdSetting.schema));
    expect(shape.kind).toBe('object');
    if (shape.kind !== 'object') throw new Error('expected object shape');
    expect(shape.fields).toEqual([
      {
        kind: 'text',
        name: 'parserId',
        label: 'Parser id',
        nullable: false,
        description: shape.fields[0]?.description
      }
    ]);
    expect(shape.fields[0]?.description).toContain('ReceiptParser');
  });

  test('nullable string -> text, nullable — the empty-input-submits-null convention lives in the field, not the mapping', () => {
    const shape = mapSettingJsonSchema(z.toJSONSchema(caaPolicySetting.schema));
    expect(shape.kind).toBe('object');
    if (shape.kind !== 'object') throw new Error('expected object shape');
    const iodef = shape.fields.find((field) => field.name === 'iodef');
    expect(iodef?.kind).toBe('text');
    if (iodef?.kind !== 'text') throw new Error('expected text field');
    expect(iodef.nullable).toBe(true);
  });

  test('every class (a) object setting maps to an object shape with one field per property', () => {
    for (const definition of [
      monitorObservationCapsSetting,
      ebayRateBudgetSetting,
      orderPayloadRetentionSetting,
      caaPolicySetting,
      inventoryDefaultSaleModeSetting,
      documentsParserIdSetting
    ]) {
      const shape = mapSettingJsonSchema(z.toJSONSchema(definition.schema));
      expect(shape.kind).toBe('object');
    }
  });
});

describe('mapSettingJsonSchema — the bare-boolean case (setting #13, auth.onboarding_oidc_prompt_dismissed)', () => {
  test('a bare, non-object schema maps to kind "bare", one field, no FieldGroup wrapper', () => {
    const shape = mapSettingJsonSchema(z.toJSONSchema(z.boolean()));
    expect(shape).toEqual({
      kind: 'bare',
      field: { kind: 'switch', name: 'value', label: 'Value', description: undefined }
    });
  });
});

describe('mapSettingJsonSchema — falls back gracefully for an unmappable shape', () => {
  test('a Record<string, boolean> setting (integrations.enabled) falls back rather than crashing', () => {
    const shape = mapSettingJsonSchema(z.toJSONSchema(integrationsEnabledSetting.schema));
    expect(shape).toEqual({ kind: 'unmappable' });
  });

  test('a nested object field falls back the whole setting, not just that field', () => {
    const schema = z.strictObject({
      outer: z.strictObject({ inner: z.string() })
    });
    expect(mapSettingJsonSchema(z.toJSONSchema(schema))).toEqual({ kind: 'unmappable' });
  });

  test('an array of non-string items falls back', () => {
    const schema = z.strictObject({ items: z.array(z.number()) });
    expect(mapSettingJsonSchema(z.toJSONSchema(schema))).toEqual({ kind: 'unmappable' });
  });

  test('null, undefined, and non-object input all fall back rather than throwing', () => {
    expect(mapSettingJsonSchema(null)).toEqual({ kind: 'unmappable' });
    expect(mapSettingJsonSchema(undefined)).toEqual({ kind: 'unmappable' });
    expect(mapSettingJsonSchema('not a schema')).toEqual({ kind: 'unmappable' });
    expect(mapSettingJsonSchema(42)).toEqual({ kind: 'unmappable' });
  });

  test('an empty object schema (no properties) falls back', () => {
    expect(mapSettingJsonSchema({ type: 'object', properties: {} })).toEqual({
      kind: 'unmappable'
    });
  });
});

describe('parseSettingValidationIssues', () => {
  test('parses a single-issue server message into a path/message pair', () => {
    const message =
      'value for setting "commerce.order_payload_retention" failed validation (schema version 1): afterDays: Number must be greater than or equal to 1';
    expect(parseSettingValidationIssues(message)).toEqual([
      { path: 'afterDays', message: 'Number must be greater than or equal to 1' }
    ]);
  });

  test('parses multiple issues joined by "; "', () => {
    const message =
      'value for setting "monitors.observation_caps" failed validation (schema version 1): watchlistItemsPerPoll: Expected number, received string; searchItemsPerPoll: Required';
    expect(parseSettingValidationIssues(message)).toEqual([
      { path: 'watchlistItemsPerPoll', message: 'Expected number, received string' },
      { path: 'searchItemsPerPoll', message: 'Required' }
    ]);
  });

  test('maps the bare-schema "(root)" path to the mapping\'s synthetic "value" field name', () => {
    const message =
      'value for setting "auth.onboarding_oidc_prompt_dismissed" failed validation (schema version 1): (root): Expected boolean, received string';
    expect(parseSettingValidationIssues(message)).toEqual([
      { path: 'value', message: 'Expected boolean, received string' }
    ]);
  });

  test('returns null for a message that is not a settings-validation error, so the caller can fall back to a single top-of-form error', () => {
    expect(parseSettingValidationIssues('Network request failed')).toBeNull();
    expect(parseSettingValidationIssues('setting "x" is not registered')).toBeNull();
  });
});
