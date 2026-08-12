/**
 * Typed application-settings registry and service over
 * `application_settings` (ADR-0016, foundation-schema "Application settings
 * and runtime secrets").
 *
 * Settings are non-secret by definition — secret material belongs in the
 * secrets/credentials services, never here. The table is for genuinely
 * application-level settings, not a substitute for domain tables.
 *
 * Note: `@loxep/domain` deliberately queries through the Drizzle instance's
 * relational query API and primary-key upserts, so it needs no direct
 * `drizzle-orm` dependency of its own.
 */
import { applicationSettings } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import { z } from "zod";
import { createAuditService } from "./audit.ts";
import {
  SettingNotRegisteredError,
  SettingValidationError,
} from "./errors.ts";

export interface SettingDefinition<T> {
  readonly key: string;
  readonly schema: z.ZodType<T>;
  readonly description: string;
  readonly schemaVersion: number;
  readonly defaultValue: T;
}

/**
 * Module-level registry: every setting the application knows about is
 * declared once through {@link defineSetting}. Writes for definitions that
 * did not come from this registry are rejected.
 */
const registry = new Map<string, SettingDefinition<unknown>>();

export function defineSetting<T>(input: {
  key: string;
  schema: z.ZodType<T>;
  description: string;
  schemaVersion: number;
  defaultValue: T;
}): SettingDefinition<T> {
  if (registry.has(input.key)) {
    throw new Error(`setting "${input.key}" is already registered`);
  }
  const definition: SettingDefinition<T> = Object.freeze({
    key: input.key,
    schema: input.schema,
    description: input.description,
    schemaVersion: input.schemaVersion,
    defaultValue: input.defaultValue,
  });
  registry.set(input.key, definition as unknown as SettingDefinition<unknown>);
  return definition;
}

/** Registered keys, primarily for diagnostics/tests. */
export function registeredSettingKeys(): string[] {
  return [...registry.keys()];
}

/**
 * The registered definition for `key`, or `undefined` when nothing declared
 * it.
 *
 * This is how a caller that only has a KEY — an operator editing
 * `/settings/application`, an HTTP request body — reaches the definition that
 * owns the schema. It deliberately returns the registry's own frozen object,
 * because {@link SettingsService.set} identity-checks the definition it is
 * handed: a caller cannot fabricate a definition for an unregistered key, and
 * cannot swap a laxer schema in for a registered one.
 */
export function findRegisteredSetting(
  key: string,
): SettingDefinition<unknown> | undefined {
  return registry.get(key);
}

function assertRegistered<T>(definition: SettingDefinition<T>): void {
  const registered = registry.get(definition.key);
  if (registered !== (definition as unknown)) {
    throw new SettingNotRegisteredError(
      `setting "${definition.key}" is not registered — declare it with defineSetting()`,
    );
  }
}

export interface SettingListEntry {
  key: string;
  description: string;
  schemaVersion: number;
  /** Whether a stored row exists (false → value is the default). */
  isSet: boolean;
  /** Validated stored value, or the default when unset. */
  value: unknown;
  updatedByUserId: string | null;
  updatedAt: Date | null;
}

export interface SettingWriteOptions {
  actorUserId?: string | null;
  requestId?: string | null;
}

export interface SettingsService {
  get: <T>(definition: SettingDefinition<T>) => Promise<T>;
  set: <T>(
    definition: SettingDefinition<T>,
    value: T,
    options: SettingWriteOptions,
  ) => Promise<T>;
  /**
   * Write a setting identified by KEY with a value of unknown shape — the
   * operator-facing write path. The key must be registered
   * ({@link SettingNotRegisteredError}) and the value must satisfy that
   * definition's Zod schema ({@link SettingValidationError}); nothing else is
   * writable through this service. Returns the setting's post-write listing
   * entry, the same shape {@link SettingsService.list} produces.
   */
  setByKey: (
    key: string,
    value: unknown,
    options: SettingWriteOptions,
  ) => Promise<SettingListEntry>;
  list: () => Promise<SettingListEntry[]>;
}

export function createSettingsService(options: {
  db: LoxepDb;
}): SettingsService {
  const { db } = options;

  function parseStored<T>(
    definition: SettingDefinition<T>,
    stored: unknown,
  ): T {
    const result = definition.schema.safeParse(stored);
    if (!result.success) {
      throw new SettingValidationError(
        `stored value for setting "${definition.key}" no longer matches its schema (schema version ${definition.schemaVersion}): ${result.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
          .join("; ")}`,
      );
    }
    return result.data;
  }

  async function get<T>(definition: SettingDefinition<T>): Promise<T> {
    assertRegistered(definition);
    const row = await db.query.applicationSettings.findFirst({
      where: (table, { eq }) => eq(table.key, definition.key),
    });
    if (row === undefined) return definition.defaultValue;
    return parseStored(definition, row.value);
  }

  /**
   * Incoming (operator/caller-supplied) value, validated through the
   * registered schema. Unlike {@link parseStored} this reports Zod's own
   * MESSAGES rather than issue codes: the text is shown to whoever submitted
   * the value, so "expected number, received string" beats `invalid_type`.
   */
  function parseIncoming<T>(
    definition: SettingDefinition<T>,
    value: unknown,
  ): T {
    const result = definition.schema.safeParse(value);
    if (!result.success) {
      throw new SettingValidationError(
        `value for setting "${definition.key}" failed validation (schema version ${definition.schemaVersion}): ${result.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return result.data;
  }

  async function write<T>(
    definition: SettingDefinition<T>,
    value: unknown,
    setOptions: SettingWriteOptions,
  ): Promise<{ value: T; updatedAt: Date; actorUserId: string | null }> {
    assertRegistered(definition);
    // Validate through the registered Zod schema BEFORE any persistence.
    const parsed = parseIncoming(definition, value);
    const actorUserId = setOptions.actorUserId ?? null;
    // Hoisted so the caller can report the row's stored `updated_at` without
    // a follow-up read; the transaction body assigns it.
    let writtenAt = new Date();

    await db.transaction(async (tx) => {
      const previous = await tx.query.applicationSettings.findFirst({
        where: (table, { eq }) => eq(table.key, definition.key),
      });

      const now = new Date();
      writtenAt = now;
      await tx
        .insert(applicationSettings)
        .values({
          key: definition.key,
          value: parsed,
          schemaVersion: definition.schemaVersion,
          updatedByUserId: actorUserId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: applicationSettings.key,
          set: {
            value: parsed,
            schemaVersion: definition.schemaVersion,
            updatedByUserId: actorUserId,
            updatedAt: now,
          },
        });

      const audit = createAuditService({ db: tx });
      await audit.append({
        actorUserId,
        action: previous === undefined ? "settings.create" : "settings.update",
        resourceType: "application_setting",
        resourceId: definition.key,
        before:
          previous === undefined
            ? null
            : { value: previous.value, schemaVersion: previous.schemaVersion },
        after: { value: parsed, schemaVersion: definition.schemaVersion },
        requestId: setOptions.requestId ?? null,
        metadata: { settingKey: definition.key },
      });
    });

    return { value: parsed, updatedAt: writtenAt, actorUserId };
  }

  async function set<T>(
    definition: SettingDefinition<T>,
    value: T,
    setOptions: SettingWriteOptions,
  ): Promise<T> {
    const written = await write(definition, value, setOptions);
    return written.value;
  }

  async function setByKey(
    key: string,
    value: unknown,
    setOptions: SettingWriteOptions,
  ): Promise<SettingListEntry> {
    const definition = findRegisteredSetting(key);
    if (definition === undefined) {
      throw new SettingNotRegisteredError(
        `setting "${key}" is not registered — only settings declared with defineSetting() can be written`,
      );
    }
    const written = await write(definition, value, setOptions);
    return {
      key: definition.key,
      description: definition.description,
      schemaVersion: definition.schemaVersion,
      isSet: true,
      value: written.value,
      updatedByUserId: written.actorUserId,
      updatedAt: written.updatedAt,
    };
  }

  async function list(): Promise<SettingListEntry[]> {
    const definitions = [...registry.values()];
    if (definitions.length === 0) return [];
    const keys = definitions.map((definition) => definition.key);
    const rows = await db.query.applicationSettings.findMany({
      where: (table, { inArray }) => inArray(table.key, keys),
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return definitions.map((definition) => {
      const row = byKey.get(definition.key);
      return {
        key: definition.key,
        description: definition.description,
        schemaVersion: definition.schemaVersion,
        isSet: row !== undefined,
        value:
          row === undefined
            ? definition.defaultValue
            : parseStored(definition, row.value),
        updatedByUserId: row?.updatedByUserId ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  return { get, set, setByKey, list };
}
