---
title: Knowledge and Task Companion Integration Design
---

This document surveys two companion-tool categories Loxep has named but never evaluated — **living documentation/knowledge platforms** and **task/project management** — and designs the integration shape for the recommended picks.

**Status: DRAFT. Design work only.** No migration, Drizzle schema, integration package, or service code is authorized by this page. It creates **no table**: `external_resources` and `resource_links` shipped in Phase 0 for exactly this, and `integration_health` shipped in Phase 8 with `external_resource` already in its `subject_type` `CHECK`.

**Pointer — the shared link service this design's every m1 depends on now exists (loxep-v5r.3, IMPLEMENTED).** `createResourceLinksService` in `@loxep/domain` (`packages/domain/src/resource-links.ts`) is the single `registerExternalResource`/`attachLink`/`createLink`/`listLinksFor`/`detachLink` service [the milestones section](#milestones) says "the three m1s are one piece of work" about — loxep-p1j and loxep-juk (and loxep-ovj.3) build on this instance rather than each writing their own. It validates `resourceType` against a closed, extensible union (`RESOURCE_LINK_RESOURCE_TYPES`, currently `["hosting_target"]` only — `project`/`counterparty`/`acquisition` are NOT registered yet, so a knowledge/task m1 landing before those tables exist must add its own `RESOURCE_LINK_RESOURCE_TYPES` entry in the same change, per that module's own doc) but leaves `provider`/`externalType`/`purpose` as free text, exactly as this design's vocabulary table assumes. This design's own m1 work (a BookStack/Outline/Vikunja "Attach a document"/link form) is still unbuilt — only the underlying mechanism is done.

Every upstream fact below was verified against primary sources on **2026-08-13** — LICENSE files read raw, OpenAPI specs fetched, official compose files read — and must be **re-verified immediately before implementation** per the [dependency policy](../../development/dependency-policy/). Six of the surveyed projects pushed commits within 48 hours of verification, two have relicensed since their reputations were formed, and one's flagship rewrite has never shipped a release.

This design is **cross-cutting, not a phase**. The [roadmap](../../product/roadmap/#cross-cutting-companion-integrations) already lists "Vikunja task/project links" and "Outline/AFFiNE knowledge links" as work that may land whenever it accelerates a slice without becoming an architectural dependency. Nothing here depends on Phase 7, 8, or 9.

## Why this survey happened, and what it overturned

[Companion Services](../../product/companion-services/) named Outline and AFFiNE for knowledge and Vikunja for tasks, and recorded a precondition against Outline: *"Its current license/API behavior must be checked before implementation."* That check had never been done. Doing it changed two of the three answers.

```text
CONFIRMED    Vikunja is the right task pick, for a better reason than the
             one originally given.

QUALIFIED    Outline's API is the strongest in its category and free in
             self-hosting — but Outline is BSL 1.1, not open source, until
             2030-07-13.

OVERTURNED   AFFiNE cannot be a document integration at any price. Its
             GraphQL API exposes document metadata and permissions and NO
             document content, because content is a Yjs CRDT synced over
             WebSocket. The server half is also proprietary.

NEW          BookStack was not in any Loxep document and has the best API
             in the entire survey, under an unmodified MIT license with
             zero paid gating.
```

## The two rules that decide almost everything below

The first is inherited. [Principle 18](../principles/#18-integrate-before-rebuilding-mature-specialist-products) says integrate before rebuilding, and [Domain Boundaries](../domain-boundaries/#projects-and-work) states the boundary for this exact case: *"External task/project systems such as Vikunja may be linked through the generic external-resource model without becoming canonical project data unless an explicit synchronization/import design says otherwise."* This document is not that synchronization design and does not become one.

The second is this design's own falsifiable marker, in the shape [Phase 8](../fleet-observability-design/#the-line-this-phase-inherits) used:

> **Loxep stores a link and sync metadata. It never stores document content, and it never stores a task's own field values.**

If a milestone proposes a `documents` table with a body column, a `tasks` table mirroring a companion's schema, a full-text index over imported wiki pages, or a nightly job that copies task descriptions into Loxep, that milestone has started rebuilding the companion and [Principle 18](../principles/#18-integrate-before-rebuilding-mature-specialist-products) wins. A link row plus a title, a status string, and a last-observed instant is the shape that makes the rule enforceable by inspection.

The third rule is the screening test, and it is the one that eliminated most of the field:

> **A companion that cannot be driven by a documented HTTP API, available in the free self-hosted build, is a bookmark — not an integration.**

Applied honestly, this disqualified two of the most-recommended tools in the category on grounds that have nothing to do with how good their editors are. **The API was hunted for every candidate**, and where none was found this page records the exact URLs checked.

## The tier ladder

Reusing [Phase 8's vocabulary](../fleet-observability-design/#per-tool-verdicts), narrowed to content companions:

```text
tier 0   no relationship     Loxep does not model it at all
tier 1   link                external_resources + resource_links; a deep link on a
                             Loxep record. No credential, no adapter, no API needed.
tier 2   link + read         tier 1 plus a connections row and an API token. Loxep
                             reads title/status/counts so the link renders honestly.
                             No writes.
tier 3   link + create       tier 2 plus Loxep creates a document or task FROM a
                             Loxep record. The first write, and the first place two
                             copies of a fact can disagree.
tier 4   event ingest        the companion's webhooks post to Loxep; Loxep records
                             state. Blocked on the /api/v1 receiver — see below.
```

**Tier 1 needs nothing from any vendor.** It works against every tool in this survey, including the ones with no API at all, because a deep link is just a URL. That is why milestone 1 for both categories is tier 1 and why this design's recommendation is much less risky than its survey makes it sound.

## Category A survey: living documentation and knowledge platforms

All rows verified 2026-08-13. "Free API" means: a documented HTTP API, usable in the free self-hosted build, without a paid licence key.

| Tool | License (exact) | Free API? | Webhooks | API auth / free OIDC | Stack | S3 | Maturity / bus factor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **BookStack** | **MIT**, unmodified (`Copyright (c) 2015-2026, Dan Brown and the BookStack project contributors`) | **Yes** — self-documenting REST at `/api/docs` + machine-readable `/api/docs.json` on every instance | **Yes**, ~50 event types incl. `page_create/update/delete/restore/move`, `book_*`, `bookshelf_*`, `comment_*`, `permissions_update` | `Authorization: Token <id>:<secret>`, self-issued, gated by an "Access System API" permission. **OIDC + SAML2 + LDAP all free** | app + **MySQL ≥8 / MariaDB ≥10.6** (PHP ≥8.2). **No official Docker image** — LinuxServer.io / solidnerd community images | Yes: `STORAGE_TYPE=s3`, `STORAGE_S3_*` | 18,986★, ~194 contributors, **1 open issue**, v26.05.3 (2026-07-29). **Severe single-maintainer: 4,626 commits vs #2 at 126** |
| **Outline** | **BUSL 1.1** — Licensed Work "Outline 1.9.1", **Change Date 2030-07-13 → Apache-2.0**. Additional Use Grant bars use "for a Document Service" | **Yes** — 113 endpoints, OpenAPI 3.0 spec published at `github.com/outline/openapi`. Explicitly RPC-style: every endpoint is a `POST` to `/api/:method` | **Yes**, ~60 event types across `documents.*`, `collections.*`, `users.*`, `comments.*`, `revisions.create`, with a signing secret | API keys (`ol_api_…`, Bearer) **and** full OAuth 2.0 with granular scopes. **OIDC free**; SAML is enterprise | **Postgres + Redis** (both required) | Yes: `FILE_STORAGE=s3`, `AWS_S3_*`, `AWS_S3_FORCE_PATH_STYLE` | 40,100★, ~244 contributors, ≥100 commits/30d, company-backed. BSL since 2021 — no recent change |
| **Docmost** | AGPL-3.0 core **+ proprietary EE**; `apps/server/src/ee` is a submodule pointing at **`github.com/docmost/ee`, which 404s** | **No — the API itself is enterprise-gated.** `API_KEYS ('api:keys')` is in the EE feature list; upstream states *"The API is an enterprise feature."* | **None** — `webhook` appears zero times in the 404 KB spec | Bearer JWT, keys at Settings → API keys. **All SSO including plain OIDC is EE-only** | app + Postgres 18 + Redis 8 — lightest of the three | Yes: `STORAGE_DRIVER=s3`, `AWS_S3_*`, also Azure | 21,347★, **~50 contributors**, EE split has widened over time |
| **AFFiNE** | Client **MIT**; **`packages/backend/server/LICENSE` is the "AFFiNE Enterprise Edition License"** — production use requires a seat subscription, with an unmarked CE carve-out clause | **No content API at all.** GraphQL `Query` has zero document-content fields; `DocType` is metadata only (`id, title, summary, mode, public, …`) with **no body field**. Content is a Yjs CRDT over WebSocket | **None** anywhere in the schema | Cookie/session primary. **No general personal access tokens** — the only token type is MCP credentials | 4 services incl. **pgvector**-enabled Postgres; search needs external Manticore/Elasticsearch and is **off by default** | Yes, but **runtime-config only** — no `AFFINE_*` storage env vars | 71,504★ but **699 open issues**; company-backed |
| **Wiki.js** | AGPL-3.0 | GraphQL only at `/graphql`. **Thin docs** — page create/update/delete exists in the schema but is undocumented | None found | Bearer JWT, tokens with permission scopes. Very broad free SSO incl. OIDC, SAML, LDAP | app + Postgres — light | Storage targets are **sync/mirror destinations**, not primary; content lives in the DB | 28,751★ but **v3 has never shipped a release**; v2 in slow maintenance. **Worst bus factor in the survey: 1,875 commits vs #2 at 14** |
| **SiYuan** | AGPL-3.0 | Yes — kernel API at `:6806`, POST-only RPC, `docs/API.md`. Broad: notebooks, docs, blocks, attrs, **raw SQL query**, export, assets | None | `Authorization: Token xxx` | **Single container**, no DB service | **No.** S3/WebDAV are **paid PRO sync targets ($64)** — syncing to storage you own costs money | 45,787★, v3.8.0 (2026-08-12), very active. **Two-person project** |
| **Alexandrie** | **MIT** (`(c) 2021 Alexandrie`) | **No documented API** — see [the detailed verdict](#alexandrie-in-detail--the-owner-supplied-candidate) for exactly where we looked | None found | JWT + cookie sessions; OIDC/SSO advertised | 4 services: **MySQL 8.0**, RustFS, Go backend, Nuxt frontend | **Yes, and natively** — RustFS/MinIO/Garage/AWS | 2,300★, active (pushed 2026-08-12) |
| **AppFlowy** | Client and Cloud both **AGPL-3.0**, but Cloud ships an additional **per-server proprietary `SELF_HOST_LICENSE_AGREEMENT.md`**, and engineering has moved to a closed `AppFlowy-SelfHost-Commercial` fork | **No published API** — recursive search for `openapi\|swagger` across AppFlowy-Cloud returns **zero hits** | None found | GoTrue (Supabase) JWT. **LDAP and SCIM are paid-tier** | **11 containers** (nginx, minio, pgvector, redis, gotrue, cloud, admin, ai, worker, search, web) | Yes, MinIO bundled | **Free self-host is ONE USER SEAT per instance** (+3 guest editors); upstream calls it suitable *"to test out our self-hosted solution"*. AppFlowy-Cloud: **8 commits in all of 2026**, last release 2025-07-04 |

### What the screening rule eliminated, and why it is not a matter of taste

Three of these are excellent products that cannot be integrated:

- **AFFiNE is disqualified on mechanism, not policy.** There is no way to read or write a document's content over HTTP. Writing a page programmatically means speaking the Yjs sync protocol over a WebSocket and constructing BlockSuite block structures — which is not an integration, it is a reimplementation of a client. [ADR-0009](../../decisions/0009-integration-boundaries/) requires provider shapes to stop at the integration boundary; a CRDT document model cannot stop there because it *is* the transport. The proprietary seat-licensed server is a second, independent disqualification. **This overturns AFFiNE's standing evaluate-tier disposition** in [Companion Services](../../product/companion-services/#affine) and the [Master Domain Map](../../product/master-domain-map/).
- **Docmost is disqualified by its own pricing page.** It has the cleanest API design of the three big names — OpenAPI 3.1, ~190 endpoints, cursor pagination — and every bit of it is behind a licence key, as is every form of SSO. A companion whose API is a paid feature converts a Loxep integration into a per-operator purchase requirement. That is a different relationship than [Companion Services](../../product/companion-services/) describes, and it should not be entered silently.
- **AppFlowy is disqualified by seat count.** One user per free instance is an evaluation deployment, not a team knowledge base, and eleven containers is a large price for it.

SiYuan fails a different test: in Docker mode it has **no user model at all** — one instance is one workspace behind one shared access code, so "multi-user" means several humans sharing one identity. It also cannot export PDF/HTML/Word or import Markdown in that mode, per its own README.

### The two finalists, and the honest trade between them

**BookStack and Outline are both genuinely integrable.** They differ on the axis the owner named as mattering:

```text
BookStack     MIT, no paid tier of any kind, best-documented API in the survey,
              ~50 webhook events, free OIDC/SAML/LDAP.
              COST: MySQL/MariaDB — a second database engine for a
              Postgres/Timescale installation. No official container image.
              One maintainer. Per-page editing with draft/conflict warnings,
              not multiplayer co-editing.

Outline       Postgres + Redis (reuses the engine the operator already runs),
              113-endpoint API, ~60 webhook events, OAuth 2.0 with scopes,
              free OIDC, real-time collaborative editing, company-backed with
              a healthy contributor spread.
              COST: BUSL 1.1. Not open source until 2030-07-13.
```

The MySQL objection is real but smaller than it first appears: **Invoice Ninja, already a recommended companion, is a PHP/MySQL application too.** An operator following Loxep's companion guidance may already run that engine. The objection is a deployment cost to document, not a disqualification.

The BSL objection is also narrower than "not open source" sounds. The Additional Use Grant bars exactly one thing — offering a "Document Service", defined as *"a commercial offering that allows third parties (other than your employees and contractors) to access the functionality of the Licensed Work by creating teams and documents controlled by such third parties."* A Loxep operator self-hosting Outline for their own business is squarely inside the grant. What BSL costs is **categorical**: Loxep's own [Companion Services](../../product/companion-services/) rule says *"Loxep's MIT license does not imply that every recommended companion is MIT-licensed"*, so recommending a non-open companion is permitted — but making the *first* and *reference* knowledge integration a non-open tool sets a precedent about what "genuinely open" means in this project.

**Recommendation: BookStack is the first adapter; Outline is co-supported and documented as the alternative.** The reasons, in order of weight:

1. **The integration is provider-agnostic by construction**, so supporting two costs far less than picking one twice. Both are POST-RPC-ish APIs over a documents/collections model, both mint API tokens, and both land in the same `external_resources` rows. The [generic external-resource model](../foundational-data-model/#external_resources) exists precisely so this is true.
2. **BookStack's API is the best in the survey and its licence has no asterisk.** A self-documenting `/api/docs.json` on the operator's own instance means the adapter can be verified against the exact deployed version rather than against a vendor's published spec — a property no other candidate offers.
3. **BookStack has zero paid gating.** Nothing in this integration can later move behind a licence key. Outline's enterprise plugin already gates SAML, AI answers, and data attributes, and its `plugins/enterprise` directory in the public repo contains only translation strings — the implementation is stripped. Nothing Loxep needs is in there today, but the seam exists.
4. **The single-maintainer risk is mitigated by the licence it comes with.** MIT means a fork is always available; AGPL and BSL projects with the same bus factor do not offer that exit as cleanly.

### Alexandrie in detail — the owner-supplied candidate

Alexandrie was supplied as a primary source and deserves a precise verdict rather than a table row. It is a genuinely pleasant MIT wiki with the best storage-model fit of anything surveyed. It is **not integrable today**, for one fixable reason.

**Confirmed facts** (`https://github.com/Smaug6739/Alexandrie`, `https://alexandrie-hub.fr/reference/documentation`, 2026-08-13):

- **MIT**, `(c) 2021 Alexandrie`. Active — pushed 2026-08-12, ~2,300 stars, ~2,737 commits.
- **The backend is Go now, not NestJS.** 78 `.go` files on Gin (`backend/router/router.go`); zero TypeScript/JavaScript backend files. The migration has already happened, so any note describing Alexandrie as "Vue/Nest" is stale.
- **S3-compatible storage is native and RustFS is the default** — the official compose ships `rustfs/rustfs` alongside MySQL 8.0, the Go backend, and the Nuxt 4 frontend. Upstream advertises *"native compatibility with … RustFS, Garage, MinIO, or AWS"*. **This is the only candidate whose storage assumption matches [Loxep's own RustFS companion](../../decisions/0014-rustfs-object-storage-companion/) exactly.**
- Real features: Markdown editor with LaTeX and diagrams, offline PWA, OIDC/SSO, full-text search, ZIP import/export.

**The API hunt, stated per the standing rule.** Checked on 2026-08-13:

```text
alexandrie-hub.fr/reference/documentation   setup guide only. Names a JWT secret,
                                            a cookie domain, and a backend on :8201.
                                            No endpoint documentation.
alexandrie-hub.fr footer "API Reference"    links to the GitHub wiki.
GitHub wiki                                 5 pages: Home, Environment variables,
                                            FAQ, Snippets, Syntax. Zero endpoints.
repository tree (recursive)                 no openapi/swagger file of any kind.
backend/router/router.go                    route groups DO exist under /api:
                                            users, user_settings, auth, uploads,
                                            backup, nodes, stats.
```

**Verdict: the API exists and is undocumented.** That is a materially different finding from "no API", and it is the cheapest gap in this survey to close — the routes are already there. Alexandrie is **watch-tier**: revisit when upstream publishes endpoint documentation or an OpenAPI spec, at which point its MIT licence and RustFS-native storage make it a strong contender.

**One claim must be corrected before it propagates: Alexandrie's "integrated Kanban boards" is not a task system.** Verified at the model layer — there are **zero kanban/board/task routes** in the Go backend and **zero such tables across all 19 migrations**. The frontend's `Kanban/Board.vue` emits `updateMetadata`, which the container view persists as `metadata` on the *parent node*. The entire board — columns and card placement — is a JSON blob on a document, and the "cards" are documents (`role === 3`), not tasks. There are no assignees, no due dates, no statuses, and no task entity. It is a kanban-shaped **view of documents**, and it does not make Alexandrie a Category B candidate.

## Category B survey: task and project management

Loxep already owns `@loxep/work` — projects, time entries, billing rates, materials, and the unbilled-work queue are real, shipped services. **This integration is a bridge, never a replacement.** [Domain Boundaries](../domain-boundaries/#projects-and-work) makes projects, time, and billable facts Loxep-owned; what Loxep has no native model for is **tasks, kanban, assignees, and due dates**, and that is exactly the gap a companion fills.

| Tool | License (exact) | Free API? | Webhooks | API auth / free OIDC | Stack | Maturity / bus factor |
| --- | --- | --- | --- | --- | --- | --- |
| **Vikunja** | **AGPL-3.0** | **Yes** — **OpenAPI 3.1** at `/api/v2/openapi.json` (since 2.4.0), plus v1 Swagger at `/api/v1/docs`. Projects, tasks, labels, assignees, kanban buckets, attachments, relations, saved filters, teams | **Yes**, with **HMAC-SHA256 body signing** in `X-Vikunja-Signature`. `task.created/updated/deleted`, `task.assignee.*`, `task.comment.*`, `task.attachment.*`, `task.relation.*`, `project.created/updated/deleted`, `project.shared.*`, `team.*` | **API tokens with genuine per-route scoping** (`{"tasks":["read_all","update"]}`) and an expiry. **OIDC free, multi-provider**, `vikunja_groups` claim maps to teams | **2 containers** — one Go binary (API + frontend) + Postgres | 5,050★, pushed 2026-08-13. ⚠️ solo maintainer (7,245 commits; #2 is a bot) |
| **OpenProject** | **GPL-3.0** community edition; Enterprise features ship in the same repo behind a runtime token gate | **Yes** — HAL+JSON APIv3 with published spec at `/api/v3/spec.json`. API access is a **Community** feature | **Yes** — projects, work packages, comments, time entries, attachments, with a signature secret. Event identifiers are **not published** in the docs | API key over HTTP Basic (username literally `apikey`), OAuth 2.0 + PKCE, OIDC JWT per RFC 9068. **SSO/SAML/OIDC is Enterprise (Professional tier)** | **9 services** incl. memcached, proxy, worker, cron, hocuspocus, autoheal | 15,837★, **healthy contributor spread** (16k / 14k / 5k / 5k), company-backed, no bus-factor problem |
| **Planka** | **PLANKA Community License 1.1 — not OSI open source.** Fair-use grant; *"operating PLANKA as a hosted service for third parties for any commercial gain whatsoever is prohibited"*; `.pe.` files are commercial-only | OpenAPI 3.0 generated at `/api`; **docs are thin** (upstream issue "API documentation missing" is open). Marketing lists "REST API & Webhooks" as **Pro**, while the OSS `server/api/controllers` tree contains `webhooks/`, `access-tokens/`, `custom-fields/` with no `.pe.` markers — **contradictory, needs live verification** | Controllers exist; gating unclear | `bearerAuth` JWT + `apiKeyAuth` header. **SSO/OIDC marketed as Pro** | 2 containers | 12,344★, **446 open issues**, solo maintainer (~80% of top-5 commits). **Relicensed away from MIT** |
| **Leantime** | AGPL-3.0 | **JSON-RPC 2.0 only**, `POST /api/jsonrpc`. **No OpenAPI spec.** Only `@api`-annotated PHP methods are callable — discoverability requires reading source | Not found | `x-api-key: lt_{user}_{key}`, with roles and project access assignable per key | ~2 containers (unverified — docs.leantime.io serves a JS-only shell) | 11,324★, solo maintainer (6,686 vs #2 at 180) |
| **Taiga** | **MPL-2.0** (`taiga-back`) — *not* AGPL, contrary to reputation | Yes — hand-written REST docs at `docs.taiga.io/api.html`, 45+ endpoint categories. No OpenAPI spec | Yes — list/create/test/logs/resend | `Authorization: Bearer` / `Application` tokens | **8 services incl. TWO separate RabbitMQ instances**; images pinned old (Postgres 12.3, nginx 1.19) | 844★. **Caretaker mode** — recent commits are almost entirely permission/security fixes. The "Taiga NEXT" rewrite has been **dead since 2023-12** |
| **Focalboard** | AGPL-3.0 source / MIT compiled / Apache-2.0 admin files | — | — | — | — | ❌ **Unmaintained.** README: *"This repository is currently not maintained."* Moved to `mattermost-community`. Last substantive code change 2024-08 |

### Vikunja is confirmed, and the reason is better than the original one

[Companion Services](../../product/companion-services/#vikunja) called Vikunja *"a practical way to gain mature task/project capability before Loxep's native Projects/Tasks domains are complete."* That framing is now slightly wrong in a way that improves the recommendation: Loxep's **projects** domain is not incomplete, it is shipped. What Vikunja supplies is the *task and kanban layer* Loxep deliberately does not own.

Three findings the original disposition did not have:

1. **Vikunja has a Pro tier, and what it gates is almost comically well-suited to this split.** Pro gates exactly three things: the admin panel, **time tracking**, and audit logs. Time tracking is the one capability Loxep must never delegate — `@loxep/work` owns time entries, billing rates, and the unbilled-work queue, and [Phase 6](../services-billing-schema-design/) builds invoicing on top of them. **The feature Vikunja charges for is the feature Loxep is required to own.** An operator on the free AGPL build loses nothing this integration wants.
2. **The licence check does not phone home unless a key is set.** Upstream states: *"If the license key is empty or unset, no requests are made at all and the instance runs in community mode from the start."* With a key configured, the API contacts the licence server on startup and daily thereafter. Worth documenting for air-gapped operators; not a concern for the free build.
3. **Its webhooks are the best-engineered in either category** — HMAC-SHA256 over the raw body, a documented per-project and per-user management API, and a clean event taxonomy. When tier 4 becomes possible, Vikunja is the tool it should be built against first.

The cost is honest and singular: **bus factor.** Vikunja is one person plus a bot, and it is AGPL rather than MIT. There is no better-licensed alternative in this category — Planka relicensed away from MIT into a non-OSI fair-use licence, Focalboard is unmaintained, Leantime and Taiga are solo/caretaker too, and the only project with a healthy contributor spread is OpenProject, which gates SSO behind a paid tier and needs nine containers.

**Recommendation: Vikunja, confirmed, at tier 1 → 2.** OpenProject is documented as the alternative for operators who want a full PM suite and accept GPL plus enterprise-gated SSO.

## The both-in-one check: is there a gem that does both?

**No. The honest answer is that no single lightweight tool covers A and B well under a clean licence with a documented API.** Every candidate fails at least one leg, and it is worth recording exactly which leg, because the failures are not close calls.

| Candidate | A | B | License verdict | API verdict | Weight |
| --- | --- | --- | --- | --- | --- |
| **Huly** | Yes | Yes | **Mostly clean, with a real catch.** `platform` LICENSE is **EPL-2.0** and its history has exactly **one commit** ("Initial commit", 2021-08-02) — **no relicensing ever happened in the main repo**, so the widely-repeated license-change rumor is false for the platform. **But** several required satellite services — including **`hulykvs`, which is an active service in the official compose** — have **no LICENSE file at all** (`license: null`), which defaults to all-rights-reserved | **No documented endpoint API.** `@hcengineering/api-client` offers `connect` (WebSocket) and `connectRest`, but REST is only an alternate transport for the same TS client methods. No OpenAPI anywhere in the tree; upstream docs call it *"a basic API"* | **14 containers** — CockroachDB, Redpanda, Elasticsearch, MinIO, nginx, rekoni, transactor, collaborator, account, workspace, front, fulltext, stats, kvs. README warns the CockroachDB/Redpanda configs *"might not be production-ready"* |
| **Plane** | Pages (wiki-lite) | Yes | **Cleanest of the A+B set — pure AGPL-3.0**, `SPDX-License-Identifier: AGPL-3.0-only`, **no `ee/` directory** in the repo | Documented REST at `developers.plane.so`, `X-API-Key`. **Catch:** the OSS external API views contain no `page.py`, so **Pages may not be externally addressable in Community edition** despite appearing in the docs | 13 services incl. RabbitMQ, MinIO, valkey |
| **OpenProject** | Real wiki module | Yes | GPL-3.0 with runtime enterprise gating | **The only candidate where A and B are both first-class in ONE documented API** — APIv3 covers wiki pages and work packages alike | 9 services |
| **Gitea / Forgejo** | Git wiki (plain) | Issues + boards | **Best licences in the field — Gitea MIT, Forgejo GPL-3.0** | Both wiki and issues are API-addressable (Gitea OpenAPI; Forgejo swagger has 4 wiki + 31 issue paths — but **zero `/projects` paths**, so its kanban layer is not API-accessible) | **1 binary** + SQLite/Postgres |
| **AppFlowy** | Yes | Kanban/grid | AGPL + per-server proprietary self-host agreement | No published API | 11 containers, 1 free seat |
| **Nextcloud** | Collectives | Deck | All AGPL-3.0 | Deck has hand-written REST docs; **Collectives publishes a generated OpenAPI 3.0.3 spec with 58 paths** | Two separate apps — grep shows **zero cross-references** between them. Integration is link-unfurling only |
| **Alexandrie** | Yes | **No** — kanban is a JSON blob on a document; no task entity | MIT | Undocumented | 4 containers |
| **Anytype** | Yes | Partial | **"Any Source Available License 1.0"** — commercial use permitted only on "Allowed Networks", and that list contains exactly one entry: Anytype's own production network. Self-hosted commercial use is outside the grant | — | — |

**The two candidates that come closest are worth naming, because "no gem" should not be read as "nothing exists":**

- **OpenProject** is the only tool in this entire survey where one documented API covers both a wiki and a work-package tracker. If the owner's priority is *one companion instead of two*, it is the answer — at the price of GPL with enterprise-gated SSO, nine containers, and a product that overlaps `@loxep/work`'s projects far more than Vikunja does.
- **Gitea or Forgejo** is the honest minimalist answer — one binary, MIT or GPL, wiki and issues both in the API — **if "living documentation" can mean a plain git-backed wiki** with no nesting and no co-editing. For an installation that already runs a forge, this is close to free.

**Recommended posture: two tools, not one.** BookStack (or Outline) plus Vikunja is four containers total against Huly's fourteen or Plane's thirteen, both halves have documented free APIs and real webhooks, and neither one's failure takes the other down. The all-in-one products trade exactly the property this design depends on — a documented, stable HTTP contract — for UX breadth Loxep does not consume.

## The integration shape

**No new table.** [`external_resources` and `resource_links`](../foundational-data-model/#external_resources) shipped in Phase 0 for this, and `resource_links` already carries `unique(external_resource_id, resource_type, resource_id, purpose)`, which makes a link an idempotent upsert probe — the property an at-least-once Graphile Worker job requires.

Following [Phase 6's](../services-billing-schema-design/) and [Phase 8's](../fleet-observability-design/#the-link-model-and-its-vocabulary) vocabulary table form exactly:

```text
provider     external_type   resource_type    purpose
------------ --------------- ---------------- ------------------------
bookstack    page            project          runbook
bookstack    page            counterparty     account_notes
bookstack    book            project          project_docs
bookstack    chapter         acquisition      research
bookstack    shelf           economic_entity  handbook
outline      document        project          runbook
outline      document        counterparty     account_notes
outline      collection      project          project_docs
vikunja      project         project          task_board
vikunja      task            project          task
vikunja      task            acquisition      task
vikunja      task            counterparty     followup
```

**`resource_type` values may only name tables that exist when the milestone ships.** `project`, `counterparty`, and `acquisition` are Phase 4/6 concepts; a milestone landing before those tables exist links to whatever foundation records do exist, and does not pre-create rows for future ones.

Four rules, three of which carry over unchanged from Phase 8 and one of which is specific to content tools:

- **No provider-specific column anywhere.** There is no `projects.vikunja_project_id`, no `counterparties.outline_collection_id`, and no `projects.bookstack_book_id`. This is the boundary rule [Companion Services](../../product/companion-services/#generic-external-resources) states and the reason `external_resources` exists at all. It is also the rule that lets this entire design ship without a migration.
- **`metadata` holds sync metadata only** — a last-observed instant, the companion's own status string, an ETag or revision number. **Never** a copy of the document body, the task description, or the checklist. The moment a task's title is authoritative in two places, one of them is stale. `external_resources.title` is a **captured display convenience**, refreshed only by an explicit tier-2 read, and the UI must render its age.
- **Direction of authority is fixed per purpose, and every purpose above is companion-authoritative.** BookStack owns the page. Vikunja owns the task. Loxep records the link and, at tier 2, the latest observed title and status. Tier 3 is the only place this changes, and it changes narrowly: Loxep authors the *creation*, then hands authority over.
- **New for this design: a link is bidirectional in intent but one-directional in storage.** The companion should carry a back-reference to the Loxep record — BookStack tags, Vikunja labels, or simply a URL in the description — but Loxep must not *depend* on it. A back-reference is a convenience for humans working in the companion, not a join key. If it is missing or edited away, nothing in Loxep breaks.

### Connections, credentials, and reachability

These are ordinary provider connections, created in-app and never in Compose, exactly as [Configuration & Secrets](../configuration-and-secrets/) requires:

```text
connections.provider = 'bookstack' | 'outline' | 'vikunja'
connections.config              base URL — NON-SECRET, exactly as a WooCommerce
                                store URL is, and for the same reason: it must stay
                                readable without a decryption round-trip

connection_credentials          bookstack_credentials { tokenId, tokenSecret }
                                outline_credentials   { apiKey }
                                vikunja_credentials   { apiToken }
```

- **BookStack's bundle has two fields and they must stay atomic.** Its header is `Authorization: Token <id>:<secret>`; a half-rotated pair is not a degraded credential, it is a broken one. This follows the `ebay_keyset` precedent rather than the single-field `medusa_credentials` / `invoiceninja_credentials` shape.
- **All three of these are genuine API tokens**, unlike the Phase 8 fleet tools where [every credential turned out to be a login](../fleet-observability-design/#connections-credentials-and-reachability). The form labels may honestly say "API token" here — and should say precisely which one, because BookStack's is issued per user under an "Access System API" permission and Vikunja's carries per-route scopes.
- **Scope the token down, and say so in the guide.** Vikunja tokens take a permissions map (`{"projects":["read_all"],"tasks":["read_all","create"]}`); a tier-2 token should carry read scopes only. BookStack's token inherits its user's role, so the guide must instruct creating a dedicated limited-role user rather than using the operator's admin account.
- **Reachability is a deployment fact this design must not assume**, on the same terms Phase 8 set. A wiki on a private network is normal. "Unreachable from Loxep" must render as a **distinct, explained state**, never as a broken link.
- No adapter may follow a redirect to a different host, and no adapter may send its credential to a URL it did not construct from stored connection config.

### Health

Reuse `integration_health` with **no schema change** — `external_resource` and `connection` are both already in its `subject_type` `CHECK`, and Phase 8 shipped the sweep. A companion connection projects to `subject_type = 'connection'`; an individual linked document or task, if it is ever probed, projects to `subject_type = 'external_resource'`.

The Phase 8 rules bind unchanged: one row per subject overwritten in place, `detail` carries no credential and no response body, staleness is derived from `checked_at` rather than asserted as a status, and **`integration_health` never drives retry or backoff.**

### Tier 4 is blocked, and must stay blocked on the same question as Phase 8

[Companion Services](../../product/companion-services/#vikunja) sketches *"consume supported webhook/API updates for task completion/status"*. That is tier 4, and **Loxep has no inbound webhook receiver.** [Phase 8's open question 4](../fleet-observability-design/#open-questions) asks whether one should exist, treats it as the opening move of the `/api/v1` surface rather than a feature of any one integration, and defers it.

**This design does not reopen that question and must not answer it differently.** If a receiver is built, these tools reuse it on identical terms — a per-connection bearer token, one `source_events` row, a projection job, and never a `notification_deliveries` row. Vikunja's HMAC-SHA256 body signing and BookStack's Slack-compatible payload make them good first consumers whenever that surface lands; neither justifies building it alone.

## Milestones

Each category's milestone 1 needs **no credential, no adapter package, and no vendor cooperation**, which is what makes this design cheap to start and safe to abandon.

```text
KNOWLEDGE (BookStack, then Outline)

m1  tier 1 — link only. An "Attach a document" form on a Loxep record writes
    external_resources + resource_links. Provider is a dropdown; the operator
    pastes a URL and a title. Works against BookStack, Outline, Alexandrie,
    Wiki.js, SiYuan, or a plain intranet page — no API required.
    NO migration. NO integration package. NO connections row.

m2  tier 2 — @loxep/integration-bookstack. A connections row, an API token,
    and read-only calls: GET /api/pages/{id}, /api/books/{id}, /api/search.
    Refreshes external_resources.title and metadata; renders age and status.
    Adds a /settings/integrations catalog card and a Guides page.

m3  tier 2 — the same for Outline (POST /api/documents.info, .search).
    Proves the provider-agnostic claim by adding a second provider with no
    change to external_resources, resource_links, or any domain table.

m4  tier 3 — create a document from a Loxep record, from a template.
    OWNER-GATED: this is the first write. See open question 2.

TASKS (Vikunja)

m1  tier 1 — link only. Identical form, provider 'vikunja', linking a Loxep
    project/counterparty/acquisition to a Vikunja project or task URL.
    Shares one link service with the knowledge m1 and with loxep-ovj.3 —
    build ONE service, not three.

m2  tier 2 — @loxep/integration-vikunja. Read-only against the v2 OpenAPI
    surface: GET project, GET tasks, done/undone counts. Renders "4 of 11
    tasks open, read 6 minutes ago" on a Loxep project. Never stores a task.

m3  tier 3 — create a Vikunja task from a Loxep record. OWNER-GATED.

m4  tier 4 — webhook ingest. BLOCKED on the /api/v1 receiver decision
    (Phase 8 open question 4). Not schedulable until that is answered.
```

**The three m1s are one piece of work — and the shared piece shipped.** [loxep-v5r.3](../../product/roadmap/) built the one link service in `@loxep/domain` (`createResourceLinksService`, see the pointer at the top of this document) that [Phase 8 milestone 3](../fleet-observability-design/#the-link-model-and-its-vocabulary) already consumes for fleet records. This design's own m1 (a BookStack/Outline/Vikunja "Attach a document" form and provider dropdown) still needs to be built on top of it — the mechanism existing is not the same as either knowledge or task m1 shipping.

## What this design does not create

```text
a documents table, or any body/content column       the falsifiable marker
a tasks table mirroring a companion's schema        same
a full-text index over imported wiki pages          the companion owns search
a two-way sync of titles, statuses, or assignees    one authority per purpose
provider-specific columns on any domain table       external_resources exists for this
a second inbound webhook receiver                   Phase 8 open question 4 owns that
native task/kanban capability in @loxep/work        deliberately deferred; see the
                                                    roadmap's "Later directions"
time tracking delegated to a companion              @loxep/work owns it, permanently
an integrations-catalog card for tier-1 links       Phase 8's rule: a card implies a
                                                    connection and a credential
```

## Open questions

Each is genuinely unresolved and carries a recommendation. **A recommendation is not an answer.** Items marked **OWNER-REVIEW-CRITICAL** are irreversible in practice or set precedent beyond this design.

1. **OWNER-REVIEW-CRITICAL — BookStack or Outline first, or both?** This design recommends BookStack first (MIT, best API, zero gating), Outline co-supported and documented.

   *Recommendation:* BookStack first. The tie-breaker is not API quality — Outline's is comparable — it is that making the reference knowledge integration a BSL tool sets a precedent about what "genuinely open" means in a project whose own licence is MIT.

   *The owner must confirm:* whether BSL 1.1 is acceptable for a *recommended* companion at all (its Additional Use Grant permits Loxep operators outright; only reselling a document service is barred), and whether BookStack's MySQL requirement is acceptable given that Invoice Ninja already brings that engine. This is marked critical because the first adapter becomes the reference implementation every later one is written against.

2. **OWNER-REVIEW-CRITICAL — does Loxep ever WRITE to a knowledge or task companion (tier 3)?** This design defers it to m4/m3 and gates it here.

   *Recommendation:* yes for **creation only**, never for update. Creating a task from a Loxep event and creating a doc from a template are the two capabilities that make the integration feel real, and both hand authority over immediately after the write. Updating a companion object afterward is where two systems start disagreeing about the same fact, and it should require its own design.

   *The owner must confirm:* that "Loxep creates, the companion owns" is the permanent line. Once operators rely on Loxep to keep a Vikunja task's status in step with a Loxep record, the [Domain Boundaries rule](../domain-boundaries/#projects-and-work) against companions becoming canonical project data has been eroded in practice regardless of what the schema says.

3. **Does Vikunja stay the task pick given its solo bus factor and AGPL licence?** This design says yes.

   *Recommendation:* yes. There is no better-licensed maintained alternative — Planka relicensed out of OSI open source, Focalboard is unmaintained, Leantime is JSON-RPC with no spec, Taiga is in caretaker mode, and the only healthy-contributor option (OpenProject) gates SSO behind a paid tier and needs nine containers. Vikunja's Pro tier gating **time tracking** is a feature of the fit, not a defect, because `@loxep/work` must own that anyway.

   *The owner must confirm:* that a one-maintainer AGPL companion is acceptable at tier 2, where a stored credential and an adapter package exist.

4. **Is the both-in-one question closed, or should OpenProject get a second look?** This design says no single gem exists and recommends two tools.

   *Recommendation:* keep two tools. But record honestly that **OpenProject is the only surveyed product where one documented API covers both a wiki and a work tracker**, so if the owner's real priority is fewer companions rather than better licences, it is the answer and this design's recommendation is wrong for that goal.

   *The owner must confirm:* whether "one companion instead of two" is a goal worth nine containers and enterprise-gated SSO. Also worth a decision: **Gitea/Forgejo** covers both under MIT/GPL in a single binary if a plain git wiki is enough, which is close to free for an installation that already runs a forge.

5. **Does tier 4 stay welded to Phase 8's receiver decision?** This design says yes and refuses to answer it independently.

   *Recommendation:* answer [Phase 8 open question 4](../fleet-observability-design/#open-questions) once, for the whole installation. Two inbound webhook surfaces with different auth models would be strictly worse than none.

6. **Do tier-1 links get an integrations-catalog card?** Phase 8's rule says no — a card implies an account, a credential, and a connection.

   *Recommendation:* hold that rule. A pasted BookStack URL has none of those. Cards appear at tier 2, when a `connections` row exists. Flagged because it is the kind of detail decided silently and wrongly, producing a `/settings/integrations` page full of bookmarks.

7. **Is `external_resources.title` refreshed, or captured once?** Tier 1 captures what the operator typed; tier 2 could refresh it from the companion.

   *Recommendation:* refresh at tier 2, and **always render its age**. A silently stale title is the same failure as a status with no visible age — an operator over-trusts it. If a document is renamed or deleted in the companion, the link must be able to say so rather than showing a title that no longer exists.

8. **What would change Alexandrie's verdict?** Watch-tier today, purely for want of API documentation.

   *Recommendation:* revisit when upstream publishes endpoint documentation or an OpenAPI spec — the Gin routes already exist, so this is the cheapest gap in the survey to close. Its MIT licence and **RustFS-native storage** would then make it the best licence-and-architecture fit of any Category A candidate. Its kanban must not be counted as task management in the meantime.

## Contradictions and tensions found in existing documentation

Recorded for a human to resolve; this document does not fix them.

1. **AFFiNE's standing disposition is falsified.** [Companion Services](../../product/companion-services/#affine) calls it an *"evaluation candidate"* whose adapter *"should wait for a stable supported external API"*, and the [Master Domain Map](../../product/master-domain-map/) lists it under RECOMMENDED / EVALUATE for knowledge/docs. The wait is not for a stable API — there is **no document-content API to stabilize**, because content is a Yjs CRDT over WebSocket, and the server is under a proprietary seat licence. Those sections should be amended to record the finding rather than left implying the evaluation is still pending.

2. **The Master Domain Map's knowledge list omits the recommended tool.** It reads *"Knowledge/docs: Outline, AFFiNE, compatible alternatives."* If BookStack becomes the first adapter, that line is stale in the specific way this project's [documentation discipline](../../development/dependency-policy/) warns about.

3. **Companion Services assumes a capability Loxep does not have.** Its Vikunja bullet promises to *"consume supported webhook/API updates for task completion/status"* — tier 4, which requires an inbound receiver that has never existed. Phase 8 raised the same gap independently. Two documents now promise webhook consumption while a third defers the receiver.

4. **RESOLVED 2026-08-13 — three designs scoped the same link service; loxep-v5r.3 shipped first and owns it.** [loxep-v5r.3](../../product/roadmap/) (external-resource links in product UI), [Phase 8 milestone 3](../fleet-observability-design/#the-link-model-and-its-vocabulary) (fleet tool links), and this design's m1 all described creating `external_resources` + `resource_links` rows from a form. `createResourceLinksService` in `@loxep/domain` is now that one service (see the pointer at the top of this document); loxep-ovj.3, loxep-p1j, and loxep-juk consume it rather than building their own.

5. **"Companion" is doing two jobs in the documentation.** [Companion Services](../../product/companion-services/) opens with a three-way distinction (first-class integration / recommended companion / implementation reference), but its per-tool sections mix "we will integrate this" with "we suggest you run this" without marking which is which. The tier ladder here and in Phase 8 is a sharper instrument; the product doc's categories should eventually adopt it or explicitly defer to it.

## Before implementing this design

1. **Resolve open questions 1 and 2 first.** Question 1 picks the reference implementation every later adapter is written against; question 2 decides whether Loxep ever writes to a companion, which is the boundary that cannot be un-crossed once operators depend on it.
2. **Re-verify every claim in both survey tables.** Six of these projects pushed within 48 hours of verification; Wiki.js's v3 is landing daily commits with no release; Planka and Taiga have both relicensed since their reputations formed; Vikunja gained a Pro tier that was not in this project's prior notes. Nothing in these tables should be trusted at implementation time because it appears here.
3. **Verify the chosen tool's API against a running instance, not a published spec.** BookStack serves `/api/docs.json` from the operator's own deployment, which is a stronger guarantee than any vendor document — use it. For Vikunja, confirm whether the target instance exposes v2 (`/api/v2/openapi.json`, present since 2.4.0) or only v1, and target v2: v1 is deprecated in 3.0 and removed in 4.0.
4. **Confirm Planka's Community API gating before it is ever recommended**, if it is reconsidered. Its marketing lists REST API and webhooks as Pro while its open-source controller tree contains `webhooks/` and `access-tokens/` with no commercial-file markers. That contradiction was not resolvable from documentation alone and needs a live instance.
5. **Build one link service, not three** (see tension 4). Coordinate with `loxep-v5r.3` and `loxep-ovj.3` before writing any of them.
6. **Assert by test that no adapter writes a domain-table column**, and that `external_resources.metadata` never receives a document body or task description — the falsifiable marker made enforceable rather than aspirational, following the `redact*` precedent in [ADR-0021](../../decisions/0021-order-payload-retention/) and the `upsertHealth` precedent in `@loxep/domain`.
7. **Assert by test that tier-2 adapters are read-only**, per the Phase 8 pattern (`forbidden-verbs.test.ts`), so that tier 3 requires an owner decision rather than a code-review conversation.
8. **Keep provider shapes at the integration boundary** ([ADR-0009](../../decisions/0009-integration-boundaries/)). BookStack page objects, Outline's `{ok, status, data, pagination}` envelope, and Vikunja task structs must not become Loxep types.
9. **Scope the API token down and document how**, per provider, in the Guides page — a dedicated limited-role BookStack user, a read-scoped Vikunja token. The token a walkthrough tells an operator to create is the token most installations will run forever.
10. **Update this document, Companion Services, the Master Domain Map, and the roadmap when implementation reality diverges**, rather than letting the documentation drift.
