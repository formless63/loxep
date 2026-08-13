---
title: Connecting Termix
---

[Termix](https://termix.site) is a self-hosted SSH host and remote-desktop manager. Loxep reads **its SSH host inventory and active terminal sessions**, so the fleet view can show which hosts Termix knows about and terminal-access evidence for them alongside everything else Loxep knows about the same machines.

Loxep never opens a terminal, manages Docker, controls a systemd service, sends a process signal, or touches a file through Termix. Termix's own surface is large — it covers all of those — and Loxep's restraint is enforced entirely in Loxep's own code: no function it exports is capable of any of them, not "capable but unused."

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
| One row per SSH host Termix knows about | Termix's host inventory |
| Best-effort connectivity per host | Termix's host-status read |
| Active terminal sessions, including ones shared with the account by another user | Termix's active-sessions read |

Termix publishes no schema for its host and host-status responses, so a handful of fields here are read defensively and may not appear on every instance or version; Loxep degrades a missing field to blank rather than failing the whole read.

## When it does not work

| Symptom | Usual cause |
|---|---|
| Authentication fails with correct-looking credentials | Verify the account can sign in to Termix's own web UI with the same username and password. |
| Repeated login failures | Termix rate-limits login attempts; wait and re-verify the password before retrying. |
| Host list works, connectivity is blank for every host | Expected on some versions — Termix's status response shape is not published; report it so the adapter's field-name guesses can be corrected. |
| "Unreachable from Loxep" | The instance is on a private network, behind a tunnel, or on an address your browser can reach and the Loxep server cannot — a network-topology problem, not a credential one. |

## Related

- [Fleet Observability Design](../../architecture/fleet-observability-design/) — the tier disposition for Termix and its sibling fleet-companion integrations.
- [Connecting Tailscale](../connecting-tailscale/) — the private-network companion, read the same way.
