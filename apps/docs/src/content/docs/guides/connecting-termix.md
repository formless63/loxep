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
| **Per-session detail for a linked host** — who is connected, whether it is your own session or shared to you, its permission level, and how long ago it started | A LIVE read of Termix's active-sessions endpoint, made only when you open that host's Fleet detail page — never stored |

Termix publishes no schema for its host-inventory responses, so those fields are read defensively; Loxep degrades a missing field to blank rather than failing the whole call, and a host's own connectivity reading is treated as weak evidence — it can never turn a linked host's status red on its own. Termix's active-sessions response IS fully specified upstream, so the per-session fields below are trusted directly (still parsed defensively, on the general principle that an upstream service can always send something unexpected).

**Linking a host is never automatic.** Termix host names carry no uniqueness guarantee, so — unlike Dockhand, which Loxep does link automatically on an exact name match — you confirm each Termix host yourself: open a hosting target's **Fleet detail** page and use **Companion tools → Attach discovered Termix host** to pick the right one from the list Loxep has seen. Once linked, that row shows the host's status, an "open Termix" link (Termix's own URL patterns per host are not published, so the link opens the instance itself, not a specific host's page), and the session count above.

**Per-session rows (owner-approved 2026-08-15, loxep-4ah).** A linked host's Fleet detail page shows an "Active sessions" panel listing every open session on that host: who it belongs to (your own, or shared to you by another Termix user — shown by their Termix username), whether it is currently connected, its permission level, and its age. This is a deliberate choice, not the previous "count only" design: **the owner's ruling is that Termix is meant to be used by people who trust one another, and the more visibility Loxep can give into who is on which host, the better** — "who is logged in where" is treated as ordinary fleet observability here, not a surveillance surface to redact. The panel is a LIVE, request-scoped read exactly like the containers panel Dockhand connections show: nothing about an individual session is ever stored in Loxep's own database, no history, no "who was on this box last week" — only the count (in the companion-tools row above) is refreshed on the regular five-minute sweep and briefly held in `integration_health`. If you would rather Termix session identity not appear in Loxep at all, do not link that host — an unlinked host's sessions are never read anywhere, including the count.

## The estate browser: every host and every session, instance-wide

`/infrastructure/estate/$connectionId` — reached from **Settings → Connections**' row action (**Open estate**) or **Infrastructure → Estates** — is a live, read-only view of the WHOLE Termix instance, in two calls. Nothing here is stored; each section is stamped with the moment it was read, on every open.

**Hosts.** Every SSH host Termix knows about, instance-wide — not only the ones you have linked to a hosting target. A row already linked says so and links to its fleet page; this section offers no action of its own, it exists purely so you can see the whole inventory in one place.

**Active sessions.** Every open session across every host, instance-wide — the same expansion the per-host Fleet detail panel already made deliberately (see the owner's 2026-08-15 ruling above), extended instance-wide by a second, explicit owner grant (2026-08-16): who is connected (your own session, or another Termix user's, shown by their username), which host, whether it is currently connected, permission level, and age. This is a materially broader view than the per-host panel — "who is logged into anything, anywhere" rather than "who is logged into this one machine" — and it exists because the owner decided that broader visibility is exactly what this integration is for among people who trust one another, the same reasoning that licensed the per-host panel in the first place.

Both sections are the SAME live reads the per-host panel and the fleet page's attach picker already make — nothing here talks to Termix any differently, and nothing here writes to it at all.

## When it does not work

| Symptom | Usual cause |
|---|---|
| Authentication fails with correct-looking credentials | Verify the account can sign in to Termix's own web UI with the same username and password. If Termix reports the password is simply wrong, the stored password is wrong or was changed — update it in **Settings → Connections**. |
| Authentication fails and Termix's own UI says password sign-in is disabled | This Termix instance has turned password authentication off (it is OIDC/SSO-only). No password change on Loxep's side will fix this — the connection stays unusable until Termix issues a machine credential Loxep can use, or the instance re-enables password authentication. |
| Repeated login failures | Termix rate-limits login attempts; wait and re-verify the password before retrying. |
| "Unreachable from Loxep" | The instance is on a private network, behind a tunnel, or on an address your browser can reach and the Loxep server cannot — a network-topology problem, not a credential one. |

## Related

- [Fleet Observability Design](../../architecture/fleet-observability-design/) — the tier disposition for Termix and its sibling fleet-companion integrations.
- [Estate Browsers Design](../../architecture/estate-browsers-design/) — the pattern behind the estate browser section above, and the §8.6 record of the instance-wide sessions grant.
- [Connecting Tailscale](../connecting-tailscale/) — the private-network companion, read the same way.
