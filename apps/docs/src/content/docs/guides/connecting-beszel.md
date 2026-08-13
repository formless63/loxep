---
title: Connecting Beszel
---

[Beszel](https://beszel.dev) is a lightweight server-monitoring hub. Loxep reads **how many of the machines shared with it are up, and how fresh that claim is** — and links out to Beszel for everything else.

That boundary is deliberate and permanent. Loxep does not store, chart, or retain CPU, memory, disk, or network history; Beszel already does that well, and duplicating it would make two systems authoritative about the same numbers. Loxep also never writes to Beszel: there is no path in the product that pauses a system, edits a record, or changes an alert.

Once connected, `health.sweep` (a five-minute recurring job) checks the hub's health and lists its shared systems on its own schedule, so the status below stays current without anything to trigger by hand.

:::note[Per-system linking is not built yet]
This connection gives you the hub-level status shown below — is Loxep's stored login accepted, and how many shared systems are up. Linking an individual Beszel system to a specific Loxep fleet record (`hosting_target`), so a system's status shows up on that record's own page, is designed but not yet built. See the [integrations status page](../../product/integrations-status/) for the current state.
:::

## What you will need

- **Admin access** to your Beszel hub, so you can create a user and share systems with it.
- **Administrator access** to the Loxep installation.
- The hub's **root URL** — `https://beszel.example.com`, or `http://192.168.1.10:8090` on a LAN. Not a path inside it.
- Network reachability **from the Loxep server**, which is not the same as from your browser. See [When it does not work](#when-it-does-not-work).

## Create a read-only Beszel user

Beszel has no API keys or access tokens of any kind. What Loxep stores is an ordinary hub login — so the single most important step is making that login a **read-only** one rather than reusing your own account.

1. Sign in to Beszel as an admin.
2. Open the user administration area and **create a new user**, for example `loxep@yourdomain`. Give it a long, unique password from your password manager.
3. Set its role to **read-only**. Beszel's read-only role cannot create systems; it can view systems shared with it and create alerts.
4. **Share the systems you want Loxep to see with that user.** This is the step people miss, and it is the reason a correctly configured connection can still show an empty list — a read-only user sees only what an admin explicitly shared with it.

You control the blast radius here: Loxep sees exactly the machines you shared, and nothing else.

:::caution[Do not use a PocketBase superuser]
Beszel is built on PocketBase, and PocketBase superuser accounts live in a completely separate collection from ordinary Beszel users — changing a user's role to admin does *not* make it a superuser. Loxep authenticates only against the ordinary user collection and will refuse to work with superuser credentials. If you find yourself reaching for the PocketBase admin panel to create this account, you are in the wrong place.
:::

## In Loxep

Sign in as an administrator, go to **Settings → Connections**, and choose **Add Beszel hub**.

Fill in:

- **Hub name** — how the hub is labelled inside Loxep.
- **Hub URL** — the site root, including `https://` and the port if it is non-standard.
- **Beszel user email** and **Password** — the read-only account you just created. The form says "read-only user" rather than "API token" because that is genuinely what it is; there is no token to ask for.
- **Economic entity** — optional business attribution. It records which of your businesses the hub belongs to and grants no access of any kind.

Save. The hub URL is kept as ordinary connection configuration and stays visible; the password is stored application-encrypted and is never displayed again.

## What Loxep reads

| Loxep shows | Where it comes from |
|---|---|
| Whether the hub itself is reachable | Beszel's unauthenticated health path — no credential involved |
| Whether the stored login is accepted, and how many shared systems are up vs. not | The hub's `systems` collection, read on every sweep |
| The age of that status | Loxep's own last-checked time for the connection |

This is a single connection-level status today, not a per-system list: Loxep reads every shared system to compute the up/not-up counts, but does not yet render one row per system anywhere (see the note above). Every status is rendered with its age. A status with no visible age is one you would over-trust, so if Loxep cannot say when it last heard from the hub, it says that instead of showing a stale green dot.

## Alerts stay in Beszel

Beszel sends its own alerts through Shoutrrr, which includes native ntfy support — the same transport Loxep uses. Point Beszel's alerts at your existing ntfy topic and host-down notifications arrive on the same phone, in the same app, as Loxep's own.

Deliberately **do not** route Beszel alerts through Loxep. Loxep runs on a machine that Beszel may be monitoring; inserting it as a relay means the alert most worth receiving — the one about the machine that just went down — is the one that would not arrive.

## When it does not work

| Symptom | Usual cause |
|---|---|
| Connection saves, but the system list is empty | The read-only user has no systems shared with it. Share them in Beszel as an admin. |
| Authentication fails with correct-looking credentials | The account is a PocketBase superuser rather than a Beszel user. Create an ordinary read-only user instead. |
| "Unreachable from Loxep" | The hub is on a private network, behind a tunnel, or on a Tailscale address your browser can reach and the Loxep server cannot. This is a network-topology problem, not a credential problem, and Loxep reports it as its own distinct state rather than as a fleet outage. |
| Fields go blank after a Beszel upgrade | Beszel is pre-1.0 and states that the structure of API data may change in minor releases. Loxep degrades individual fields to blank rather than failing the whole read; report it so the adapter can be updated. |

## Related

- [Fleet Observability Design](../../architecture/fleet-observability-design/) — why Beszel is read-only, and what Loxep is forbidden to store.
- [Connecting Dockhand](../connecting-dockhand/) — the container-management companion, which has a narrower but non-empty write surface.
