-- Local/CI only. Mirrors the production role split (v1-build-plan §4.3):
--   forge_owner  owns the schema and runs migrations (CI only in production)
--   forge_app    runtime role: owns nothing, cannot bypass RLS
--   forge_lookup NOLOGIN owner of the token-lookup functions (ADR 0001)
-- Passwords here are development values. On Neon, create these roles with SQL,
-- not the console (console-created roles join neon_superuser) — see
-- docs/runbooks/environments.md.

CREATE ROLE forge_owner LOGIN PASSWORD 'forge_owner' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE forge_app   LOGIN PASSWORD 'forge_app'   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
-- Owns the SECURITY DEFINER token lookups (resolve_api_key, resolve_invitation).
-- NOLOGIN; forge_owner is a member only so migrations can assign function ownership.
CREATE ROLE forge_lookup NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT forge_lookup TO forge_owner;

-- The integration-test harness clones a template database per test worker and
-- drops the previous run's clones (terminating PgBouncer's idle server
-- connections to them). Local/CI only — never grant these on Neon.
ALTER ROLE forge_owner CREATEDB;
GRANT pg_signal_backend TO forge_owner;

ALTER DATABASE forge OWNER TO forge_owner;
\connect forge
ALTER SCHEMA public OWNER TO forge_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO forge_app;
