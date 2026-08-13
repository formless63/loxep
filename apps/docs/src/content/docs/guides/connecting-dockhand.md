---
title: Connecting Dockhand
---

[Dockhand](https://finsys-dockhand.mintlify.app) manages Docker hosts, containers, and Compose stacks. Loxep connects to it for two things, and the difference between them is the whole design:

- **Reading.** Which hosts Dockhand manages, what containers are on them, and which stacks are running. This appears in Loxep's fleet view alongside everything else it knows about the same machine.
- **Registering hosts.** Loxep can add a machine to Dockhand's inventory and keep its connection settings in step — the same declared-intent-and-reconcile relationship Loxep has with DNS.

**Loxep never starts, stops, restarts, execs into, deploys, or redeploys anything.** Those buttons live in Dockhand, where they belong, with your own session and Dockhand's own permissions. Loxep's fleet view links out to them. This is not a feature gap to be filled later: it is a boundary the codebase enforces with a test that fails if an adapter ever grows a lifecycle call.

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
   | `environments:view` | Read the list of managed hosts |
   | `environments:edit` | Register and update hosts (see below) |
   | `containers:view` | Read container state for the fleet view |
   | `stacks:view` | Read stack state for the fleet view |

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

## Registering a host from Loxep

Dockhand calls a managed Docker host an **environment**. Loxep calls it a hosting target. They are the same thing, and Loxep can create and update the Dockhand side of it.

This is the one place Loxep writes to Dockhand, and it is worth being precise about why it is allowed when starting a container is not: registering a host writes a row in Dockhand's own database describing how to reach a machine. **Nothing executes on that machine.** Starting a container runs code on it. That is the line.

Four connection types are available, matching Dockhand's own:

| Type | What it needs |
|---|---|
| **Socket** | A socket path — the local default, `/var/run/docker.sock` |
| **Direct** | A host, port, and protocol, with optional TLS material |
| **Hawser standard** | A Hawser agent token — HTTP with token authentication |
| **Hawser edge** | A Hawser agent token — WebSocket, for NAT traversal and edge deployments |

Two behaviours to know about:

- **Hosts are matched by name.** Loxep does not store a Dockhand identifier for a host; it matches on the name, which is unique on both sides. If you rename a host in either system, Loxep shows the Dockhand-side host as unmatched rather than silently registering a duplicate — rename it on both sides to reconnect them.
- **Loxep never deletes a Dockhand host.** Decommissioning a machine in Loxep stops Loxep reconciling it; removing it from Dockhand's inventory is your decision to make in Dockhand.

TLS material and Hawser tokens are **write-only**: Loxep can send them when you register or update a host, and can never read them back. Everywhere a certificate or token would appear, Loxep records only whether one is configured — so a private key cannot end up in a log, a diff, or an error message.

## When it does not work

| Symptom | Usual cause |
|---|---|
| Authentication fails, then keeps failing | The account may be locked out from repeated attempts. Wait a minute, verify the password in Dockhand directly, then re-save it in Loxep. |
| Host list works, containers or stacks are empty | Containers and stacks are read per host. Check `containers:view` and `stacks:view` on the account. |
| Host registration is unavailable | The account lacks `environments:edit`. |
| A host you renamed shows up twice | Expected — see the matching note above. Rename on both sides. |
| "Unreachable from Loxep" | Dockhand is on a private network, behind a tunnel, or on an address your browser can reach and the Loxep server cannot. A network-topology problem, not a credential one. |
| Fields go blank after a Dockhand upgrade | Dockhand's API is unversioned and ships frequently, promising only that changes are additive. Loxep reads every field defensively; report a blank field so the adapter can be updated. |

## Related

- [Fleet Observability Design](../../architecture/fleet-observability-design/) — the host-registration carve-out, and the container verbs Loxep is forbidden to call.
- [Connecting Beszel](../connecting-beszel/) — the metrics companion, which is read-only with no exceptions.
