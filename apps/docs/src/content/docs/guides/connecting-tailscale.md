---
title: Connecting Tailscale
---

[Tailscale](https://tailscale.com) is a mesh VPN. Loxep reads your tailnet's device list to prove the stored credential and count connected devices; showing a specific machine's private-network address and reachability evidence alongside everything else Loxep knows about it is designed but not yet built (see the note below).

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

This is a single connection-level status today, not a per-device list: the read proves the credential and counts the tailnet's devices, but Loxep does not yet render one row per device anywhere. Joining an individual device to a specific fleet record (`hosting_target`), so its address and connectivity show up on that record's own page, is designed but not yet built — see the [integrations status page](../../product/integrations-status/) for the current state.

## When it does not work

| Symptom | Usual cause |
|---|---|
| Authentication fails after working for a while | An API access token expired on its chosen schedule. Generate a new one and re-save the connection, or switch to an OAuth client so this stops recurring. |
| "Unreachable from Loxep" | Tailscale's API is a public SaaS endpoint (`api.tailscale.com`); this state usually means the Loxep server itself has no outbound network access. |

## Related

- [Fleet Observability Design](../../architecture/fleet-observability-design/) — the tier disposition for Tailscale and its sibling fleet-companion integrations.
- [Connecting Termix](../connecting-termix/) — the SSH-host companion, read the same way.
