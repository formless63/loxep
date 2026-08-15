/**
 * Gatus alert-evidence normalizer (Phase 8 milestone 7, loxep-ovj.7): the
 * key-sanitization rule against the design's own worked example, the
 * TRIGGERED/RESOLVED mapping, the feedback-latch drop, and that an invalid
 * payload never throws.
 */
import { describe, expect, it } from "vitest";
import {
  gatusExternalEndpointKey,
  normalizeGatusAlertWebhook,
} from "../src/webhook.ts";

describe("gatusExternalEndpointKey", () => {
  it("matches the gatus-health-push guide's worked example (core/loxep -> core_loxep)", () => {
    expect(gatusExternalEndpointKey("core", "loxep")).toBe("core_loxep");
  });

  it("sanitizes spaces and the documented punctuation set to '-' independently per half", () => {
    expect(gatusExternalEndpointKey("my group", "endpoint/name")).toBe(
      "my-group_endpoint-name",
    );
    expect(gatusExternalEndpointKey("a,b.c#d+e&f", "x_y")).toBe("a-b-c-d-e-f_x-y");
  });

  it("substitutes an empty group verbatim (a groupless endpoint)", () => {
    expect(gatusExternalEndpointKey("", "loxep")).toBe("_loxep");
  });
});

describe("normalizeGatusAlertWebhook", () => {
  const receivedAt = new Date("2026-08-15T03:00:00.000Z");

  it("maps TRIGGERED to failing evidence", () => {
    const result = normalizeGatusAlertWebhook(
      {
        endpointName: "api",
        endpointGroup: "core",
        endpointUrl: "https://api.example.com/health",
        resultConditions: "[STATUS] == 200",
        alertState: "TRIGGERED",
        alertDescription: "endpoint is down",
      },
      { heartbeatEndpointKey: null, receivedAt },
    );
    expect(result).toEqual({
      drop: false,
      eventType: "alert_triggered",
      externalEventId: null,
      occurredAt: receivedAt,
      status: "failing",
      detail: {
        kind: "alert_triggered",
        endpointGroup: "core",
        endpointName: "api",
        resultConditions: "[STATUS] == 200",
      },
    });
  });

  it("maps RESOLVED to ok evidence", () => {
    const result = normalizeGatusAlertWebhook(
      { endpointName: "api", endpointGroup: "core", alertState: "RESOLVED" },
      { heartbeatEndpointKey: null, receivedAt },
    );
    expect(result.drop).toBe(false);
    if (result.drop) throw new Error("expected an accepted result");
    expect(result.status).toBe("ok");
    expect(result.eventType).toBe("alert_resolved");
  });

  it("drops an alert about the configured Gatus heartbeat endpoint (the feedback-latch)", () => {
    const result = normalizeGatusAlertWebhook(
      { endpointName: "loxep", endpointGroup: "core", alertState: "TRIGGERED" },
      { heartbeatEndpointKey: "core_loxep", receivedAt },
    );
    expect(result.drop).toBe(true);
    if (!result.drop) throw new Error("expected a drop");
    expect(result.reason).toBe("feedback_latch");
    expect(result.detailMessage).toContain("heartbeat");
  });

  it("does not latch on an endpoint whose key merely resembles the heartbeat key", () => {
    const result = normalizeGatusAlertWebhook(
      { endpointName: "loxep-two", endpointGroup: "core", alertState: "TRIGGERED" },
      { heartbeatEndpointKey: "core_loxep", receivedAt },
    );
    expect(result.drop).toBe(false);
  });

  it("never throws on an invalid payload — it drops with a reason instead", () => {
    const result = normalizeGatusAlertWebhook(
      { endpointName: "api", alertState: "SOMETHING_ELSE" },
      { heartbeatEndpointKey: null, receivedAt },
    );
    expect(result.drop).toBe(true);
    if (!result.drop) throw new Error("expected a drop");
    expect(result.reason).toBe("invalid_payload");
  });

  it("rejects an unrecognized field (Loxep dictates the exact contract)", () => {
    const result = normalizeGatusAlertWebhook(
      {
        endpointName: "api",
        endpointGroup: "core",
        alertState: "TRIGGERED",
        somethingUnexpected: "value",
      },
      { heartbeatEndpointKey: null, receivedAt },
    );
    expect(result.drop).toBe(true);
  });
});
