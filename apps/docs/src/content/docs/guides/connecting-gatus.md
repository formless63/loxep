---
title: Connecting Gatus
---

:::note[Connectable today; the read below does not run yet]
The catalog card and connection form described here exist, and the read adapter (`createGatusAdapter`) shipped. What does not exist yet is anything that *calls* it: no scheduled probe and no on-demand validate action construct it in production, so a saved connection's health shows "unknown (never succeeded)" indefinitely rather than the endpoint-status reads this page describes. Tracked as `loxep-rf4`. This is the opposite direction from [Publishing health to Gatus](../gatus-health-push/), which already runs on a schedule. See the [integrations status page](../../product/integrations-status/) for the current, source-checked state of every provider.
:::

[Gatus](https://github.com/TwiN/gatus) is a self-hosted status/uptime monitor. Loxep reads **one line per endpoint Gatus is already watching — is it up, and how fresh is that claim** — and links out to Gatus for everything else, the same discipline it applies to [Beszel](../connecting-beszel/).

Loxep never writes to a Gatus instance's configuration. Gatus's endpoints, conditions, and alerting are files the operator authors and Gatus itself hot-reloads every 30 seconds; Loxep only ever reads what is already declared. The one Gatus write path that exists — publishing Loxep's own health outward — is a separate, deliberate feature covered in [Publishing health to Gatus](../gatus-health-push/), not this guide.

## What you will need

- **Administrator access** to the Loxep installation.
- The instance's **root URL** — `https://status.example.com`, or `http://192.168.1.10:8080` on a LAN. Not a path inside it.
- If the instance's YAML declares a `security.basic` block: that username and password. Otherwise, nothing further — see the next section.

## Three security modes, and Loxep handles all three

Gatus's own YAML `security` block decides what Loxep can read, and Loxep works with any of the three states without you telling it which one applies — it asks the instance itself.

| Instance's `security` block | What Loxep does |
|---|---|
| None at all | The read API is fully open. Leave the username/password fields blank. |
| `security.basic` | Loxep sends the username/password below as an ordinary Basic auth header on every read. |
| `security.oidc` | OIDC only ever grants a browser session cookie — there is no credential a background reader could hold. Loxep automatically falls back to Gatus's unauthenticated per-endpoint routes instead, which need no login at all. Leave the username/password fields blank. |

Loxep decides which mode applies by probing the instance's own unauthenticated `/api/v1/config` endpoint on every read. **The connection always shows which mode it is reading in.** Silently falling back to a partial view of a status page and calling it a full read is the one failure this integration is designed never to produce — a green dashboard you cannot trust is worse than one that tells you it is only looking at part of the picture.

:::note[OIDC mode reads less]
In `security.basic` or no-security mode, Loxep reads every endpoint's current status in one call. In `security.oidc` mode, Loxep can only read the uptime and average response time of endpoints whose keys it already knows — the ones your fleet records point at. It cannot discover new endpoints on its own in this mode, because that discovery route is the one behind OIDC.
:::

## In Loxep

Sign in as an administrator, go to **Settings → Connections**, and choose **Add Gatus instance**.

Fill in:

- **Instance name** — how this instance is labelled inside Loxep.
- **Instance URL** — the site root, including `https://` and the port if it is non-standard.
- **Username** and **Password** — only if the instance's YAML declares `security.basic`. Leave both blank otherwise.
- **Economic entity** — optional business attribution. It records which of your businesses the instance belongs to and grants no access of any kind.

Save. The instance URL is kept as ordinary connection configuration and stays visible; a password, if supplied, is stored application-encrypted and is never displayed again.

## What Loxep reads

| Loxep shows | Where it comes from | Which security mode |
|---|---|---|
| Whether Gatus itself is reachable | Gatus's own unauthenticated `/health` process-liveness path | Every mode |
| Which security mode the instance is in | The unauthenticated `/api/v1/config` probe | Every mode |
| One row per endpoint, with its latest status | `/api/v1/endpoints/statuses` | No security, or `security.basic` only |
| Uptime and average response time per known endpoint | The unauthenticated per-endpoint uptime/response-time routes | Every mode — the fallback when OIDC is configured |

Every status is rendered with its age, the same discipline [Connecting Beszel](../connecting-beszel/) uses: a status with no visible age is one you would over-trust.

## Alerts stay in Gatus

Gatus's own alerting (`ntfy`, `custom` webhooks, and everything else it supports) is untouched by this connection. Point Gatus's alerting at your existing ntfy topic if you have not already, the same recommendation [Connecting Beszel](../connecting-beszel/) makes, and for the same reason: Loxep runs on infrastructure Gatus may be watching, so routing Gatus's alerts through Loxep would mean the alert most worth receiving is the one that might not arrive.

## When it does not work

| Symptom | Usual cause |
|---|---|
| Connection saves, but every read fails with an authentication error | The instance uses `security.basic` and the username/password below do not match its YAML — or the fields were left blank against a Basic-secured instance. |
| Connection reads only uptime/response-time, never the full status list | The instance uses `security.oidc`. This is expected, not a failure — see the note above. |
| "Unreachable from Loxep" | The instance is on a private network, behind a tunnel, or on an address your browser can reach and the Loxep server cannot. This is a network-topology problem, not a credential problem. |
| An endpoint you expect to see is missing from uptime/response-time reads | Those routes need the endpoint's exact Gatus key (`<sanitized group>_<sanitized name>`) already known to Loxep — see [Publishing health to Gatus](../gatus-health-push/#step-1--declare-the-endpoint-in-gatus) for the sanitization rule Gatus applies to group/endpoint names. |

## Related

- [Fleet Observability Design](../../architecture/fleet-observability-design/) — the auth-branch design this connection implements, and why Gatus is the best-integrated tool in the fleet-observability set.
- [Publishing health to Gatus](../gatus-health-push/) — the reverse direction: Loxep's own health, pushed outward to an endpoint you declare.
- [Connecting Beszel](../connecting-beszel/) — the read-only fleet companion this connection's design most closely follows.
