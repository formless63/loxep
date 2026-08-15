---
title: Connecting Termix
---

[Termix](https://termix.site) is a self-hosted SSH host and remote-desktop manager. Loxep signs in to prove the stored login and, best-effort, counts the SSH hosts Termix knows about. It also discovers each Termix host as its own tracked resource you can link to a hosting target — see "What Loxep reads" below for exactly what that link does and does not give you.

Loxep never opens a terminal, manages Docker, controls a systemd service, sends a process signal, or touches a file through Termix. Termix's own surface is large — it covers all of those — and Loxep's restraint is enforced entirely in Loxep's own code: no function it exports is capable of any of them, not "capable but unused."

Once connected, `health.sweep` (a five-minute recurring job) signs in and re-checks the current-user identity on its own schedule, so the connection's health status stays current without anything to trigger by hand.

## What you will need

- A **Termix user account** you are comfortable having Loxep sign in as (see the caution below).
- **Administrator access** to the Loxep installation.
- Your Termix instance's **front-door URL** — the single reverse-proxied origin you sign in to, not one of its internal service ports.

## Choose a Termix account for Loxep

Termix publishes no scoped API token and no read-only role for its API — only an ordinary username/password login. That means the account you give Loxep is a real Termix user, and the safety Loxep offers comes from what it never *asks* Termix to do, not from what the account is *permitted* to do.

:::caution[Termix has no read-only role]
Unlike some of Loxep's other fleet companions, there is no narrower Termix account to create here. Loxep only ever calls Termix's host-list, host-status, session-list, and identity endpoints — never a terminal, Docker, or file action — but that restraint lives in Loxep's adapter code, not in anything this account's permissions withhold. Choose an account accordingly.
:::

## In Loxep

Sign in as an administrator, go to **Settings → Connections**, and choose **Add Termix instance**.

Fill in:

- **Instance name** — how this instance is labelled inside Loxep.
- **Instance URL** — the front-door URL, including `https://` (or `http://` for a LAN-only instance) and the port if it is non-standard.
- **Username** and **Password** — the account you chose above.
- **Economic entity** — optional business attribution. It records which of your businesses the instance belongs to and grants no access of any kind.

Save. The instance URL is kept as ordinary connection configuration and stays visible; the password is stored application-encrypted and is never displayed again. Loxep exchanges it for a short-lived session token on each poll and does not store that token.

## What Loxep reads

| Loxep shows | Where it comes from |
|---|---|
| Whether the stored login was accepted | Termix's own current-user identity endpoint |
| The connection's own status, and — best-effort, never affecting that status — how many SSH hosts Termix reports | Termix's own current-user check, then a best-effort read of its host inventory |
| Each Termix host, as a candidate you can link to a hosting target | The same host-inventory read, tracked as its own resource |
| A linked host's status, and a best-effort count of active terminal sessions on it | The same read, projected only for hosts you have linked |

Termix publishes no schema for its host-inventory or session responses, so fields are read defensively; Loxep degrades a missing field to blank rather than failing the whole call, and a host's own connectivity reading is treated as weak evidence — it can never turn a linked host's status red on its own.

**Linking a host is never automatic.** Termix host names carry no uniqueness guarantee, so — unlike Dockhand, which Loxep does link automatically on an exact name match — you confirm each Termix host yourself: open a hosting target's **Fleet detail** page and use **Companion tools → Attach discovered Termix host** to pick the right one from the list Loxep has seen. Once linked, that row shows the host's status, an "open Termix" link (Termix's own URL patterns per host are not published, so the link opens the instance itself, not a specific host's page), and the session count above.

**Active sessions are a count, never a list.** Loxep does not show who is connected to what, or from where — session identity is a different, more sensitive kind of data than fleet observability, and Termix's own UI is the place to see it. A session count is context ("someone has an active shell on this host right now"), not a health signal: zero sessions does not mean the host is fine, and a session does not mean the host is reachable from Loxep.

## When it does not work

| Symptom | Usual cause |
|---|---|
| Authentication fails with correct-looking credentials | Verify the account can sign in to Termix's own web UI with the same username and password. If Termix reports the password is simply wrong, the stored password is wrong or was changed — update it in **Settings → Connections**. |
| Authentication fails and Termix's own UI says password sign-in is disabled | This Termix instance has turned password authentication off (it is OIDC/SSO-only). No password change on Loxep's side will fix this — the connection stays unusable until Termix issues a machine credential Loxep can use, or the instance re-enables password authentication. |
| Repeated login failures | Termix rate-limits login attempts; wait and re-verify the password before retrying. |
| "Unreachable from Loxep" | The instance is on a private network, behind a tunnel, or on an address your browser can reach and the Loxep server cannot — a network-topology problem, not a credential one. |

## Related

- [Fleet Observability Design](../../architecture/fleet-observability-design/) — the tier disposition for Termix and its sibling fleet-companion integrations.
- [Connecting Tailscale](../connecting-tailscale/) — the private-network companion, read the same way.
