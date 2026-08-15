/**
 * Beszel alert-evidence normalizer (Phase 8 milestone 7, loxep-ovj.7): the
 * Shoutrrr `generic://?template=json` shape (title/message), the default
 * `failing` status with the `$status` escape hatch, arbitrary extra
 * `$key=value` fields tolerated (never rejected), and that an invalid
 * payload never throws.
 */
import { describe, expect, it } from "vitest";
import { normalizeBeszelAlertWebhook } from "../src/webhook.ts";

describe("normalizeBeszelAlertWebhook", () => {
  const receivedAt = new Date("2026-08-15T03:00:00.000Z");

  it("normalizes Beszel's own documented worked example to failing evidence", () => {
    const result = normalizeBeszelAlertWebhook(
      {
        title: "Foo CPU above threshold",
        message: "CPU averaged 63.53% for the previous 10 minutes.",
      },
      { receivedAt },
    );
    expect(result).toEqual({
      drop: false,
      eventType: "alert",
      externalEventId: null,
      occurredAt: receivedAt,
      status: "failing",
      detail: {
        kind: "alert",
        title: "Foo CPU above threshold",
        message: "CPU averaged 63.53% for the previous 10 minutes.",
      },
    });
  });

  it("honors an operator-supplied $status escape hatch", () => {
    const result = normalizeBeszelAlertWebhook({
      title: "Foo CPU back to normal",
      message: "CPU averaged 12% for the previous 10 minutes.",
      status: "ok",
    });
    expect(result.drop).toBe(false);
    if (result.drop) throw new Error("expected an accepted result");
    expect(result.status).toBe("ok");
  });

  it("tolerates arbitrary extra $key=value fields Shoutrrr may append", () => {
    const result = normalizeBeszelAlertWebhook({
      title: "Foo CPU above threshold",
      message: "CPU averaged 63.53% for the previous 10 minutes.",
      free: "palestine",
    });
    expect(result.drop).toBe(false);
  });

  it("never throws on a missing title/message — it drops with a reason instead", () => {
    const result = normalizeBeszelAlertWebhook({ message: "no title here" });
    expect(result.drop).toBe(true);
    if (!result.drop) throw new Error("expected a drop");
    expect(result.reason).toBe("invalid_payload");
  });

  it("drops a completely unrelated payload shape", () => {
    const result = normalizeBeszelAlertWebhook({ foo: "bar" });
    expect(result.drop).toBe(true);
  });
});
