---
title: Dependency and Version Policy
---

Loxep should not adopt stale framework, runtime, library, container, or GitHub Action versions simply because they are familiar, widely represented in training data, or present in an older example, boilerplate, starter, or deployment guide.

## Core rule

Before adding or pinning a dependency, verify the current upstream stable release and confirm that it is viable with the rest of the selected stack.

Do not assume a remembered major version is current.

## Selection policy

1. Prefer the newest stable release that is compatible with Loxep's supported runtime and peer dependencies.
2. Do not select an older version without documenting the reason when a newer stable release exists.
3. Avoid prerelease/canary/nightly versions unless a documented requirement justifies the risk.
4. Verify breaking changes and peer-dependency compatibility before adopting a new major.
5. Prefer primary sources for version verification: official release pages, package registries, official documentation, upstream changelogs, and official container registries.
6. For major architectural dependencies, record intentional version constraints or compatibility exceptions in the relevant ADR.
7. Container-image versions/tags are dependencies too; verify the current viable release before writing Compose examples or production recommendations.

## Starters and boilerplates

A starter supplies code, patterns, and presentation—not authoritative dependency versions.

When adopting code from Kiranism's TanStack Start dashboard or another starter:

1. inventory the dependencies actually needed by the retained code;
2. remove demo/unused dependencies first;
3. verify the current upstream version of every retained direct dependency;
4. check current framework/peer compatibility before upgrading across the starter's original versions;
5. generate/update Loxep's own lockfile rather than treating the starter lockfile as canonical;
6. preserve a starter's older version only when current compatibility work genuinely requires it, and document that exception.

The same rule applies to copied GitHub Actions, Docker Compose files, README commands, and configuration examples.

## Reproducibility

Application dependencies should be represented by deterministic manifests and lockfiles. Avoid `latest` in committed package manifests because it makes the same commit resolve differently over time.

Exact versions are acceptable and preferred for application/tooling dependencies when automated update tooling keeps them current. Peer dependencies in publishable libraries may use appropriate compatible ranges.

CI actions should use explicit verified release versions rather than obsolete examples. Security-oriented SHA pinning may be introduced where appropriate, provided automated tooling is configured to keep the pinned digest current.

Container images used in reference/production Compose should also use deliberate reproducible versioning once an image is part of Loxep's tested stack. Do not confuse a convenient exploratory `latest` run with a reproducible supported deployment.

## Current intentional exceptions

Documented deviations from "newest stable, no prereleases" (reviewed whenever the surrounding stack moves):

- **`nitro` 3.x beta** in `apps/web`: the current TanStack Start Vite integration is built against the Nitro v3 line, which upstream currently ships as beta releases. It is pinned to an exact verified beta build and re-verified together with the TanStack Start/Router set rather than independently upgraded. Revisit whenever TanStack Start or Nitro publishes a stable pairing.
- **Deliberate-major queue**: upstream majors that exist but require real migration work (not drive-by bumps) are tracked as explicit issues rather than adopted silently or ignored silently. Renovate surfaces them; adoption happens through reviewed migrations with green builds.
- **TanStack Router set pinned below latest** in `apps/web` (`@tanstack/react-router` 1.170.8, `@tanstack/react-start` 1.168.12, `@tanstack/router-plugin` 1.168.11): upstream `router-core` ≥ 1.171.7 carries an open SSR streaming regression ([TanStack/router#7529](https://github.com/TanStack/router/issues/7529) — the query dehydration stream's close listener is silently dropped), which broke SSR dehydration on every `useQuery` page. Pinned to the last known-good `router-core` 1.171.6 as a self-consistent same-week set. Un-pinning is tracked as an explicit issue and happens when a release containing the upstream fix is verified. The deprecated `@tanstack/react-router-with-query` was replaced by `@tanstack/react-router-ssr-query` in the same change.

## Automated updates

Loxep intends to use Renovate for dependency maintenance because it supports Bun manifests/lockfiles as well as GitHub Actions and container references.

Automated updates do not remove the requirement to review major-version migrations. The desired workflow is:

- Renovate detects a new stable release;
- CI builds and tests the proposed update;
- breaking changes are reviewed where relevant;
- the dependency remains current rather than silently aging for years.

Lockfile maintenance should also be automated once the application workspace and root Bun lockfile are established.

## Agent instructions

When an agent introduces a dependency or changes a version, it should:

1. Check the current stable version from a current upstream/primary source.
2. Check compatibility with the project's runtime and related dependencies.
3. Use that version unless there is a concrete reason not to.
4. State/document the reason if deliberately selecting an older version.
5. Update lockfiles, container references, CI, and compatibility documentation where applicable.

Examples copied from documentation, starters, prior commits, or model memory are examples—not authoritative current version pins.
