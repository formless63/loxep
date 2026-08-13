# Medusa live-verification harness

`packages/integrations/medusa/test/live-store.test.ts` and
`packages/app/test/live-medusa-sync.test.ts` run against a **real Medusa v2
backend**, not fixtures. Both skip cleanly when `~/.config/loxep/medusa.env` is
absent, so a checkout with no harness still has a green suite — the harness is
how you turn those skips into assertions.

Everything below stands up a throwaway store on loopback only. It was first
provisioned on 2026-08-12 against **Medusa 2.18.0**, which is the version whose
observed behaviour the adapter's findings and the `loxep-xxz` translator
mappings are written against.

## Why this exists as checked-in files

The stack originally lived in a session scratchpad, which is not durable: the
containers were the only thing keeping it alive. The compose file, the nginx
config, and the two provisioning scripts are checked in here so tier-3
verification stays reproducible; the two things that genuinely cannot be
checked in are called out at each step.

## What the stack is

```text
medusa-verify-db      postgres:17-alpine        127.0.0.1:5439
medusa-verify-app     node:24-bookworm-slim     127.0.0.1:9000   `npx medusa develop`
medusa-verify-proxy   nginx:alpine              127.0.0.1:9443   self-signed TLS terminator
```

Compose project `medusa-verify`, fully isolated from the Loxep dev stack
(`loxep`, `loxep-db`, `loxep-db-dev`). Named containers, no one-shot
containers — the same rule the rest of this repo follows.

**The TLS terminator is not decoration.** `packages/integrations/medusa/src/config.ts`
refuses a non-`https` base URL, and that rule is production-correct: it must not
be relaxed so a test can talk to `http://localhost:9000`. The harness satisfies
the rule instead of weakening it, and the live tests trust exactly one
self-signed certificate rather than disabling verification.

## Setup

### 1. Scaffold the Medusa application (once)

Medusa v2 publishes no first-party backend image; the application is generated
per project. Scaffold it **outside this repo** — it is large, it carries its own
lockfile, and it is not Loxep's source:

```bash
export MEDUSA_VERIFY_APP_DIR="$HOME/.local/share/loxep/medusa-verify-app"
mkdir -p "$MEDUSA_VERIFY_APP_DIR"
npx create-medusa-app@latest --skip-db --no-browser   # answer: apps/backend
```

The compose file expects the backend at `$MEDUSA_VERIFY_APP_DIR/apps/backend`
(its `working_dir`). Its `medusa-config.ts` needs only the stock shape —
`databaseUrl` from `DATABASE_URL` plus the `http` CORS/secret block — since the
harness passes `DATABASE_URL` in through compose.

### 2. Generate the self-signed certificate (once)

Certificates are **deliberately not checked in** — a private key in a git
repository is a finding, not a convenience. From this directory:

```bash
mkdir -p harness/tls
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout harness/tls/key.pem -out harness/tls/cert.pem \
  -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
```

`harness/tls/` is git-ignored. `cert.pem` is what `MEDUSA_CA_CERT_FILE` points
at, and what the live tests add to their trust store for that process only.

### 3. Bring the stack up

```bash
cd packages/integrations/medusa/test/harness
MEDUSA_VERIFY_APP_DIR="$HOME/.local/share/loxep/medusa-verify-app" \
  docker compose up -d
docker compose logs -f medusa      # first boot installs dependencies; be patient
curl -sk https://127.0.0.1:9443/health
```

Then run Medusa's own migrations and seed inside the app container:

```bash
docker exec -w /app/apps/backend medusa-verify-app npx medusa db:migrate
docker exec -w /app/apps/backend medusa-verify-app npm run seed
```

The seed is what creates the region, the products, and the **publishable** API
key that `seed-orders.mjs` reads back out of the database.

### 4. Create the admin user

```bash
docker exec -w /app/apps/backend medusa-verify-app \
  npx medusa user -e admin@medusa-verify.local -p '<choose-a-password>'
```

Keep that password out of the repo. Every script below takes it as
`MEDUSA_VERIFY_ADMIN_PW`; nothing writes it to disk.

### 5. Mint the secret API key and write the credentials file

```bash
cd packages/integrations/medusa/test/harness
MEDUSA_VERIFY_ADMIN_PW='<the password>' node mint-key.mjs
```

Writes `~/.config/loxep/medusa.env` (mode 0600) with `MEDUSA_URL`,
`MEDUSA_RO_API_TOKEN`, and `MEDUSA_CA_CERT_FILE` — exactly what
`loadMedusaCredentialsFromEnvFile()` reads. The script prints the key's id,
type, redacted form, and token LENGTH, and never the token itself.

**The credentials file lives in `~/.config/loxep/`, never in this repo**, and no
secret value is ever printed, asserted, or snapshotted.

### 6. Seed orders worth asserting against

```bash
MEDUSA_VERIFY_ADMIN_PW='<the password>' node seed-orders.mjs
```

Places three orders and then, admin-side, captures payment on the first,
captures **and partially refunds** the second, and fulfils the third.

The partially-refunded order is the one that earns the whole harness: Medusa
subtracts a refund from `order.total` while `original_total` stays put (live:
30 → 25 after a €5 refund). That is why the Loxep translator persists
`originalTotal` as `orders.total_amount` and never `total` — a ledger amount
that changes on re-sync is exactly the bug this order exists to catch. No
fixture can prove it, because a fixture is written by the same person who
believes the wrong mapping.

## Running the live suites

```bash
bun --cwd packages/integrations/medusa test           # live-store.test.ts unskips
bun --cwd packages/app test live-medusa-sync          # the composition-root leg
```

`packages/app`'s live sync test additionally needs the harness certificate
trusted by the vitest process, because `packages/app`'s adapter factories have
no fetch seam and must not grow a production one for a test:

```bash
NODE_EXTRA_CA_CERTS="$(pwd)/packages/integrations/medusa/test/harness/tls/cert.pem" \
  bun --cwd packages/app test live-medusa-sync
```

Rules the live suites hold to, and any new one must: no credential material and
no customer PII in an assertion, a log line, or a snapshot; thrown messages
rebuilt from hand-written labels so a vitest diff cannot print a payload; the
scratch database dropped afterwards so retained provider payloads do not outlive
the run; read-only and bounded (`perPage` 5, `maxPages` 2) against the store.

## Tear down

```bash
cd packages/integrations/medusa/test/harness
docker compose down -v          # -v also drops the harness database volume
rm -f ~/.config/loxep/medusa.env
```

Everything in the stack is throwaway. There is no state worth keeping between
verification runs, and re-running steps 3–6 rebuilds it in a few minutes.
