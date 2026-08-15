---
title: Publishing health to Gatus
---

Every other guide in this section is about Loxep **reading** a service. This one runs the other way: Loxep **pushes** its own health to [Gatus](https://gatus.io), an external-endpoints entry you declare, once every five minutes. Gatus is the one thing in the fleet that is not Loxep, so it is the one thing that can raise the alert Loxep can never raise about its own outage — if the pushes stop arriving, Gatus's own heartbeat notices and alerts, exactly as if a monitored host had gone down.

See [Fleet Observability Design](../../architecture/fleet-observability-design/#publish-loxeps-own-health-outward) for why this direction was chosen over Loxep reading Gatus, and why Loxep never writes Gatus configuration.

## What you will need

- A running Gatus instance you can edit the YAML configuration of.
- **Administrator access** to the Loxep installation.

## What Loxep pushes

Loxep supports two modes, chosen by the **What gets published** field in Step 2. Every installation ships in **Single** mode and stays there until you deliberately switch it — nothing about this changes unless you opt in.

### Single (the default)

Once every five minutes, Loxep sends one `POST` reporting its own overall health, synthesized from every row in `integration_health` — the same rollup `/settings/overview`'s Integration health table reads. If any subject is `failing`, the push reports `success=false` with a short count (`"N subject(s) failing"`, never a subject's own detail); otherwise it reports `success=true`. `duration` is the time Loxep spent computing that summary, not a network round-trip — Gatus displays it, it does not gate alerting on it.

### Five facts (opt-in)

Instead of one rollup, Loxep sends FIVE independent pushes every five minutes, one per fact, each to its own `external-endpoints` key **derived** from the base key you declare in Step 1 — `<your key>-<fact>`:

| Fact key suffix | What it reports |
|---|---|
| `-worker-backlog` | The background job queue: fails if any job has permanently exhausted its retries, or the oldest due-but-unstarted job has waited more than 15 minutes. |
| `-sync-freshness` | The worst connection status among order-sync providers (eBay, WooCommerce, Etsy, Reverb, Medusa) — the same figure `/settings/overview` already shows. |
| `-notifications` | Notification deliveries in the last 24 hours: fails if any delivery failed outright. |
| `-drift` | Reconciler drift: unresolved DNS drift findings plus any Dockhand-managed host whose container inventory has drifted from what Loxep declared. |
| `-readiness` | Whether Loxep can reach its own database. A narrower signal than full process readiness — see the design doc's own note on why. |

A fact Loxep could not compute this cycle (for example, before the background worker has ever run) is simply SKIPPED for that push — never reported as a fabricated failure. The base key you configured in Step 1 becomes a **derivation seed only** in this mode: Loxep never pushes to it directly, so it stays free to be an ordinary Gatus endpoint you track independently if you want to.

### Both modes

The push's own arrival is a second, independent signal: the mere fact that a push happened at all proves the Loxep process was up to send it. If Loxep's container dies, no push happens, and that silence is what your heartbeat interval below is for.

## Step 1 — declare the endpoint(s) in Gatus

Gatus cannot be configured remotely, and Loxep will never try — every endpoint has to already exist in your own `config.yaml` (or a file under your config directory) before Loxep's pushes will do anything.

### Single mode: one entry

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

### Five-fact mode: five entries, one per fact

Declare five entries whose sanitized `<group>_<name>` keys match `<your base key>-<fact suffix>` from the table above. Continuing the `core_loxep` example, the five entries sanitize to `core_loxep-worker-backlog`, `core_loxep-sync-freshness`, `core_loxep-notifications`, `core_loxep-drift`, and `core_loxep-readiness`:

```yaml
external-endpoints:
  - name: loxep-worker-backlog
    group: core
    token: "<the SAME bearer token across all five — Loxep stores one token for the whole push>"
    heartbeat:
      interval: 10m
    alerts:
      - type: ntfy
        description: "Loxep: worker backlog"
        send-on-resolved: true
  - name: loxep-sync-freshness
    group: core
    token: "<same token>"
    heartbeat:
      interval: 10m
    alerts:
      - type: ntfy
        description: "Loxep: order-sync freshness"
        send-on-resolved: true
  - name: loxep-notifications
    group: core
    token: "<same token>"
    heartbeat:
      interval: 10m
    alerts:
      - type: ntfy
        description: "Loxep: notification delivery"
        send-on-resolved: true
  - name: loxep-drift
    group: core
    token: "<same token>"
    heartbeat:
      interval: 10m
    alerts:
      - type: ntfy
        description: "Loxep: reconciler drift"
        send-on-resolved: true
  - name: loxep-readiness
    group: core
    token: "<same token>"
    heartbeat:
      interval: 10m
    alerts:
      - type: ntfy
        description: "Loxep: readiness"
        send-on-resolved: true
```

Loxep stores exactly ONE bearer token for the whole installation (in either mode) and sends it on every push, so all five entries must declare the **same** `token` value.

- **`token`** is a secret you generate (a long random string is fine) — it never comes from Loxep, and Loxep never sees it until you paste it into the form below.
- **`heartbeat.interval`** should comfortably exceed Loxep's five-minute push cadence — `10m` gives one full cycle of slack before Gatus calls it down.
- **`name`** and **`group`** may contain letters, digits, spaces, and the characters `/ _ , . # + &`; Gatus sanitizes all of those to `-` when it builds the endpoint's key, and joins the two sanitized halves with a literal `_`. With the single-mode values above the key is `core_loxep`; in five-fact mode, `-worker-backlog` etc. are already hyphen-separated words, so they pass through the sanitizer unchanged, giving `core_loxep-worker-backlog` and so on. If your group or endpoint name contains any of the special characters above, work out the sanitized key from Gatus's own rule rather than guessing — a mismatched key is a silent no-op, not an error.
- Wire `alerts` to your existing ntfy topic (or whatever Gatus already alerts through) the same way every other Gatus endpoint does — Loxep is not in that path at all.

Restart or reload Gatus so it picks up the new endpoint(s) (Gatus polls its config directory for changes every 30 seconds, so a plain edit is usually enough).

## Step 2 — point Loxep at it

Sign in as an administrator and go to **Settings → Application settings**. The **Gatus outward health push** card has five fields:

- **Enabled** — off by default. The push task no-ops every cycle until this is on.
- **Gatus base URL** — your Gatus instance's root, e.g. `https://gatus.example.com`.
- **Endpoint key** — the `<GROUP_NAME>_<ENDPOINT_NAME>` key from Step 1, exactly as Gatus derived it (`core_loxep` for the example above). In five-fact mode this is the DERIVATION SEED for the five fact keys, not a key Loxep pushes to directly.
- **What gets published** — **Single** (the default; today's one-push rollup) or **Five facts** (the OQ9 expansion above). Switching to Five facts does nothing useful until the five matching `external-endpoints` entries exist in your gatus YAML.
- **Push token** — the same token you put in the YAML's `token` field(s). Write-only: it is stored application-encrypted and never shown again, so a saved form always shows the field blank; leave it empty on a later edit to keep the current token.

Save. Within five minutes the endpoint(s) should show their first result in Gatus's own dashboard.

If this Gatus instance is also connected as a fleet companion (see [Connecting Gatus](../connecting-gatus/)), Loxep's own connection health includes a small mirror of Gatus's opinion of the heartbeat endpoint(s) — most usefully, it detects a mismatched **Endpoint key** as a definitive `404`, which used to be a silent no-op (in five-fact mode the mirror reads presence off the same bulk statuses page Loxep already fetches, never five extra requests). Every key Loxep might push to — the single key, or all five derived keys — is also deliberately EXCLUDED from that same connection's endpoint discovery: none of them will ever appear in the attach picker or become a linkable resource, on purpose — mixing "Loxep's read of Gatus" with "Gatus's opinion of Loxep" on the same status would create a loop neither side could recover from on its own. In five-fact mode the base seed key is NOT excluded — it is never pushed to, so it is free to be an ordinary endpoint you track independently.

## When it does not work

| Symptom | Usual cause |
|---|---|
| The endpoint never appears in Gatus at all | It was never declared in Gatus's own YAML — Loxep cannot create it. Revisit Step 1. |
| Endpoint exists but never receives a push | The **Endpoint key** in Loxep does not match the sanitized `<GROUP>_<ENDPOINT>` key Gatus actually derived, or the base URL is wrong. In five-fact mode, check the SPECIFIC fact's derived key against its own YAML entry. |
| Only SOME of the five endpoints receive a push | A fact Loxep could not compute this cycle is skipped, not failed — this is expected occasionally (for example, before the background worker has processed any jobs) and should resolve on a later cycle. |
| Gatus reports `401`/`403` | The stored **Push token** does not match the YAML's `token` field(s). Re-enter it; in five-fact mode, make sure all five YAML entries use the SAME token. |
| Push reports `success=false` | Single mode: at least one Loxep subject in `integration_health` is `failing` — check `/settings/overview`'s Integration health table. Five-fact mode: check which specific fact endpoint went down in Gatus to narrow it to worker backlog, sync freshness, notifications, drift, or readiness. |
| The endpoint goes down in Gatus with no obvious cause | The Loxep process stopped, the setting was disabled, or the base URL/token/key drifted. This is the case the heartbeat exists to catch — check the Loxep push task's own logs. |

## Related

- [Fleet Observability Design](../../architecture/fleet-observability-design/) — the self-monitoring argument, why Loxep never becomes the delivery path for infrastructure alerts, and the OQ9 five-fact expansion's own implementation notes.
- [Connecting Beszel](../connecting-beszel/) and [Connecting Dockhand](../connecting-dockhand/) — the other fleet companions, both read the opposite direction from this one.
