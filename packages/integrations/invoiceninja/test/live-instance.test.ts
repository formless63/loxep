/**
 * LIVE leg — a REAL self-hosted Invoice Ninja v5 instance, read-only-intended
 * company API token.
 *
 * Skips cleanly when ~/.config/loxep/invoiceninja.env is absent (CI, a fresh
 * clone, and — as of this writing — this development environment: a live
 * instance runs on this host, `invoiceninja-web`/`invoiceninja` containers,
 * `X-APP-VERSION: 5.13.24`, but no API token for it was ever provided here,
 * so this whole suite has never run authenticated in this environment).
 *
 * ## What this suite is for
 *
 * `@loxep/integration-invoiceninja` was built from Invoice Ninja's own
 * GitHub source (`v5-stable` branch, fetched 2026-08-13) plus one
 * UNAUTHENTICATED probe against the live instance on this host (see
 * `src/errors.ts`'s module doc — the `X-API-TOKEN`/403/"Invalid token" shape
 * is genuinely live-confirmed). Every WRITE path — `createClient`,
 * `updateClient`, `createInvoice`, `updateInvoice`, `markInvoiceSent` — and
 * every money/pagination/timestamp claim about an AUTHENTICATED response
 * rests on source reading alone. This suite is the answer to "but does a
 * running backend actually behave that way?", written to keep answering it
 * once a real token exists:
 *
 * ```text
 * 1 X-API-TOKEN auth (write path)        → "authenticates a real client create/read round-trip"
 * 2 {data, meta.pagination} envelope     → "returns the documented Fractal ArraySerializer envelope"
 * 3 money = plain major-unit JSON numbers → "reports client/invoice money as plain numbers"
 * 4 Unix-SECONDS timestamps               → "reports updated_at as Unix seconds, not ms or ISO"
 * 5 draft → mark_sent transition          → "assigns a number and a portal link on mark_sent"
 * ```
 *
 * ## ABSOLUTE RULES to honor once this suite runs for real
 *
 * - **Read-mostly, and self-cleaning.** The one write this suite needs
 *   (create a throwaway client + draft invoice to read the shapes back) must
 *   target data this test itself created — never touch a real client's
 *   existing invoices.
 * - **No credential material anywhere.** The token is never printed,
 *   asserted by value, or interpolated into a message.
 * - **No customer PII in any test output** — mirror
 *   `@loxep/integration-medusa`'s `live-store.test.ts` `check()`/redaction
 *   discipline: assert structural shape (regexes, booleans, decimal-string
 *   checks), never raw names/emails.
 *
 * This file intentionally contains NO live assertions yet — writing them
 * against a shape this package has never observed authenticated would be
 * guessing with extra steps. Populating them is the follow-up bead's job,
 * once ~/.config/loxep/invoiceninja.env exists with real credentials
 * pointed at a THROWAWAY instance (never a production one — this suite
 * creates data).
 */
import { describe, it } from "vitest";
import { loadInvoiceNinjaCredentialsFromEnvFile, defaultInvoiceNinjaEnvFilePath } from "../src/index.ts";

const ENV_PATH = defaultInvoiceNinjaEnvFilePath();
const creds = loadInvoiceNinjaCredentialsFromEnvFile();

if (creds === null) {
  // eslint-disable-next-line no-console
  console.info(
    `[live-instance] skipped: no credentials at ${ENV_PATH} — see this file's module doc`,
  );
}

const describeLive = creds === null ? describe.skip : describe;

describeLive("Invoice Ninja v5 instance (live, write-capable)", () => {
  it.todo(
    "authenticates a real client create/read round-trip via X-API-TOKEN — pending a credential",
  );
  it.todo(
    "returns the documented {data, meta.pagination} Fractal ArraySerializer envelope",
  );
  it.todo("reports client/invoice money as plain major-unit JSON numbers");
  it.todo("reports updated_at/created_at as Unix SECONDS, not ms or ISO");
  it.todo("assigns a number and populates invitations[0].link on mark_sent");
});
