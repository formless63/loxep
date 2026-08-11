---
title: Guides
---

Operator guides: step-by-step walkthroughs for the tasks a person actually performs against a running Loxep installation. Where the rest of this site explains how Loxep is built, these pages explain how to use it.

## Connecting a provider

Loxep observes and reads from external services; it never writes to them. Every provider connection is created **in the application**, on `/settings/integrations` and `/settings/connections` — never through environment variables or Compose files. The credentials are stored application-encrypted in PostgreSQL and are never displayed again after they are saved. See [Configuration & Secrets](../architecture/configuration-and-secrets/) for the rule behind that split.

- [Connecting eBay](./connecting-ebay/) — developer account, application keyset, redirect URL and RuName, sandbox test users, per-account consent, and the switch to production.
- [Connecting WooCommerce](./connecting-woocommerce/) — issuing a read-only REST API key pair in the store admin.
- [Connecting Medusa](./connecting-medusa/) — issuing a secret API key in the Medusa admin dashboard.

## How these guides relate to the application

Every step described here also appears inside the application, in the dialog where it is needed: each setup form carries a **Where to get these** section with the same path, and the eBay keyset form shows this installation's own callback URL with a copy button rather than an example. These pages exist for planning the work before you start it, for the parts that live outside Loxep entirely, and for reading somewhere other than the machine you are configuring.

Two vocabulary notes used throughout:

- An **integration** is a service Loxep can talk to. A **connection** is one account, store, or backend of that service. eBay needs one installation-wide keyset plus one connection per eBay account; WooCommerce and Medusa need only a connection each.
- An **economic entity** is optional business attribution on a connection. It records which of your businesses a connection belongs to. It grants nothing and restricts nothing.

## Before you start

- You need an **administrator** account in Loxep. Provider setup and credential entry are admin-only; ordinary members can see that a connection exists but cannot create or change one.
- The installation needs a correct public origin (`LOXEP_PUBLIC_ORIGIN`). eBay's consent flow returns the browser to that address, so a wrong value breaks the connection at the last step.
- Have the provider's own admin access ready — an eBay developer account, WordPress administrator rights, or a Medusa admin login. Loxep cannot create those for you.
