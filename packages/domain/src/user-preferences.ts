/**
 * Durable per-user preferences (loxep-lbj), the per-user sibling of
 * `settings.ts`'s installation-wide `SettingsService`.
 *
 * Same registry discipline as {@link defineSetting}: a preference key is
 * declared once through {@link defineUserPreference} into a module-level
 * registry, and `UserPreferencesService.set` identity-checks the definition
 * it is handed against that registry — a caller cannot fabricate a
 * definition for an unregistered key, and cannot swap a laxer schema in for
 * a registered one. `safeParse` against the registered Zod schema is the
 * SOLE validation authority (loxep-lbj) — there is no separate hand-rolled
 * shape check anywhere in this module.
 *
 * Deliberately smaller than `SettingsService`: no `list()` (there is no
 * generic prefs UI to enumerate for), no audit trail (a user pinning a page
 * is UI state, not the kind of installation-configuration change
 * `audit_events` exists to record — see `settings.ts`'s own audit-on-write
 * for the contrast), and access control is entirely the caller's job: this
 * service takes whatever `userId` it is given and never itself enforces
 * "the caller may only touch their own row" — see `@/server/preferences-functions.ts`
 * in `apps/web` for where that scoping actually happens (`requireSession`,
 * always `session.user.id`, never a client-supplied id).
 */
import { userPreferences } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import { z } from "zod";
import {
  UserPreferenceNotRegisteredError,
  UserPreferenceValidationError,
} from "./errors.ts";

export interface UserPreferenceDefinition<T> {
  readonly key: string;
  readonly schema: z.ZodType<T>;
  readonly defaultValue: T;
}

/**
 * Module-level registry: every user preference the application knows about
 * is declared once through {@link defineUserPreference}. Reads/writes for
 * definitions that did not come from this registry are rejected.
 */
const registry = new Map<string, UserPreferenceDefinition<unknown>>();

export function defineUserPreference<T>(input: {
  key: string;
  schema: z.ZodType<T>;
  defaultValue: T;
}): UserPreferenceDefinition<T> {
  if (registry.has(input.key)) {
    throw new Error(`user preference "${input.key}" is already registered`);
  }
  const definition: UserPreferenceDefinition<T> = Object.freeze({
    key: input.key,
    schema: input.schema,
    defaultValue: input.defaultValue,
  });
  registry.set(input.key, definition as unknown as UserPreferenceDefinition<unknown>);
  return definition;
}

/** Registered keys, primarily for diagnostics/tests. */
export function registeredUserPreferenceKeys(): string[] {
  return [...registry.keys()];
}

/** The registered definition for `key`, or `undefined` when nothing declared it. */
export function findRegisteredUserPreference(
  key: string,
): UserPreferenceDefinition<unknown> | undefined {
  return registry.get(key);
}

function assertRegistered<T>(definition: UserPreferenceDefinition<T>): void {
  const registered = registry.get(definition.key);
  if (registered !== (definition as unknown)) {
    throw new UserPreferenceNotRegisteredError(
      `user preference "${definition.key}" is not registered — declare it with defineUserPreference()`,
    );
  }
}

export interface UserPreferencesService {
  /** The caller's stored value for `definition`, or its `defaultValue` when unset. */
  get: <T>(userId: string, definition: UserPreferenceDefinition<T>) => Promise<T>;
  /**
   * Validates `value` against `definition.schema` (the sole validation
   * authority) before persisting, then upserts the `(userId, key)` row.
   * Throws {@link UserPreferenceValidationError} on a failed parse and
   * {@link UserPreferenceNotRegisteredError} for a definition that did not
   * come from {@link defineUserPreference}.
   */
  set: <T>(
    userId: string,
    definition: UserPreferenceDefinition<T>,
    value: T,
  ) => Promise<T>;
}

export function createUserPreferencesService(options: {
  db: LoxepDb;
}): UserPreferencesService {
  const { db } = options;

  async function get<T>(
    userId: string,
    definition: UserPreferenceDefinition<T>,
  ): Promise<T> {
    assertRegistered(definition);
    const row = await db.query.userPreferences.findFirst({
      where: (table, { and, eq }) =>
        and(eq(table.userId, userId), eq(table.key, definition.key)),
    });
    if (row === undefined) return definition.defaultValue;
    const parsed = definition.schema.safeParse(row.value);
    if (!parsed.success) {
      throw new UserPreferenceValidationError(
        `stored value for user preference "${definition.key}" no longer matches its schema: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
          .join("; ")}`,
      );
    }
    return parsed.data;
  }

  async function set<T>(
    userId: string,
    definition: UserPreferenceDefinition<T>,
    value: T,
  ): Promise<T> {
    assertRegistered(definition);
    const parsed = definition.schema.safeParse(value);
    if (!parsed.success) {
      throw new UserPreferenceValidationError(
        `value for user preference "${definition.key}" failed validation: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    await db
      .insert(userPreferences)
      .values({
        userId,
        key: definition.key,
        value: parsed.data,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [userPreferences.userId, userPreferences.key],
        set: { value: parsed.data, updatedAt: new Date() },
      });
    return parsed.data;
  }

  return { get, set };
}
