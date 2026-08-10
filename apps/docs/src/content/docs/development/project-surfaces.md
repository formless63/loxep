---
title: Project Surfaces & Future Sites
---

Loxep is expected to have several distinct public/project surfaces over time. They should share one repository where that remains convenient, but they do not need to share one framework or deployment lifecycle.

## Current applications

```text
apps/web      Loxep product application
apps/docs     project documentation
```

`apps/web` is the self-hosted product. `apps/docs` currently uses Astro Starlight because it was quick to establish and keeps architecture/product documentation versioned with the repository.

## Documentation framework is replaceable

Astro/Starlight is **not** a permanent architectural dependency of Loxep.

A later migration to a documentation stack that better fits project maintenance—such as MkDocs, Fumadocs, Markdoc-based tooling, or another suitable system—is explicitly acceptable.

To preserve that option:

- keep canonical documentation primarily in portable Markdown/MDX;
- avoid unnecessary Starlight-specific components or frontmatter extensions;
- keep diagrams and examples source-controlled in portable forms where practical;
- treat the information architecture and URLs as more important than the current rendering engine;
- do not couple the product application to the documentation runtime.

When the docs engine changes, preserve stable public URLs or provide redirects where practical.

## Future public site

The root `loxep.com` domain is expected to become a separate informational/project site rather than the product application itself.

A likely future repository shape is:

```text
apps/web       self-hosted Loxep product
apps/docs      technical/user documentation
apps/site      public informational/marketing project site
```

`apps/site` is only a reserved direction today; do not scaffold it during Phase 0 unless there is a concrete need.

The public site may eventually provide:

- a concise explanation of what Loxep does;
- screenshots/features and project status;
- installation/download links;
- links into documentation;
- links to source/releases;
- a path to a public demo instance.

This is an open-source/self-hosted project site, not a SaaS acquisition funnel. Marketing presentation should not impose SaaS tenancy, billing, authentication, or product architecture on `apps/web`.

## Future demo instance

A hosted demo may eventually live at a dedicated origin such as `demo.loxep.com`. It should be a deployment of the real product application with deliberately seeded/sanitized data and appropriate reset/isolation controls—not a second fake implementation embedded in the marketing site.

The demo's operational/security model should be designed when it is actually introduced.

## Domain planning

A likely eventual public split is conceptually:

```text
loxep.com             informational/project site
docs.loxep.com        documentation
demo.loxep.com        optional public demo
<self-hosted origin>  each user's actual Loxep deployment
```

Exact hostnames and deployment providers are not Phase 0 decisions. Repository and application architecture should simply avoid assuming that the product UI, docs, and public project site must be one application.
