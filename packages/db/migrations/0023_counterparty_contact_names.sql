-- Trading partners M1, migration A (loxep-cd3.1) — Invoice Ninja contact
-- parity. Physical realization of
-- `apps/docs/src/content/docs/architecture/expense-entry-design.md` section
-- 2's "one schema gap, two columns" finding.
--
-- `buildInvoiceNinjaClientPayload` (`@loxep/integration-invoiceninja`) had no
-- source for `contacts[].first_name` / `last_name` — `counterparty_contacts`
-- carried only `display_name`. Every other field Invoice Ninja's client
-- parity needs already exists elsewhere (tax_identifier, sites, channels,
-- payment_terms_days); this was the one genuine gap.
--
-- Both columns nullable, no backfill, no constraint: `display_name` stays
-- NOT NULL and stays authoritative for every Loxep surface, because a
-- contact may legitimately be "Accounts Payable" rather than a person.
--
-- Drizzle-generated: `bun --cwd packages/db generate` emitted this from the
-- two nullable `text` columns added to `packages/db/src/schema/
-- counterparties.ts`'s `counterpartyContacts` table — nothing hand-written.
ALTER TABLE "counterparty_contacts" ADD COLUMN "given_name" text;--> statement-breakpoint
ALTER TABLE "counterparty_contacts" ADD COLUMN "family_name" text;