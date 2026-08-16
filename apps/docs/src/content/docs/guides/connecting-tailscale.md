---
title: Connecting Tailscale
---

[Tailscale](https://tailscale.com) is a mesh VPN. Loxep reads your tailnet's device list to prove the stored credential, count connected devices, and — once you confirm which device is which of your fleet records — show that machine's private-network address and reachability evidence alongside everything else Loxep knows about it.

Loxep never authorizes, removes, tags, or otherwise changes a device. There is no path in the product that touches your tailnet's membership or configuration; it only reads the device list Tailscale's API already exposes to a credential with the right access.

Once connected, `health.sweep` (a five-minute recurring job) proves the credential on its own schedule and keeps the connection's health status current — there is nothing to trigger by hand.

## What you will need

- **Owner, Admin, IT admin, or Network admin** access to the tailnet, to generate a credential.
- **Administrator access** to the Loxep installation.

## Choose a credential mode

Loxep's guided form offers two ways to authenticate, and the dialog **defaults to the OAuth client** as the recommended option:

- **OAuth client (recommended).** A `client_id`/`client_secret` pair. Loxep re-exchanges the short-lived minted access token automatically every hour, so nothing expires and nothing needs renewing by hand.
- **API access token.** Simpler to generate, but it expires on a fixed schedule (up to 90 days, your choice) with no auto-renewal — you are responsible for generating a fresh one before it lapses.

### OAuth client

1. Sign in to the Tailscale admin console as an Owner, Admin, IT admin, or Network admin of the tailnet.
2. Open **Settings → OAuth clients** and generate a new client.
3. Grant it exactly the `devices:core:read` scope. (`devices:core` without the `read` suffix also grants write access — Loxep's read-only-ness is enforced in its own adapter code, not by this scope, but the narrower scope is still the right default.)
4. Copy the client ID and client secret; Tailscale shows the secret once.

### API access token

1. Sign in to the [Tailscale admin console](https://login.tailscale.com/admin/settings/keys).
2. Open the **Keys** page and generate a new **API access token**.
3. Choose an expiry — Tailscale allows up to 90 days, and there is no longer or auto-renewing option for this kind of credential, which is exactly why the OAuth client is the recommended default.
4. Copy the token before leaving the page; Tailscale will not show it again.

:::caution[This token expires — there is no auto-renewal]
An API access token expires on the schedule you chose, and the only way to keep polling working is generating a new one and pasting it into Loxep before (or after) the old one lapses. Loxep can warn you ahead of time — see [Recording and tracking the expiry](#recording-and-tracking-the-expiry) below — but it cannot renew the token itself.
:::

## In Loxep

Sign in as an administrator, go to **Settings → Connections**, and choose **Add Tailscale tailnet**.

Fill in:

- **Tailnet name** — how this tailnet is labelled inside Loxep.
- **Tailnet** — leave blank to use `-`, Tailscale's own shorthand for "the default tailnet of this credential." Only set this if the account belongs to more than one tailnet.
- **OAuth client id / client secret**, or **API access token**, depending on the mode chosen above.
- If you used the API access token mode, an optional **expiry date** field records the date Tailscale showed you when you generated it.
- **Economic entity** — optional business attribution. It records which of your businesses the tailnet belongs to and grants no access of any kind.

Save. The tailnet name is kept as ordinary connection configuration and stays visible; the credential is stored application-encrypted and is never displayed again.

## Recording and tracking the expiry

An API-access-token connection's row on **Settings → Connections** carries a credential-expiry chip:

- **No recorded expiry** shows a warning chip reading "expiry not recorded" — Loxep never shows a false green for a token whose lifetime it does not know. Use the row menu's **Record token expiry** action to add or update the date Tailscale showed you.
- **A recorded expiry** shows the date, turning to a warning tone within 14 days of expiring (or once it has passed).
- An OAuth-client connection shows an "auto-renewing" chip instead — there is nothing to track.

Independently, `health.sweep`'s own probe returns a `degraded` status once a recorded expiry is within that same 14-day window or has passed, even if the stored credential still authenticates — the read succeeding does not mean the recorded date was wrong, only that Loxep cannot yet prove it right or wrong from an HTTP 401 alone.

## What Loxep reads

| Loxep shows | Where it comes from |
|---|---|
| Whether the tailnet API accepted the stored credential | The outcome of the device list read itself — Tailscale publishes no separate identity/whoami endpoint |
| The connection's own status and how many devices the read returned | The tailnet's device list, read on every sweep |
| The tailnet's own devices, on **Infrastructure → Fleet → (a hosting target) → Companion tools → Attach discovered Tailscale device** | The same device list read, kept as candidates until you confirm one |
| A "Private network" row on a linked device's fleet page — its tailnet address(es), online/last-seen, and the age of Loxep's own read | The linked device's latest read, refreshed on every sweep |

Every sweep upserts one record per tailnet device, keyed on its stable `nodeId` (never its name or hostname — neither is unique on Tailscale's side, and a rename never breaks the link once you have confirmed one). A tailnet holds more than just your fleet's own machines — laptops, phones, a contractor's device — so Loxep never guesses which one is which of your hosting targets, and only a device you explicitly confirm through the attach picker gets its own status row. **Loxep never auto-links a device to a hosting target from a name match**, even when one looks obvious; open the fleet record and use the picker.

A device removed from the tailnet, or no longer visible to your credential, does not silently disappear from an ALREADY-linked record — it shows as "unknown" rather than being dropped, since that is a fact worth seeing, not an outage to hide.

## The "Private network" row's reachability caveat

Once a device is linked, its fleet page may show a caveat like *"Loxep reached the Tailscale API, not this host — [tool] here is unknown because the Loxep container is not on this tailnet."* This appears only when ANOTHER companion tool linked to the same host (Beszel, Gatus, Dockhand…) is reading "unknown" in a way that looks like a topology problem, and only while Loxep has never once reached that tool directly. The moment Loxep DOES reach it — even once — the caveat disappears on its own; it is never asserted against evidence.

## A tailnet address is never a DNS address

You are reading this guide because you are about to have a `100.x.y.z` (or `fd7a:115c:a1e0::…`) address for a device, and a hosting target's address field nearby that looks like a natural place to put it. Do not: Loxep never writes, suggests, or pre-fills a hosting target's address from a Tailscale device, and if you paste one in yourself, two things catch it —

- On the **Infrastructure** workspace's fleet detail page for that target, a warning explains the stored address is a private Tailscale address and cannot be published.
- If you try to sync DNS anyway, materialization refuses with an error rather than publishing it.

The reason is simple: a tailnet address only answers for devices already on that tailnet. Publishing it as an A/AAAA record produces a name that resolves to an address the public internet cannot reach — an outage that looks exactly like ordinary DNS propagation lag, which is the hardest kind to diagnose because everything *looks* like it is about to start working. If a host is reachable only over Tailscale, its hosting target's address field should stay empty (or hold whatever public address fronts it); the tailnet address's place is the private-network read this integration is building toward, never a DNS record.

## The estate browser: the whole tailnet in one page

`/infrastructure/estate/$connectionId` — reached from **Settings → Connections**' row action (**Open estate**) or **Infrastructure → Estates** — is a live, read-only view of the WHOLE tailnet, in a single `listDevices()` call: every device, whether it is already linked to a hosting target, already ignored, or neither. This is broader than the fleet page's own candidates panel, which shows only the unlinked remainder — an estate page is the whole connection, laptops and phones included.

Each device row shows its MagicDNS name, hostname, OS, online/offline, last-seen, authorized status, and its tailnet addresses — rendered as plain text, never a clickable or copyable field, for the same reason [A tailnet address is never a DNS address](#a-tailnet-address-is-never-a-dns-address) explains above. A row already linked to a hosting target says so and links to it. An unlinked row offers the same **Link**, **Declare**, and **Ignore** actions the fleet page's candidates panel already offers — this page mounts those exact actions rather than duplicating them, so linking a device works identically no matter which page you started from.

**This page never talks to Tailscale beyond the one read.** Link/Declare/Ignore write only to Loxep's own database (which hosting target a device corresponds to, or that you have chosen to ignore it) — nothing here authorizes, removes, or reconfigures anything on the tailnet itself.

## When it does not work

| Symptom | Usual cause |
|---|---|
| Authentication fails after working for a while | An API access token expired on its chosen schedule. Generate a new one and re-save the connection, or switch to an OAuth client so this stops recurring. |
| "Unreachable from Loxep" | Tailscale's API is a public SaaS endpoint (`api.tailscale.com`); this state usually means the Loxep server itself has no outbound network access. |

## Related

- [Fleet Observability Design](../../architecture/fleet-observability-design/) — the tier disposition for Tailscale and its sibling fleet-companion integrations.
- [Estate Browsers Design](../../architecture/estate-browsers-design/) — the pattern behind the estate browser section above.
- [Connecting Termix](../connecting-termix/) — the SSH-host companion, read the same way.
