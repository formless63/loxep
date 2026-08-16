---
title: Connecting Beszel
---

[Beszel](https://beszel.dev) is a lightweight server-monitoring hub. Loxep reads **how many of the machines shared with it are up, and how fresh that claim is** — and links out to Beszel for everything else.

That boundary is deliberate and permanent. Loxep does not store, chart, or retain CPU, memory, disk, or network history; Beszel already does that well, and duplicating it would make two systems authoritative about the same numbers. Loxep also never writes to Beszel: there is no path in the product that pauses a system, edits a record, or changes an alert.

Once connected, `health.sweep` (a five-minute recurring job) checks the hub's health and lists its shared systems on its own schedule, so the status below stays current without anything to trigger by hand.

Every sweep also discovers the systems shared with your read-only user, so you can attach one to a specific fleet record — see [Attaching a system to a host](#attaching-a-system-to-a-host) below.

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

Every status is rendered with its age. A status with no visible age is one you would over-trust, so if Loxep cannot say when it last heard from the hub, it says that instead of showing a stale green dot.

## Attaching a system to a host

The same sweep that reads the hub-level status also discovers each individual system your read-only user can see. A discovered system is not automatically linked to anything — Beszel's `name` field is not guaranteed unique or even present, so Loxep never guesses which fleet record a system belongs to.

To attach one:

1. Go to **Infrastructure → Fleet** and open the hosting target you want to attach a system to.
2. In the **Companion tools** panel, choose **Attach discovered Beszel system**.
3. Pick the system that is actually this host from the list — its name, host, and last-reported status are shown as hints, not as a pre-filled guess. Nothing is written until you pick one and confirm.

Once attached, that host's page shows the system's own status string exactly as Beszel reports it (`up`, `down`, `paused`, or whatever a future Beszel release adds), alongside two separate ages: when Beszel itself last updated the record, and when Loxep last read it. A host can have more than one attached system — a machine and a VM running on it, for example — and each is its own row; Loxep never merges them into one verdict. If a linked Gatus endpoint or Dockhand environment is also attached to the same host, each renders its own line: "Beszel (agent) reports up; Gatus (endpoint) reports down" is a diagnosis (the app crashed, not the box), never a single averaged chip.

Detach the same way, from the same panel. Once a system's only link is removed, Loxep drops its discovery record too — there is nothing left pointing at it, so keeping it would be dead weight rather than history. If the system is still shared with your read-only user, the next sweep (within five minutes) discovers it again, and it reappears in the attach picker as a fresh candidate.

## Alerts stay in Beszel

Beszel sends its own alerts through Shoutrrr, which includes native ntfy support — the same transport Loxep uses. Point Beszel's alerts at your existing ntfy topic and host-down notifications arrive on the same phone, in the same app, as Loxep's own.

Deliberately **do not** route Beszel alerts through Loxep. Loxep runs on a machine that Beszel may be monitoring; inserting it as a relay means the alert most worth receiving — the one about the machine that just went down — is the one that would not arrive.

## The estate browser: every system on the hub, not only what you have attached

`/infrastructure/estate/$connectionId` — reached from **Settings → Connections**' row action (**Open estate**) or **Infrastructure → Estates** — is a live, read-only view of the WHOLE hub, in exactly two calls: hub health, then every system the read-only user can see. Nothing here is stored; each section is stamped with the moment it was read, on every open.

Each system row shows its name, host, port, status (Beszel's own string, exactly as it reports it), when it was last updated, and how many accounts it is shared with. A row already attached to a hosting target says so and links to it; an unattached row offers an **Attach** button that opens the same operator-confirmed picker described in [Attaching a system to a host](#attaching-a-system-to-a-host) above, entered from the system's own row instead of the fleet page.

**This page never becomes a metrics dashboard.** There is no drill-in, no per-system detail read, and never a CPU or memory chart — Beszel already does that well, and this page's whole job is showing you what exists, not what it is doing right now.

## When it does not work

| Symptom | Usual cause |
|---|---|
| Connection saves, but the system list is empty | The read-only user has no systems shared with it. Share them in Beszel as an admin. |
| Authentication fails with correct-looking credentials | The account is a PocketBase superuser rather than a Beszel user. Create an ordinary read-only user instead. |
| "Unreachable from Loxep" | The hub is on a private network, behind a tunnel, or on a Tailscale address your browser can reach and the Loxep server cannot. This is a network-topology problem, not a credential problem, and Loxep reports it as its own distinct state rather than as a fleet outage. |
| Fields go blank after a Beszel upgrade | Beszel is pre-1.0 and states that the structure of API data may change in minor releases. Loxep degrades individual fields to blank rather than failing the whole read; report it so the adapter can be updated. |

## Related

- [Fleet Observability Design](../../architecture/fleet-observability-design/) — why Beszel is read-only, and what Loxep is forbidden to store.
- [Estate Browsers Design](../../architecture/estate-browsers-design/) — the pattern behind the estate browser section above.
- [Connecting Dockhand](../connecting-dockhand/) — the container-management companion, which has a narrower but non-empty write surface.
