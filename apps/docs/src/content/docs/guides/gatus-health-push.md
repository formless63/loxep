---
title: Publishing health to Gatus
---

Every other guide in this section is about Loxep **reading** a service. This one runs the other way: Loxep **pushes** its own health to [Gatus](https://gatus.io), an external-endpoints entry you declare, once every five minutes. Gatus is the one thing in the fleet that is not Loxep, so it is the one thing that can raise the alert Loxep can never raise about its own outage — if the pushes stop arriving, Gatus's own heartbeat notices and alerts, exactly as if a monitored host had gone down.

See [Fleet Observability Design](../../architecture/fleet-observability-design/#publish-loxeps-own-health-outward) for why this direction was chosen over Loxep reading Gatus, and why Loxep never writes Gatus configuration.

## What you will need

- A running Gatus instance you can edit the YAML configuration of.
- **Administrator access** to the Loxep installation.

## What Loxep pushes

Once every five minutes, Loxep sends one `POST` reporting its own overall health, synthesized from every row in `integration_health` — the same rollup `/settings/overview`'s Integration health table reads. If any subject is `failing`, the push reports `success=false` with a short count (`"N subject(s) failing"`, never a subject's own detail); otherwise it reports `success=true`. `duration` is the time Loxep spent computing that summary, not a network round-trip — Gatus displays it, it does not gate alerting on it.

The push's own arrival is a second, independent signal: the mere fact that a push happened at all proves the Loxep process was up to send it. If Loxep's container dies, no push happens, and that silence is what your heartbeat interval below is for.

## Step 1 — declare the endpoint in Gatus

Gatus cannot be configured remotely, and Loxep will never try — the endpoint has to already exist in your own `config.yaml` (or a file under your config directory) before Loxep's pushes will do anything. Add an `external-endpoints` entry:

```yaml
external-endpoints:
  - name: loxep
    group: core
    token: "<a long random bearer token you generate>"
    heartbeat:
      # If no push arrives within this window, Gatus marks the endpoint down
      # and raises its own alert — the whole point of this setup.
      interval: 10m
    alerts:
      - type: ntfy
        description: "Loxep stopped reporting health"
        send-on-resolved: true
```

- **`token`** is a secret you generate (a long random string is fine) — it never comes from Loxep, and Loxep never sees it until you paste it into the form below.
- **`heartbeat.interval`** should comfortably exceed Loxep's five-minute push cadence — `10m` gives one full cycle of slack before Gatus calls it down.
- **`name`** and **`group`** may contain letters, digits, spaces, and the characters `/ _ , . # + &`; Gatus sanitizes all of those to `-` when it builds the endpoint's key, and joins the two sanitized halves with a literal `_`. With the values above the key is `core_loxep`. If your group or endpoint name contains any of those characters, work out the sanitized key from Gatus's own rule rather than guessing — a mismatched key is a silent no-op, not an error.
- Wire `alerts` to your existing ntfy topic (or whatever Gatus already alerts through) the same way every other Gatus endpoint does — Loxep is not in that path at all.

Restart or reload Gatus so it picks up the new endpoint (Gatus polls its config directory for changes every 30 seconds, so a plain edit is usually enough).

## Step 2 — point Loxep at it

Sign in as an administrator and go to **Settings → Application settings**. The **Gatus outward health push** card has four fields:

- **Enabled** — off by default. The push task no-ops every cycle until this is on.
- **Gatus base URL** — your Gatus instance's root, e.g. `https://gatus.example.com`.
- **Endpoint key** — the `<GROUP_NAME>_<ENDPOINT_NAME>` key from Step 1, exactly as Gatus derived it (`core_loxep` for the example above).
- **Push token** — the same token you put in the YAML's `token` field. Write-only: it is stored application-encrypted and never shown again, so a saved form always shows the field blank; leave it empty on a later edit to keep the current token.

Save. Within five minutes the endpoint should show its first result in Gatus's own dashboard.

If this Gatus instance is also connected as a fleet companion (see [Connecting Gatus](../connecting-gatus/)), Loxep's own connection health includes a small mirror of Gatus's opinion of this exact heartbeat endpoint — most usefully, it detects a mismatched **Endpoint key** as a definitive `404`, which used to be a silent no-op. This one endpoint is also deliberately EXCLUDED from that same connection's endpoint discovery: it will never appear in the attach picker and never becomes a linkable resource, on purpose — mixing "Loxep's read of Gatus" with "Gatus's opinion of Loxep" on the same status would create a loop neither side could recover from on its own.

## When it does not work

| Symptom | Usual cause |
|---|---|
| The endpoint never appears in Gatus at all | It was never declared in Gatus's own YAML — Loxep cannot create it. Revisit Step 1. |
| Endpoint exists but never receives a push | The **Endpoint key** in Loxep does not match the sanitized `<GROUP>_<ENDPOINT>` key Gatus actually derived, or the base URL is wrong. |
| Gatus reports `401`/`403` | The stored **Push token** does not match the YAML's `token` field. Re-enter it in both places. |
| Push reports `success=false` | At least one Loxep subject in `integration_health` is `failing` — check `/settings/overview`'s Integration health table for which one, before assuming Gatus itself is misconfigured. |
| The endpoint goes down in Gatus with no obvious cause | The Loxep process stopped, the setting was disabled, or the base URL/token/key drifted. This is the case the heartbeat exists to catch — check the Loxep push task's own logs. |

## Related

- [Fleet Observability Design](../../architecture/fleet-observability-design/) — the self-monitoring argument, and why Loxep never becomes the delivery path for infrastructure alerts.
- [Connecting Beszel](../connecting-beszel/) and [Connecting Dockhand](../connecting-dockhand/) — the other fleet companions, both read the opposite direction from this one.
