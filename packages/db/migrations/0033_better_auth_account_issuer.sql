-- Better Auth 1.7 scopes external identities by (issuer, account_id).
--
-- Loxep 1.6 had exactly one configured OAuth provider id (`oidc`) and
-- recognized returning accounts by (provider_id, account_id). Preserve that
-- identity rather than silently re-keying existing users to whatever issuer
-- an OIDC discovery document returns during the first 1.7 sign-in. Credential
-- rows are included defensively even though password login is disabled.
--
-- Unknown providers and projected collisions abort the transaction. They need
-- an operator-reviewed mapping; inventing an issuer could link the wrong user.
ALTER TABLE "account" ADD COLUMN "issuer" text;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "account"
		WHERE "provider_id" NOT IN ('credential', 'oidc')
	) THEN
		RAISE EXCEPTION 'Better Auth 1.7 account migration found an unrecognized provider_id; review and map it before retrying';
	END IF;
END
$$;--> statement-breakpoint
UPDATE "account"
SET "issuer" = CASE "provider_id"
	WHEN 'credential' THEN 'local:credential'
	WHEN 'oidc' THEN 'local:oauth:oidc'
END;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "account"
		GROUP BY "issuer", "account_id"
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'Better Auth 1.7 account migration found duplicate provider-scoped identities; resolve them before retrying';
	END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" USING btree ("issuer","account_id");
