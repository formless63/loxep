-- The HA/all image update installs TimescaleDB 2.29.2 on the PostgreSQL
-- server, but PostgreSQL deliberately leaves each existing database's
-- extension at its previously installed version. `runMigrations` performs the
-- required ALTER EXTENSION on a fresh connection before entering Drizzle's
-- schema-migration transaction. This append-only marker does two jobs:
--
--   1. make existing installations fail readiness until the operator runs the
--      explicit `loxep migrate` command after replacing the database image;
--   2. refuse to record a successful schema migration when the server image
--      cannot provide the exact TimescaleDB version Loxep supports.
--
-- Do not move ALTER EXTENSION into this file. Timescale requires that command
-- to be the first command in a fresh session, while Drizzle runs migration SQL
-- after migration-ledger queries and inside a transaction.
DO $loxep$
DECLARE
	installed_version text;
BEGIN
	SELECT extversion
	  INTO installed_version
	  FROM pg_catalog.pg_extension
	 WHERE extname = 'timescaledb';

	IF installed_version IS NULL THEN
		RAISE EXCEPTION
			'TimescaleDB extension is not installed; use the supported TimescaleDB image and retry loxep migrate';
	END IF;

	IF installed_version <> '2.29.2' THEN
		RAISE EXCEPTION
			'TimescaleDB extension version % is unsupported; expected 2.29.2',
			installed_version;
	END IF;
END
$loxep$;
