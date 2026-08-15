---
title: Sending fleet alert evidence to Loxep
---

Every fleet companion in this section is read by, or pushed to, over an outbound connection Loxep owns. This guide is the opposite direction: **your** monitoring or backup tool POSTs to a URL Loxep gives you, and Loxep records it as evidence. This is Loxep's first inbound webhook receiver, and the rule it exists under is strict: **recording is not delivering**. The sending tool must still alert you directly — through ntfy, or whatever it already uses — Loxep is never in that path. See [Fleet Observability Design](../../architecture/fleet-observability-design/#evidence-ingestion-if-it-ships) for the full argument.

## What you will need

- **Administrator access** to the Loxep installation.
- One of: a Gatus instance with alerting configured, a Beszel hub with Shoutrrr notifications configured, Databasus (or any tool that can POST JSON), or anything else that can send a raw HTTP POST.

## Step 1 — create the evidence source in Loxep

Sign in as an administrator and go to **Settings → Connections**. In the **Inbound fleet evidence** panel, click **New evidence source**, name it (e.g. "nightly Databasus backup" or "Gatus alerts"), and pick the sender kind. Loxep creates a dedicated connection for it and mints a bearer token — **shown exactly once**. Copy both the webhook URL and the token before closing the dialog; there is no way to see the token again afterward (a lost token means creating a new source, not recovering the old one).

The webhook URL has the shape:

```text
https://<your-loxep-host>/api/v1/hooks/fleet/<connectionId>
Authorization: Bearer <the minted token>
```

Every request must carry that exact bearer token. A missing or wrong token, and a URL for a connection that does not exist, both fail identically — this is deliberate: the response never tells an attacker which half was wrong.

## Step 2 — configure the sender

### Gatus

Gatus's `custom` alerting provider has no default body of its own — you supply it, and Gatus substitutes the placeholders. Paste this into the `alerts` list of the endpoint(s) you want evidence for:

```yaml
alerts:
  - type: custom
    failure-threshold: 3
    success-threshold: 2
    send-on-resolved: true
    description: "Loxep fleet evidence"
    custom:
      url: "https://<your-loxep-host>/api/v1/hooks/fleet/<connectionId>"
      method: POST
      headers:
        Content-Type: application/json
        Authorization: "Bearer <the minted token>"
      body: |
        {
          "endpointName": "[ENDPOINT_NAME]",
          "endpointGroup": "[ENDPOINT_GROUP]",
          "endpointUrl": "[ENDPOINT_URL]",
          "resultErrors": "[RESULT_ERRORS]",
          "resultConditions": "[RESULT_CONDITIONS]",
          "alertState": "[ALERT_TRIGGERED_OR_RESOLVED]",
          "alertDescription": "[ALERT_DESCRIPTION]"
        }
```

This is the exact JSON contract Loxep publishes — every field is a Gatus placeholder, so there is no schema to reverse-engineer. `alertState` becomes Loxep's `failing` (triggered) or `ok` (resolved) evidence for this connection.

**One endpoint is deliberately off-limits: your own Gatus heartbeat.** If this same Gatus instance also receives [Loxep's outward health push](../gatus-health-push/), do not wire this `custom` alert onto that `external-endpoints` entry. Loxep recognizes and silently drops (never projects) any alert that names its own configured heartbeat endpoint — recording it would close a loop that can never recover on its own (Gatus says the heartbeat is down → Loxep would record its own evidence as failing → the next push reports failing → the heartbeat stays down permanently). Every other endpoint is fine.

### Beszel

Beszel's alerting is [Shoutrrr](https://containrrr.dev/shoutrrr/), and its `generic://` service is the one that fits an arbitrary receiver. In Beszel, go to **Settings → Notifications** and add a webhook URL of this shape:

```text
generic://<your-loxep-host>/api/v1/hooks/fleet/<connectionId>?template=json&@Authorization=Bearer%20<the%20minted%20token>
```

- `template=json` gets you Beszel's documented JSON body: `{"title": "...", "message": "..."}` — free text, since Beszel does not expose structured placeholders the way Gatus does. A Beszel alert firing at all means something crossed a threshold, so Loxep records `failing` evidence for every alert in this shape.
- The `@Authorization=...` query parameter is Shoutrrr's way of adding a request header — `%20` is a URL-encoded space. Double-check your token is URL-encoded if it contains `+`, `/`, or `=`.
- Optional: append `&$status=ok` (or `degraded`/`failing`) if you want to send a specific status explicitly — Loxep honors it when present and falls back to `failing` otherwise.

Enable alerts on the systems you want evidence for, same as any other Shoutrrr target.

### Databasus, and anything else

[Databasus](../../product/companion-services/#databasus) and any tool with a generic outbound webhook can use the same generic JSON contract Loxep publishes for this case — pick **Generic** (or **Databasus**, the same contract under a friendlier label) when creating the evidence source, then configure the sender to `POST` this body:

```json
{
  "status": "failing",
  "message": "nightly backup failed: connection refused",
  "occurredAt": "2026-08-15T03:00:00Z"
}
```

- `status` is required: `ok`, `degraded`, or `failing`.
- `message` is optional, capped at 500 characters — a short label, never a raw log line.
- `occurredAt` is optional (ISO 8601); Loxep uses the receipt time when it is omitted.

## What Loxep does with it

Each accepted POST becomes one `source_events` row (the same durable provenance envelope every provider ingestion uses) and, unless it was dropped, projects `failing`/`degraded`/`ok` into `integration_health` for this evidence source's own connection (`source: 'ingest'`, distinct from a probed or adapter-read status). It never writes a delivery — no ntfy message, no rule match, nothing in `notification_deliveries` — and it never echoes the payload back in its response.

A dropped request still authenticated successfully and still gets a `202` — Loxep chose not to project it (a schema mismatch, or the Gatus heartbeat feedback-latch above), which is different from an authentication failure (`401`) or a malformed body (`400`, not valid JSON at all).

## When it does not work

| Symptom | Usual cause |
|---|---|
| Every request gets `401` | The bearer token does not match, or the connection id in the URL is wrong. Loxep does not distinguish the two in the response on purpose. |
| Requests get `429` | More than 30 requests/minute arrived for this one source — check the sender is not retrying in a tight loop. |
| Requests get `413` | The body is larger than 64KB — this receiver is for alert/status evidence, not logs or metric dumps. |
| A Gatus alert never shows up in Loxep | It matched the excluded heartbeat endpoint (see above), or the JSON body was not pasted exactly as shown. |
| Loxep's evidence connection stays "unknown" forever | No evidence has arrived yet, or every one so far failed to parse — an evidence-only connection has no other health source and never decays on its own when a sender goes quiet (staleness alerting is future work). |

## Related

- [Fleet Observability Design](../../architecture/fleet-observability-design/#evidence-ingestion-if-it-ships) — the self-monitoring argument and the security properties this receiver holds.
- [Publishing health to Gatus](../gatus-health-push/) — the opposite direction, and the heartbeat endpoint this guide's feedback-latch protects.
- [Connecting Beszel](../connecting-beszel/) and [Connecting Gatus](../connecting-gatus/) — the READ side of these same two tools, unaffected by this guide.
