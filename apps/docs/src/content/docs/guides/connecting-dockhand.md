---
title: Connecting Dockhand
---

[Dockhand](https://finsys-dockhand.mintlify.app) manages Docker hosts, containers, and Compose stacks. Loxep connects to it for two things, and the difference between them is the whole design:

- **Reading.** Loxep signs in and, on every `health.sweep` cycle (five minutes), proves the credential, counts the hosts Dockhand manages, and discovers each managed host (Dockhand calls it an "environment") as its own tracked resource with its own status. This is live today — see "What the sweep discovers" below.
- **Registering hosts.** Loxep can, by design, add a machine to Dockhand's inventory and keep its connection settings in step — the same declared-intent-and-reconcile relationship Loxep has with DNS. **This half is designed but not yet built:** there is no registration form in the product yet, and nothing calls `planContainerHostOperations` outside its own tests. See the [integrations status page](../../product/integrations-status/) for the current state. The "Registering a host from Loxep" section further down describes the intended flow, not something you can do today.

**Loxep never starts, stops, restarts, execs into, deploys, or redeploys anything.** Those buttons live in Dockhand, where they belong, with your own session and Dockhand's own permissions. This is not a feature gap to be filled later: it is a boundary the codebase enforces with a test that fails if an adapter ever grows a lifecycle call.

## What you will need

- **Admin access** to Dockhand, so you can create a user and assign permissions.
- **Administrator access** to the Loxep installation.
- Dockhand's **root URL** — `https://dockhand.example.com`, or `http://192.168.1.10:3000` on a LAN. If you paste a URL ending in `/api`, Loxep strips it for you.
- Network reachability **from the Loxep server**, which is not the same as from your browser.

## Create a Dockhand user for Loxep

Dockhand publishes no API keys, personal access tokens, or service accounts — its API authenticates with a session cookie obtained by logging in. So Loxep stores a real username and password, which makes the account you choose the security boundary.

1. Sign in to Dockhand as an admin.
2. **Create a new local user** for Loxep, for example `loxep`. Give it a long, unique password from your password manager.
3. Grant it exactly these permissions, and no others:

   | Permission | Why Loxep needs it |
   |---|---|
   | `environments:view` | Read the list of managed hosts — this is what powers the connection's health status and per-environment discovery today |
   | `environments:edit` | Register and update hosts — reserved for the not-yet-built registration feature described below |
   | `containers:view` | Read per-host container state — powers the live Containers panel on a linked fleet-detail page |
   | `stacks:view` | Read per-host stack state — powers the same panel's Stacks list |

All four are still worth granting now: the account is a one-time setup, and Loxep never asks for more than these regardless of which reads are wired yet.

:::caution[Do not reuse your own admin account]
A Dockhand session that can list containers can also start and stop them. Loxep's restraint is enforced in Loxep's own code, not by Dockhand's session — so a stored admin credential would be a much larger secret than the integration needs. Use a purpose-made account.
:::

:::caution[Typos lock the account out]
Dockhand rate-limits authentication at five failed attempts per IP and username, with a lockout that backs off up to a minute. A wrong password saved in Loxep does not just fail once; it can lock that username out for everything using it. Loxep fails loudly and stops rather than retrying in a loop, but it is worth getting right the first time.
:::

If you leave `environments:edit` off, reading still works and host registration is simply unavailable.

## In Loxep

Sign in as an administrator, go to **Settings → Connections**, and choose **Add Dockhand instance**.

Fill in:

- **Instance name** — how the instance is labelled inside Loxep.
- **Instance URL** — the site root, including `https://` and the port if it is non-standard.
- **Username** and **Password** — the account you just created.
- **Economic entity** — optional business attribution. It records which of your businesses the instance belongs to and grants no access of any kind.

Save. The instance URL is kept as ordinary connection configuration and stays visible; the password is stored application-encrypted and is never displayed again.

## What the sweep discovers

Every five minutes, alongside the connection's own health check, Loxep also lists Dockhand's managed environments and tracks each one as its own resource — the same mechanism Beszel's per-system status uses. On the **Fleet detail** page for a hosting target:

- If a Dockhand environment's name matches the hosting target's name exactly and nothing has claimed it yet, Loxep links them automatically the first time it sees the match. This is the one case in the fleet where Loxep auto-links rather than asking you to confirm — Dockhand's environment names and Loxep's hosting-target names are each guaranteed unique, so an exact match is unambiguous. A rename on either side breaks the automatic match; use **Companion tools → Attach discovered Dockhand environment** on the fleet-detail page to reconnect it, or re-align the two names.
- Each linked environment gets its own status in the **Companion tools** panel, distinct from the connection's own status. Because Dockhand's own inventory listing does not prove a host is actually reachable right now (only that Dockhand knows about it), an environment reads "unknown" unless it uses a Hawser agent that has actually reported in — Loxep does not invent a green checkmark it cannot back up.

## The Containers panel

When a hosting target has a linked Dockhand environment, its fleet-detail page grows a **Containers** panel listing that host's containers and Compose stacks — name, image, state, and status, each read live from Dockhand at the moment you open the page. Nothing here is stored: there is no history, no chart, and no "last seen" timestamp older than the page load, because there is nothing to refresh on a schedule. Nothing here is a control, either — no start, stop, restart, or any other button that would act on the host. If you need to act on a container, the panel does not offer to; open Dockhand itself with your own session.

## Registering a host from Loxep

:::note[Designed, not yet built]
Nothing below this point exists in the running product yet — there is no registration form in Loxep today, and `planContainerHostOperations`, the function that would apply these changes to Dockhand, has no caller outside its own tests. This section documents the intended design so the permission you granted above (`environments:edit`) makes sense; see the [integrations status page](../../product/integrations-status/) for the current state.
:::

Dockhand calls a managed Docker host an **environment**. Loxep calls it a hosting target. They are the same thing, and Loxep is designed to create and update the Dockhand side of it.

This is the one place Loxep writes to Dockhand, and it is worth being precise about why it is allowed when starting a container is not: registering a host writes a row in Dockhand's own database describing how to reach a machine. **Nothing executes on that machine.** Starting a container runs code on it. That is the line.

Four connection types are available, matching Dockhand's own:

| Type | What it needs |
|---|---|
| **Socket** | A socket path — the local default, `/var/run/docker.sock` |
| **Direct** | A host, port, and protocol, with optional TLS material |
| **Hawser standard** | A Hawser agent token — HTTP with token authentication |
| **Hawser edge** | A Hawser agent token — WebSocket, for NAT traversal and edge deployments |

Two behaviours to know about:

- **Hosts are matched by name, once, and then by Dockhand's own id from then on.** The first time Loxep sees a Dockhand environment whose name matches a hosting target's name, it records that link (see "What the sweep discovers" above) and remembers Dockhand's id for it — name matching is a one-time bootstrap, not something repeated on every sweep. If you rename a host in either system after that, Loxep shows the Dockhand-side host as unmatched rather than silently registering a duplicate — rename it on both sides to reconnect them, or use the attach picker.
- **Loxep never deletes a Dockhand host.** Decommissioning a machine in Loxep stops Loxep reconciling it; removing it from Dockhand's inventory is your decision to make in Dockhand.

TLS material and Hawser tokens are **write-only**: Loxep can send them when you register or update a host, and can never read them back. Everywhere a certificate or token would appear, Loxep records only whether one is configured — so a private key cannot end up in a log, a diff, or an error message.

## When it does not work

| Symptom | Usual cause |
|---|---|
| Authentication fails, then keeps failing | The account may be locked out from repeated attempts. Wait a minute, verify the password in Dockhand directly, then re-save it in Loxep. |
| "Unreachable from Loxep" | Dockhand is on a private network, behind a tunnel, or on an address your browser can reach and the Loxep server cannot. A network-topology problem, not a credential one. |
| Fields go blank after a Dockhand upgrade | Dockhand's API is unversioned and ships frequently, promising only that changes are additive. Loxep reads every field defensively; report a blank field so the adapter can be updated. |

## Related

- [Fleet Observability Design](../../architecture/fleet-observability-design/) — the host-registration carve-out, and the container verbs Loxep is forbidden to call.
- [Connecting Beszel](../connecting-beszel/) — the metrics companion, which is read-only with no exceptions.
