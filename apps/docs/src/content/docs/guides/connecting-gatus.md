---
title: Connecting Gatus
---

[Gatus](https://github.com/TwiN/gatus) is a self-hosted status/uptime monitor. Loxep reads **how many of the endpoints Gatus is already watching are up, and how fresh that claim is** — and links out to Gatus for everything else, the same discipline it applies to [Beszel](../connecting-beszel/).

Loxep never writes to a Gatus instance's configuration. Gatus's endpoints, conditions, and alerting are files the operator authors and Gatus itself hot-reloads every 30 seconds; Loxep only ever reads what is already declared. The one Gatus write path that exists — publishing Loxep's own health outward — is a separate, deliberate feature covered in [Publishing health to Gatus](../gatus-health-push/), not this guide.

Once connected, `health.sweep` (a five-minute recurring job) reads this connection on its own schedule, so the status below stays current without anything to trigger by hand. If you have also set up [Publishing health to Gatus](../gatus-health-push/) and this connection points at the same instance, the read leg additionally checks — as one extra request, at most — that the push's configured endpoint key actually exists on this instance, so a typo in that key no longer fails silently.

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
| `security.oidc` | OIDC only ever grants a browser session cookie — there is no credential a background reader could hold. Loxep cannot make the credential-proving statuses read at all here, so the connection's status instead comes from Gatus's unauthenticated `/health` liveness path. Leave the username/password fields blank. |

Loxep decides which mode applies by probing the instance's own unauthenticated `/api/v1/config` endpoint on every read. **The connection always shows which mode it is reading in.** Silently falling back to a partial view of a status page and calling it a full read is the one failure this integration is designed never to produce — a green dashboard you cannot trust is worse than one that tells you it is only looking at part of the picture.

:::note[OIDC mode reads less]
In `security.basic` or no-security mode, Loxep's connection status is computed from every endpoint's current status in one call, so an endpoint going down is reflected, and that SAME read discovers every endpoint so you can link one to a hosting target (see below). In `security.oidc` mode, Loxep can only confirm the Gatus process itself is alive — it says nothing about individual endpoints, and no discovery happens: linking endpoints to hosting targets currently needs `security.basic` or no security.
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
| Which security mode the instance is in | The unauthenticated `/api/v1/config` probe | Every mode |
| The connection's own status, and how many known endpoints are up vs. failing | `/api/v1/endpoints/statuses`, read on every sweep | No security, or `security.basic` only |
| Whether Gatus itself is reachable at all | Gatus's own unauthenticated `/health` process-liveness path | `security.oidc` only — the one call left once the credential-proving statuses read is unavailable |
| This instance's endpoints, on **Infrastructure → Fleet → (a hosting target) → Companion tools → Attach discovered Gatus endpoint** | The same statuses read, kept as candidates until you confirm one | No security, or `security.basic` only |
| A linked endpoint's own up/down status, on its hosting target's fleet page | The linked endpoint's latest read, refreshed on every sweep | No security, or `security.basic` only |

Every status is rendered with its age, the same discipline [Connecting Beszel](../connecting-beszel/) uses: a status with no visible age is one you would over-trust. Discovery keys each endpoint on its own literal, un-split `key` (Gatus's `<group>_<name>` string, exactly as Gatus reports it) — never a group-name convention, because Gatus's own sanitization is lossy (it collapses several distinct characters to `-` before joining), so no reliable rule could split a key back into its group and name. **Most endpoints on a real instance will never be linked to anything in Loxep, and that is the normal, permanent state** — a Gatus instance commonly watches things that have nothing to do with your own fleet, and Loxep never shows a count or badge nagging you to link the rest.

If you have also set up [Publishing health to Gatus](../gatus-health-push/) and this connection points at the same instance, the endpoint named by that feature's configured key is never offered for linking, never becomes a status of its own, and never appears in the attach picker at all — see the next guide for what Loxep shows about that endpoint instead.

## Alerts stay in Gatus

Gatus's own alerting (`ntfy`, `custom` webhooks, and everything else it supports) is untouched by this connection. Point Gatus's alerting at your existing ntfy topic if you have not already, the same recommendation [Connecting Beszel](../connecting-beszel/) makes, and for the same reason: Loxep runs on infrastructure Gatus may be watching, so routing Gatus's alerts through Loxep would mean the alert most worth receiving is the one that might not arrive.

## When it does not work

| Symptom | Usual cause |
|---|---|
| Connection saves, but every read fails with an authentication error | The instance uses `security.basic` and the username/password below do not match its YAML — or the fields were left blank against a Basic-secured instance. |
| Connection status only ever reflects whether Gatus is alive, never individual endpoints | The instance uses `security.oidc`. This is expected, not a failure — see the note above. |
| "Unreachable from Loxep" | The instance is on a private network, behind a tunnel, or on an address your browser can reach and the Loxep server cannot. This is a network-topology problem, not a credential problem. |

## Related

- [Fleet Observability Design](../../architecture/fleet-observability-design/) — the auth-branch design this connection implements, and why Gatus is the best-integrated tool in the fleet-observability set.
- [Publishing health to Gatus](../gatus-health-push/) — the reverse direction: Loxep's own health, pushed outward to an endpoint you declare.
- [Connecting Beszel](../connecting-beszel/) — the read-only fleet companion this connection's design most closely follows.
