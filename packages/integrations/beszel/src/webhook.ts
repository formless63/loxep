/**
 * Beszel alert-evidence normalizer (Phase 8 milestone 7, loxep-ovj.7,
 * `apps/docs/.../fleet-observability-design.md#evidence-ingestion-if-it-ships`).
 *
 * Beszel's alerting is Shoutrrr, and Shoutrrr's `generic://` service is the
 * one target that fits an arbitrary receiver like this one. Verified
 * 2026-08-15 against Shoutrrr's own docs
 * (`containrrr/shoutrrr/blob/main/docs/services/generic.md`) and Beszel's own
 * generic-webhook guide (`beszel.dev/guide/notifications/generic`, which
 * shows the exact worked example this schema mirrors): with
 * `generic://<host>?template=json`, the POST body is
 *
 * ```json
 * { "title": "Foo CPU above threshold", "message": "CPU averaged 63.53% for the previous 10 minutes." }
 * ```
 *
 * — free-text `title`/`message`, with NO structured system id, metric name,
 * or resolved/triggered discriminator; Beszel does not expose Go-template
 * placeholders for those into the generic body the way Gatus's `custom`
 * provider does. That is the honest limit of this shape, not an
 * under-implementation: unlike Gatus, Beszel does not let Loxep dictate a
 * structured contract, so this normalizer accepts the shape Beszel actually
 * sends. Shoutrrr's generic service DOES let an operator append arbitrary
 * `$key=value` query parameters to the webhook URL to inject extra JSON
 * fields (`?template=json&$status=ok`) — {@link beszelAlertWebhookSchema}
 * accepts an OPTIONAL `status` field for exactly that escape hatch, so an
 * operator who wants resolved/triggered fidelity can configure it, while an
 * operator who pastes the bare Beszel-guide URL still gets a working,
 * honestly-labelled `failing` evidence row (a Beszel alert firing at all
 * means something crossed a threshold; there is no "this is fine" variant of
 * the shape Beszel sends unprompted).
 */
import { z } from "zod";

/**
 * The Shoutrrr `generic://…?template=json` body Beszel's own guide
 * documents, plus the optional `$status` escape hatch (see module doc).
 * `.loose()` (not `.strictObject`) because Shoutrrr's `$key=value` mechanism
 * lets an operator append arbitrary extra fields — rejecting them outright
 * would make every future Shoutrrr customization a Loxep schema change.
 */
export const beszelAlertWebhookSchema = z
  .looseObject({
    title: z.string().trim().min(1),
    message: z.string().trim().min(1),
    status: z.enum(["ok", "degraded", "failing"]).optional(),
  });
export type BeszelAlertWebhookPayload = z.infer<typeof beszelAlertWebhookSchema>;

const DETAIL_FIELD_MAX_LENGTH = 300;

function truncate(value: string): string {
  return value.slice(0, DETAIL_FIELD_MAX_LENGTH);
}

/**
 * Structurally identical to `@loxep/domain`'s `FleetEvidenceAccepted` /
 * `FleetEvidenceDropped` / `FleetEvidenceNormalization` — declared
 * independently so this package takes no `@loxep/domain` dependency. See
 * `@loxep/integration-gatus`'s `webhook.ts` for the same note.
 */
export interface BeszelEvidenceAccepted {
  drop: false;
  eventType: string;
  externalEventId: string | null;
  occurredAt: Date;
  status: "ok" | "degraded" | "failing";
  detail: Record<string, unknown>;
}
export interface BeszelEvidenceDropped {
  drop: true;
  reason: "invalid_payload" | "feedback_latch";
  detailMessage: string;
}
export type BeszelEvidenceNormalization =
  | BeszelEvidenceAccepted
  | BeszelEvidenceDropped;

/**
 * Normalize one Beszel/Shoutrrr generic-webhook POST. Never throws — an
 * unparseable body becomes an honest `invalid_payload` drop.
 */
export function normalizeBeszelAlertWebhook(
  payload: unknown,
  options?: { receivedAt?: Date },
): BeszelEvidenceNormalization {
  const parsed = beszelAlertWebhookSchema.safeParse(payload);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
      .join("; ");
    return {
      drop: true,
      reason: "invalid_payload",
      detailMessage: `beszel alert payload failed validation: ${issues}`,
    };
  }
  const alert = parsed.data;
  // No structured resolved/triggered signal in the shape Beszel sends
  // unprompted (see module doc) — `failing` unless the operator's own
  // `$status` field says otherwise.
  const status = alert.status ?? "failing";
  return {
    drop: false,
    eventType: "alert",
    externalEventId: null,
    occurredAt: options?.receivedAt ?? new Date(),
    status,
    detail: {
      kind: "alert",
      title: truncate(alert.title),
      message: truncate(alert.message),
    },
  };
}
