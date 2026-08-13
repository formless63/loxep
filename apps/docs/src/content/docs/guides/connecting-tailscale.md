---
title: Connecting Tailscale
---

:::note[Connectable today; the read below does not run yet]
The catalog card and connection form described here exist and work. What does not exist yet is anything that *calls* the adapter: no scheduled probe and no on-demand validate action construct `createTailscaleAdapter` in production, so a saved connection's health shows "unknown (never succeeded)" indefinitely rather than the device reads this page describes. Tracked as `loxep-rf4`. See the [integrations status page](../../product/integrations-status/) for the current, source-checked state of every provider.
:::

[Tailscale](https://tailscale.com) is a mesh VPN. Loxep reads **one row per device in your tailnet — its name, its addresses, and whether it is currently connected** — so the fleet view can show a machine's private-network address and reachability evidence alongside everything else Loxep knows about it.

Loxep never authorizes, removes, tags, or otherwise changes a device. There is no path in the product that touches your tailnet's membership or configuration; it only reads the device list Tailscale's API already exposes to a credential with the right access.

## What you will need

- **Owner, Admin, IT admin, or Network admin** access to the tailnet, to generate a credential.
- **Administrator access** to the Loxep installation.

## Generate an API access token

Tailscale documents two ways to authenticate a machine client. Loxep's guided form uses the simpler of the two:

1. Sign in to the [Tailscale admin console](https://login.tailscale.com/admin/settings/keys).
2. Open the **Keys** page and generate a new **API access token**.
3. Choose an expiry — Tailscale allows up to 90 days, and there is no longer or auto-renewing option for this kind of credential.
4. Copy the token before leaving the page; Tailscale will not show it again.

:::caution[This token expires — there is no auto-renewal]
Tailscale access tokens expire on the schedule you chose, and the only way to keep polling working is generating a new one and pasting it into Loxep before (or after) the old one lapses. When it expires, Loxep reports the connection as unable to authenticate rather than failing silently — that is your signal to come back here and refresh it.
:::

An **OAuth client** (a `client_id`/`client_secret` pair whose minted access tokens refresh automatically every hour) is the better fit for truly unattended long-lived polling, and the adapter supports it — but the guided form does not yet collect one; see [Fleet Observability Design](../../architecture/fleet-observability-design/) for the current state of that follow-up.

## In Loxep

Sign in as an administrator, go to **Settings → Connections**, and choose **Add Tailscale tailnet**.

Fill in:

- **Tailnet name** — how this tailnet is labelled inside Loxep.
- **Tailnet** — leave blank to use `-`, Tailscale's own shorthand for "the default tailnet of this token." Only set this if the account belongs to more than one tailnet.
- **API access token** — the token you just generated.
- **Economic entity** — optional business attribution. It records which of your businesses the tailnet belongs to and grants no access of any kind.

Save. The tailnet name is kept as ordinary connection configuration and stays visible; the token is stored application-encrypted and is never displayed again.

## What Loxep reads

| Loxep shows | Where it comes from |
|---|---|
| Whether the tailnet API accepted the stored credential | The outcome of the device list read itself — Tailscale publishes no separate identity/whoami endpoint |
| One row per device, with hostname and addresses | The tailnet's device list |
| Whether a device is currently connected | The control plane's own connectivity signal for that device |
| When a disconnected device was last seen | The device's own last-seen time, not Loxep's clock |

## When it does not work

| Symptom | Usual cause |
|---|---|
| Authentication fails after working for a while | The access token expired on its chosen schedule. Generate a new one and re-save the connection. |
| Every device shows as disconnected | Unlikely to be a Loxep problem — verify in the Tailscale admin console that devices are actually online. |
| "Unreachable from Loxep" | Tailscale's API is a public SaaS endpoint (`api.tailscale.com`); this state usually means the Loxep server itself has no outbound network access. |

## Related

- [Fleet Observability Design](../../architecture/fleet-observability-design/) — the tier disposition for Tailscale and its sibling fleet-companion integrations.
- [Connecting Termix](../connecting-termix/) — the SSH-host companion, read the same way.
