-- Tenant context for Row-Level Security (D-04, ADR 0001).
--
-- withTenant() sets these with set_config(name, value, is_local = true) inside
-- every tenant transaction. Transaction-local is required behind PgBouncer in
-- transaction mode (Neon's pooled endpoint): a session-level SET would stay on
-- the server connection and leak to the next client that borrows it.
--
-- nullif(…, '') matters: once a server connection has run a transaction that
-- set a local value, current_setting(name, true) returns '' (not NULL) in later
-- transactions on that connection. Both "never set" and "set earlier" must
-- mean "no tenant", so policies compare against NULL and match nothing.

CREATE OR REPLACE FUNCTION app_current_org_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
-- Trigram search for admin type-ahead (titles, media filenames/alt text).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
