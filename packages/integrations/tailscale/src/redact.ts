/**
 * Per-response redactors for the Tailscale boundary (Beszel's
 * `redactBeszelSystem` / Purelymail's precedent).
 *
 * ## The highest-risk value is the OAuth token exchange
 *
 * `POST /api/v2/oauth/token` answers with a live bearer access token.
 * **There is no redactor for it, and that is the design** — no function in
 * this module accepts it, the adapter never summarizes it, and
 * `test/boundary.test.ts` asserts a token with a distinctive marker cannot
 * be found in any error detail or summary the adapter produces.
 *
 * ## What a device summary may carry
 *
 * An allow-list, not a filter. `user` (the device's owning identity — an
 * email address) and every key material field (`nodeKey`, `machineKey`,
 * `tailnetLockKey`) are DELIBERATELY excluded: none of them is needed to
 * answer "is this device online and where is it", and `user` in particular
 * is PII this integration has no business copying into a run-step summary.
 */

export type RedactedSummary = Record<string, unknown>;

function scalar(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** One `Device` record -> a summary safe for run steps and health projections. */
export function redactTailscaleDevice(device: unknown): RedactedSummary {
  const record = (device ?? {}) as Record<string, unknown>;
  return {
    nodeId: scalar(record["nodeId"]) ?? scalar(record["id"]),
    hostname: scalar(record["hostname"]),
    os: scalar(record["os"]),
    connectedToControl:
      typeof record["connectedToControl"] === "boolean"
        ? record["connectedToControl"]
        : null,
    addressCount: Array.isArray(record["addresses"])
      ? record["addresses"].length
      : null,
  };
}

/** A devices-list page -> a summary by count, never by inlining the records. */
export function redactTailscaleDevicePage(devices: unknown[]): RedactedSummary {
  return { deviceCount: devices.length };
}
