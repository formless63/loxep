/**
 * Gatus alert-evidence normalizer (Phase 8 milestone 7, loxep-ovj.7,
 * `apps/docs/.../fleet-observability-design.md#evidence-ingestion-if-it-ships`).
 *
 * Gatus's `custom` alerting provider has NO default body: the operator
 * supplies the URL, method, headers, and body template, and Gatus
 * substitutes `[ENDPOINT_NAME]`, `[ENDPOINT_GROUP]`, `[ENDPOINT_URL]`,
 * `[RESULT_ERRORS]`, `[RESULT_CONDITIONS]`, `[ALERT_TRIGGERED_OR_RESOLVED]`,
 * `[ALERT_DESCRIPTION]` into it — verified against `github.com/TwiN/gatus`
 * v5.36.0 (`alerting/provider/custom`), the same source trail every other
 * fact in this package is verified against. Because Gatus supplies no schema
 * of its own here, **Loxep publishes the exact JSON contract it wants** (this
 * module's {@link gatusAlertWebhookSchema}) and documents the snippet to
 * paste, rather than parsing someone else's schema — the cleanest webhook
 * relationship in the whole candidate set, per the design.
 *
 * ## The feedback-latch (BINDING RULE, mirrors `@loxep/app`'s
 * `gatusPushHeartbeatDetail`)
 *
 * `@loxep/app`'s `gatus-push.ts` publishes Loxep's own overall health OUT to
 * one Gatus `external-endpoints` entry, named by the operator's
 * `infrastructure.gatus_push.endpointKey` setting — the mechanism that lets
 * Gatus watch Loxep for the one outage Loxep cannot report on itself. If the
 * operator ALSO wires Gatus's alerting on that exact endpoint back into this
 * inbound receiver, the loop closes on itself: Gatus says the heartbeat is
 * down -> Loxep would record `failing` evidence about ITS OWN heartbeat ->
 * the next outward push reports `failing` (worst-of-all) -> the endpoint
 * stays down, permanently, with no way for a real recovery elsewhere to ever
 * show green again. {@link normalizeGatusAlertWebhook} refuses to normalize
 * an alert whose `(endpointGroup, endpointName)` combine — via Gatus's own,
 * verified key-sanitization rule — to the caller-supplied
 * `heartbeatEndpointKey`, returning a `feedback_latch` drop instead. The
 * caller resolves that key from `@loxep/domain`'s `gatusPushSetting` BEFORE
 * calling this function; this module takes it as a plain string so the
 * integration boundary stays free of a settings-service dependency.
 */
import { z } from "zod";

/**
 * Gatus's own key-sanitization rule (`config/endpoint/result.go`-adjacent
 * key-building logic), verified 2026-08-13 against `github.com/TwiN/gatus`
 * v5.36.0 and already load-bearing in `@loxep/app`'s outward push
 * (`gatus-push.ts`'s module doc cites the same rule): replace ` `, `/`, `_`,
 * `,`, `.`, `#`, `+`, and `&` with `-` in the group and endpoint name
 * independently, THEN join the two with a literal `_`. This is a forward-only
 * function — Gatus's own design doc records that the join is lossy and
 * non-injective — so it is used here only to COMPUTE the key an alert's
 * group/name pair would produce, never to recover a group/name from a key.
 */
const GATUS_KEY_SANITIZE_PATTERN = /[ /_,.#+&]/gu;

function sanitizeGatusKeyPart(value: string): string {
  return value.replaceAll(GATUS_KEY_SANITIZE_PATTERN, "-");
}

/** The external-endpoint key Gatus would assign to `(group, name)`. */
export function gatusExternalEndpointKey(group: string, name: string): string {
  return `${sanitizeGatusKeyPart(group)}_${sanitizeGatusKeyPart(name)}`;
}

/**
 * The JSON contract Loxep publishes for the operator's Gatus `custom`
 * alerting provider body template. Every field maps directly to one of
 * Gatus's documented placeholders (named in each field's comment) —
 * `endpointGroup` may legitimately be empty (an endpoint with no configured
 * `group`), everything else is required because Gatus always substitutes a
 * value for it.
 */
export const gatusAlertWebhookSchema = z.strictObject({
  /** `[ENDPOINT_NAME]` */
  endpointName: z.string().trim().min(1),
  /** `[ENDPOINT_GROUP]` — Gatus substitutes an empty string for a groupless endpoint. */
  endpointGroup: z.string().trim().default(""),
  /** `[ENDPOINT_URL]` */
  endpointUrl: z.string().trim().min(1).optional(),
  /** `[RESULT_ERRORS]` */
  resultErrors: z.string().trim().optional(),
  /** `[RESULT_CONDITIONS]` */
  resultConditions: z.string().trim().optional(),
  /** `[ALERT_TRIGGERED_OR_RESOLVED]` */
  alertState: z.enum(["TRIGGERED", "RESOLVED"]),
  /** `[ALERT_DESCRIPTION]` */
  alertDescription: z.string().trim().optional(),
});
export type GatusAlertWebhookPayload = z.infer<typeof gatusAlertWebhookSchema>;

const DETAIL_FIELD_MAX_LENGTH = 300;

function truncate(value: string): string {
  return value.slice(0, DETAIL_FIELD_MAX_LENGTH);
}

/**
 * Structurally identical to `@loxep/domain`'s `FleetEvidenceAccepted` /
 * `FleetEvidenceDropped` / `FleetEvidenceNormalization` — declared
 * independently rather than imported so this package takes no
 * `@loxep/domain` dependency (matching every sibling adapter's "integration
 * packages must not depend on each other, or on the domain layer" rule).
 * `@loxep/app`'s `fleet-evidence.ts` already depends on both and treats the
 * two as the same shape structurally (TypeScript's structural typing accepts
 * this without a shared nominal type).
 */
export interface GatusEvidenceAccepted {
  drop: false;
  eventType: string;
  externalEventId: string | null;
  occurredAt: Date;
  status: "ok" | "degraded" | "failing";
  detail: Record<string, unknown>;
}
export interface GatusEvidenceDropped {
  drop: true;
  reason: "invalid_payload" | "feedback_latch";
  detailMessage: string;
}
export type GatusEvidenceNormalization =
  | GatusEvidenceAccepted
  | GatusEvidenceDropped;

export interface NormalizeGatusAlertWebhookOptions {
  /**
   * `(gatusPushSetting.endpointKey ?? null)` — resolved by the caller. `null`
   * when the outward push is unconfigured, in which case no endpoint can
   * possibly be the heartbeat and the latch never fires.
   */
  heartbeatEndpointKey: string | null;
  /** Defaults to now; tests pin it. */
  receivedAt?: Date;
}

/**
 * Normalize one Gatus `custom`-provider alert POST. Never throws — an
 * unparseable body becomes an honest drop (`invalid_payload`), matching
 * every sibling normalizer's contract (`@loxep/domain`'s
 * `normalizeGenericEvidenceWebhook`, `@loxep/integration-beszel`'s
 * `normalizeBeszelAlertWebhook`).
 */
export function normalizeGatusAlertWebhook(
  payload: unknown,
  options: NormalizeGatusAlertWebhookOptions,
): GatusEvidenceNormalization {
  const parsed = gatusAlertWebhookSchema.safeParse(payload);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
      .join("; ");
    return {
      drop: true,
      reason: "invalid_payload",
      detailMessage: `gatus alert payload failed validation: ${issues}`,
    };
  }
  const alert = parsed.data;

  const key = gatusExternalEndpointKey(alert.endpointGroup, alert.endpointName);
  if (
    options.heartbeatEndpointKey !== null &&
    key === options.heartbeatEndpointKey
  ) {
    return {
      drop: true,
      reason: "feedback_latch",
      detailMessage:
        "dropped: alert references Loxep's own Gatus heartbeat endpoint " +
        "(infrastructure.gatus_push.endpointKey) — recording it would " +
        "close a self-latching loop with the outward health push",
    };
  }

  const triggered = alert.alertState === "TRIGGERED";
  return {
    drop: false,
    eventType: triggered ? "alert_triggered" : "alert_resolved",
    externalEventId: null,
    occurredAt: options.receivedAt ?? new Date(),
    status: triggered ? "failing" : "ok",
    detail: {
      kind: triggered ? "alert_triggered" : "alert_resolved",
      endpointGroup: truncate(alert.endpointGroup),
      endpointName: truncate(alert.endpointName),
      ...(alert.resultConditions === undefined
        ? {}
        : { resultConditions: truncate(alert.resultConditions) }),
    },
  };
}
