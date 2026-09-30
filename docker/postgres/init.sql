-- Local/CI only. Mirrors the production role split (v1-build-plan §4.3):
--   forge_owner  owns the schema and runs migrations (CI only in production)
--   forge_app    runtime role: owns nothing, cannot bypass RLS
-- Passwords here are development values; production roles are created in
-- the Neon console (docs/runbooks/environments.md).

CREATE ROLE forge_owner LOGIN PASSWORD 'forge_owner' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE forge_app   LOGIN PASSWORD 'forge_app'   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- The integration-test harness clones a template database per test worker,
-- which needs CREATEDB on the owner role in local/CI environments only.
ALTER ROLE forge_owner CREATEDB;

ALTER DATABASE forge OWNER TO forge_owner;
\connect forge
ALTER SCHEMA public OWNER TO forge_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO forge_app;
