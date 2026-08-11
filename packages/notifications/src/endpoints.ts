/**
 * Notification endpoints and rules (loxep-ubx.4) over
 * `notification_endpoints` / `notification_rules` (foundation schema
 * "Notifications").
 *
 * Event detection and delivery are separate concepts (implementation
 * contract): this module only manages WHERE notifications can go and WHICH
 * events should go there; the delivery pipeline lives in `deliver.ts` and
 * transports in `transport.ts`. ntfy is the first provider, not the model.
 *
 * Endpoint tokens are application-level encrypted secrets (ADR-0019): the
 * plaintext token goes through the injected @loxep/domain secrets service
 * under the deterministic logical key `notification_endpoint:<endpoint id>`
 * (purpose `token`), and `notification_endpoints.secret_id` records the
 * `application_secrets` row for referential integrity. Tokens never appear
 * in endpoint rows, listings, or logs.
 */
import {
  notificationEndpoints,
  notificationRules,
} from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import type { SecretsService } from "@loxep/domain";
import { z } from "zod";
import {
  NotificationNotFoundError,
  NotificationValidationError,
} from "./errors.ts";
import { uuidLiteral } from "./sql.ts";

/** ntfy message priorities (https://docs.ntfy.sh — verified 2026-08). */
export const NTFY_PRIORITIES = [
  "min",
  "low",
  "default",
  "high",
  "urgent",
] as const;
export type NtfyPriority = (typeof NTFY_PRIORITIES)[number];

/** Non-secret ntfy endpoint configuration; the token is a secret, not config. */
export const ntfyEndpointConfigSchema = z.strictObject({
  baseUrl: z.url(),
  topic: z
    .string()
    .min(1)
    .regex(/^[-_A-Za-z0-9]+$/, "ntfy topics are [-_A-Za-z0-9]+"),
  priority: z.enum(NTFY_PRIORITIES).optional(),
});
export type NtfyEndpointConfig = z.infer<typeof ntfyEndpointConfigSchema>;

/** Registered endpoint providers; text + TS union, no PG enum. */
export const endpointConfigSchemas = {
  ntfy: ntfyEndpointConfigSchema,
} as const;
export type NotificationProvider = keyof typeof endpointConfigSchemas;

/** Market event types a rule may filter on (mirrors @loxep/market). */
export const MARKET_EVENT_TYPES = [
  "price_changed",
  "price_dropped",
  "restocked",
  "sold_out",
  "quantity_changed",
  "listing_ended",
  "new_listing",
] as const;

export type NotificationEndpointRow =
  typeof notificationEndpoints.$inferSelect;
export type NotificationRuleRow = typeof notificationRules.$inferSelect;

/** Logical application-secret key for an endpoint's token. */
export function endpointSecretKey(endpointId: string): string {
  return `notification_endpoint:${endpointId}`;
}

function validateEndpointConfig(
  provider: string,
  config: unknown,
): Record<string, unknown> {
  if (!Object.hasOwn(endpointConfigSchemas, provider)) {
    throw new NotificationValidationError(
      `unknown notification provider "${provider}" (registered: ${Object.keys(endpointConfigSchemas).join(", ")})`,
    );
  }
  const schema = endpointConfigSchemas[provider as NotificationProvider];
  const result = schema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
      .join("; ");
    throw new NotificationValidationError(
      `invalid "${provider}" endpoint config: ${issues}`,
    );
  }
  return result.data;
}

const createEndpointSchema = z.strictObject({
  provider: z.string().min(1),
  name: z.string().min(1),
  config: z.unknown(),
  enabled: z.boolean().optional(),
  token: z.string().min(1).optional(),
  createdByUserId: z.string().min(1).nullish(),
});

const updateEndpointSchema = z
  .strictObject({
    name: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    config: z.unknown().optional(),
    token: z.string().min(1).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "empty update",
  });

const createRuleSchema = z.strictObject({
  name: z.string().min(1),
  endpointId: z.uuid(),
  enabled: z.boolean().optional(),
  marketEventType: z.enum(MARKET_EVENT_TYPES).nullish(),
  monitorTargetId: z.uuid().nullish(),
  conditions: z.record(z.string(), z.unknown()).optional(),
  createdByUserId: z.string().min(1).nullish(),
});

const updateRuleSchema = z
  .strictObject({
    name: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    marketEventType: z.enum(MARKET_EVENT_TYPES).nullish(),
    monitorTargetId: z.uuid().nullish(),
    conditions: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "empty update",
  });

export type CreateEndpointInput = z.input<typeof createEndpointSchema>;
export type UpdateEndpointInput = z.input<typeof updateEndpointSchema>;
export type CreateRuleInput = z.input<typeof createRuleSchema>;
export type UpdateRuleInput = z.input<typeof updateRuleSchema>;

export interface NotificationService {
  createEndpoint: (
    input: CreateEndpointInput,
  ) => Promise<NotificationEndpointRow>;
  getEndpoint: (endpointId: string) => Promise<NotificationEndpointRow>;
  listEndpoints: () => Promise<NotificationEndpointRow[]>;
  updateEndpoint: (
    endpointId: string,
    patch: UpdateEndpointInput,
  ) => Promise<NotificationEndpointRow>;
  deleteEndpoint: (endpointId: string) => Promise<void>;
  /** Decrypted token for delivery use only — never log or persist it. */
  getEndpointToken: (endpointId: string) => Promise<string | null>;
  createRule: (input: CreateRuleInput) => Promise<NotificationRuleRow>;
  getRule: (ruleId: string) => Promise<NotificationRuleRow>;
  listRules: () => Promise<NotificationRuleRow[]>;
  updateRule: (
    ruleId: string,
    patch: UpdateRuleInput,
  ) => Promise<NotificationRuleRow>;
  deleteRule: (ruleId: string) => Promise<void>;
}

export function createNotificationService(options: {
  db: LoxepDb;
  secrets: SecretsService;
}): NotificationService {
  const { db, secrets } = options;

  async function getEndpoint(
    endpointId: string,
  ): Promise<NotificationEndpointRow> {
    const row = await db.query.notificationEndpoints.findFirst({
      where: (table, { eq }) => eq(table.id, endpointId),
    });
    if (row === undefined) {
      throw new NotificationNotFoundError(
        `unknown notification endpoint "${endpointId}"`,
      );
    }
    return row;
  }

  async function storeToken(
    endpointId: string,
    token: string,
    actorUserId: string | null,
  ): Promise<void> {
    const secret = await secrets.setSecret({
      secretKey: endpointSecretKey(endpointId),
      purpose: "token",
      payload: { token },
      actorUserId,
    });
    // Pointer set via primary-key upsert (row is known to exist).
    await db
      .insert(notificationEndpoints)
      .values({ id: endpointId, provider: "", name: "" })
      .onConflictDoUpdate({
        target: notificationEndpoints.id,
        set: { secretId: secret.id, updatedAt: new Date() },
      });
  }

  async function createEndpoint(
    input: CreateEndpointInput,
  ): Promise<NotificationEndpointRow> {
    const parsed = createEndpointSchema.parse(input);
    const config = validateEndpointConfig(parsed.provider, parsed.config);
    const inserted = await db
      .insert(notificationEndpoints)
      .values({
        provider: parsed.provider,
        name: parsed.name,
        enabled: parsed.enabled ?? true,
        config,
        createdByUserId: parsed.createdByUserId ?? null,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) {
      throw new NotificationNotFoundError(
        "notification endpoint insert returned no row",
      );
    }
    if (parsed.token !== undefined) {
      try {
        await storeToken(row.id, parsed.token, parsed.createdByUserId ?? null);
      } catch (error) {
        // Roll back the half-registered endpoint so a failed secret write
        // never leaves a token-requiring endpoint without its token.
        await db
          .execute(
            `delete from notification_endpoints where id = ${uuidLiteral(row.id)}`,
          )
          .catch(() => undefined);
        throw error;
      }
    }
    return getEndpoint(row.id);
  }

  async function listEndpoints(): Promise<NotificationEndpointRow[]> {
    return db.query.notificationEndpoints.findMany({
      orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
    });
  }

  async function updateEndpoint(
    endpointId: string,
    patch: UpdateEndpointInput,
  ): Promise<NotificationEndpointRow> {
    const parsed = updateEndpointSchema.parse(patch);
    const existing = await getEndpoint(endpointId);

    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.name !== undefined) set["name"] = parsed.name;
    if (parsed.enabled !== undefined) set["enabled"] = parsed.enabled;
    if (parsed.config !== undefined) {
      set["config"] = validateEndpointConfig(existing.provider, parsed.config);
    }
    await db
      .insert(notificationEndpoints)
      .values({ id: existing.id, provider: existing.provider, name: existing.name })
      .onConflictDoUpdate({ target: notificationEndpoints.id, set });

    if (parsed.token !== undefined) {
      if (existing.secretId === null) {
        await storeToken(endpointId, parsed.token, null);
      } else {
        await secrets.rotateSecret(
          endpointSecretKey(endpointId),
          { token: parsed.token },
          {},
        );
      }
    }
    return getEndpoint(endpointId);
  }

  async function deleteEndpoint(endpointId: string): Promise<void> {
    // Rules and deliveries referencing the endpoint RESTRICT the delete;
    // disable the endpoint instead when history must be preserved. The
    // logical application secret (if any) is retained — secret lifecycle
    // stays with the secrets service.
    await getEndpoint(endpointId);
    await db.execute(
      `delete from notification_endpoints where id = ${uuidLiteral(endpointId)}`,
    );
  }

  async function getEndpointToken(endpointId: string): Promise<string | null> {
    const endpoint = await getEndpoint(endpointId);
    if (endpoint.secretId === null) {
      return null;
    }
    const secret = await secrets.getSecretPayload(
      endpointSecretKey(endpointId),
      "token",
    );
    return secret.payload.token;
  }

  async function getRule(ruleId: string): Promise<NotificationRuleRow> {
    const row = await db.query.notificationRules.findFirst({
      where: (table, { eq }) => eq(table.id, ruleId),
    });
    if (row === undefined) {
      throw new NotificationNotFoundError(
        `unknown notification rule "${ruleId}"`,
      );
    }
    return row;
  }

  async function createRule(
    input: CreateRuleInput,
  ): Promise<NotificationRuleRow> {
    const parsed = createRuleSchema.parse(input);
    // The endpoint must exist (FK would enforce; fail with a clearer error).
    await getEndpoint(parsed.endpointId);
    const inserted = await db
      .insert(notificationRules)
      .values({
        name: parsed.name,
        endpointId: parsed.endpointId,
        enabled: parsed.enabled ?? true,
        marketEventType: parsed.marketEventType ?? null,
        monitorTargetId: parsed.monitorTargetId ?? null,
        conditions: parsed.conditions ?? {},
        createdByUserId: parsed.createdByUserId ?? null,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) {
      throw new NotificationNotFoundError(
        "notification rule insert returned no row",
      );
    }
    return row;
  }

  async function listRules(): Promise<NotificationRuleRow[]> {
    return db.query.notificationRules.findMany({
      orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
    });
  }

  async function updateRule(
    ruleId: string,
    patch: UpdateRuleInput,
  ): Promise<NotificationRuleRow> {
    const parsed = updateRuleSchema.parse(patch);
    const existing = await getRule(ruleId);
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.name !== undefined) set["name"] = parsed.name;
    if (parsed.enabled !== undefined) set["enabled"] = parsed.enabled;
    if (parsed.marketEventType !== undefined) {
      set["marketEventType"] = parsed.marketEventType;
    }
    if (parsed.monitorTargetId !== undefined) {
      set["monitorTargetId"] = parsed.monitorTargetId;
    }
    if (parsed.conditions !== undefined) set["conditions"] = parsed.conditions;
    await db
      .insert(notificationRules)
      .values({
        id: existing.id,
        name: existing.name,
        endpointId: existing.endpointId,
      })
      .onConflictDoUpdate({ target: notificationRules.id, set });
    return getRule(ruleId);
  }

  async function deleteRule(ruleId: string): Promise<void> {
    await getRule(ruleId);
    await db.execute(
      `delete from notification_rules where id = ${uuidLiteral(ruleId)}`,
    );
  }

  return {
    createEndpoint,
    getEndpoint,
    listEndpoints,
    updateEndpoint,
    deleteEndpoint,
    getEndpointToken,
    createRule,
    getRule,
    listRules,
    updateRule,
    deleteRule,
  };
}

/** The market-event facts rule matching needs. */
export interface RuleMatchEvent {
  eventType: string;
  monitorTargetId: string | null;
}

/**
 * Enabled rules matching a market event: `market_event_type` matches or is
 * NULL (any type), and `monitor_target_id` matches or is NULL (any target).
 * An event with no monitor target only matches monitor-agnostic rules.
 */
export async function matchRules(
  db: LoxepDb,
  marketEvent: RuleMatchEvent,
): Promise<NotificationRuleRow[]> {
  return db.query.notificationRules.findMany({
    where: (table, { and, or, eq, isNull }) =>
      and(
        eq(table.enabled, true),
        or(
          isNull(table.marketEventType),
          eq(table.marketEventType, marketEvent.eventType),
        ),
        marketEvent.monitorTargetId === null
          ? isNull(table.monitorTargetId)
          : or(
              isNull(table.monitorTargetId),
              eq(table.monitorTargetId, marketEvent.monitorTargetId),
            ),
      ),
    orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
  });
}
