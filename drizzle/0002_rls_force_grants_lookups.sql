-- Hand-written companion to 0001_v1_schema (D-04, D-30, v1-build-plan §4.2–4.3).
-- Everything here is something drizzle-kit cannot express.

-- 1. FORCE row-level security on every tenant and membership table, so RLS also
--    applies to the table owner. Only the SECURITY DEFINER lookups below (owned
--    by forge_lookup, with their own role-scoped SELECT policy) read across tenants.
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organization_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organization_invitations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sites FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE site_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE entries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE entry_drafts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE entry_revisions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE terms FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE entry_terms FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE media_folders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE media_assets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE menus FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE redirects FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- 2. Intra-site references with ON DELETE SET NULL (column). A plain composite
--    SET NULL would also null site_id (NOT NULL) and fail; the column list
--    (Postgres 15+) nulls only the reference.
ALTER TABLE entries ADD CONSTRAINT entries_parent_fk
  FOREIGN KEY (site_id, parent_id) REFERENCES entries (site_id, id) ON DELETE SET NULL (parent_id);
--> statement-breakpoint
ALTER TABLE entries ADD CONSTRAINT entries_featured_media_fk
  FOREIGN KEY (site_id, featured_media_id) REFERENCES media_assets (site_id, id) ON DELETE SET NULL (featured_media_id);
--> statement-breakpoint
-- A published revision must be one of this entry's own revisions.
ALTER TABLE entries ADD CONSTRAINT entries_published_revision_fk
  FOREIGN KEY (id, published_revision_id) REFERENCES entry_revisions (entry_id, id);
--> statement-breakpoint
ALTER TABLE entry_drafts ADD CONSTRAINT entry_drafts_featured_media_fk
  FOREIGN KEY (site_id, featured_media_id) REFERENCES media_assets (site_id, id) ON DELETE SET NULL (featured_media_id);
--> statement-breakpoint
ALTER TABLE site_settings ADD CONSTRAINT site_settings_homepage_fk
  FOREIGN KEY (site_id, homepage_entry_id) REFERENCES entries (site_id, id) ON DELETE SET NULL (homepage_entry_id);
--> statement-breakpoint
ALTER TABLE site_settings ADD CONSTRAINT site_settings_not_found_fk
  FOREIGN KEY (site_id, not_found_entry_id) REFERENCES entries (site_id, id) ON DELETE SET NULL (not_found_entry_id);
--> statement-breakpoint
ALTER TABLE site_settings ADD CONSTRAINT site_settings_logo_fk
  FOREIGN KEY (site_id, logo_media_id) REFERENCES media_assets (site_id, id) ON DELETE SET NULL (logo_media_id);
--> statement-breakpoint
ALTER TABLE site_settings ADD CONSTRAINT site_settings_favicon_fk
  FOREIGN KEY (site_id, favicon_media_id) REFERENCES media_assets (site_id, id) ON DELETE SET NULL (favicon_media_id);
--> statement-breakpoint
ALTER TABLE terms ADD CONSTRAINT terms_parent_fk
  FOREIGN KEY (site_id, parent_id) REFERENCES terms (site_id, id) ON DELETE SET NULL (parent_id);
--> statement-breakpoint
ALTER TABLE media_folders ADD CONSTRAINT media_folders_parent_fk
  FOREIGN KEY (site_id, parent_id) REFERENCES media_folders (site_id, id) ON DELETE SET NULL (parent_id);
--> statement-breakpoint
ALTER TABLE media_assets ADD CONSTRAINT media_assets_folder_fk
  FOREIGN KEY (site_id, folder_id) REFERENCES media_folders (site_id, id) ON DELETE SET NULL (folder_id);
--> statement-breakpoint

-- 3. Trigram indexes for admin type-ahead.
CREATE INDEX entry_drafts_title_trgm_idx ON entry_drafts USING gin (title gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX media_assets_search_trgm_idx ON media_assets
  USING gin ((title || ' ' || original_filename || ' ' || alt_text) gin_trgm_ops);
--> statement-breakpoint

-- 4. Grants for the runtime role. forge_app owns nothing and cannot bypass RLS.
GRANT USAGE ON SCHEMA public TO forge_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO forge_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO forge_app;
--> statement-breakpoint
-- Append-only audit log (D-30).
REVOKE UPDATE, DELETE ON audit_logs FROM forge_app;
--> statement-breakpoint
-- Revisions are immutable snapshots; DELETE stays for retention pruning.
REVOKE UPDATE ON entry_revisions FROM forge_app;
--> statement-breakpoint
-- Roles are reference data in V1.
REVOKE INSERT, UPDATE, DELETE ON roles FROM forge_app;
--> statement-breakpoint

-- 5. Token lookups before the tenant is known (v1-build-plan §4.3).
--    FORCE RLS applies to the table owner too, so a SECURITY DEFINER function
--    owned by forge_owner would see nothing. The functions are owned by
--    forge_lookup (NOLOGIN, created with the other roles), which has SELECT on
--    exactly these two tables and a role-scoped policy granting it all rows.
--    forge_app can execute the functions but cannot become forge_lookup.
GRANT USAGE ON SCHEMA public TO forge_lookup;
--> statement-breakpoint
GRANT SELECT ON api_keys, organization_invitations TO forge_lookup;
--> statement-breakpoint
CREATE POLICY api_keys_lookup ON api_keys FOR SELECT TO forge_lookup USING (true);
--> statement-breakpoint
CREATE POLICY organization_invitations_lookup ON organization_invitations FOR SELECT TO forge_lookup USING (true);
--> statement-breakpoint
CREATE FUNCTION resolve_api_key(p_secret_hash text)
  RETURNS TABLE (key_id uuid, organization_id uuid, site_id uuid, scope text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT k.id, k.organization_id, k.site_id, k.scope
    FROM api_keys k
    WHERE k.secret_hash = p_secret_hash AND k.revoked_at IS NULL
  $$;
--> statement-breakpoint
CREATE FUNCTION resolve_invitation(p_token_hash text)
  RETURNS TABLE (invitation_id uuid, organization_id uuid, email text, role_id uuid,
                 expires_at timestamptz, accepted_at timestamptz, revoked_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT i.id, i.organization_id, i.email, i.role_id, i.expires_at, i.accepted_at, i.revoked_at
    FROM organization_invitations i
    WHERE i.token_hash = p_token_hash
  $$;
--> statement-breakpoint
-- A function's new owner must hold CREATE on its schema; grant it only for the
-- ownership change so forge_lookup can never create objects afterwards.
GRANT CREATE ON SCHEMA public TO forge_lookup;
--> statement-breakpoint
ALTER FUNCTION resolve_api_key(text) OWNER TO forge_lookup;
--> statement-breakpoint
ALTER FUNCTION resolve_invitation(text) OWNER TO forge_lookup;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM forge_lookup;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_api_key(text), resolve_invitation(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_api_key(text), resolve_invitation(text) TO forge_app;
--> statement-breakpoint

-- 6. System roles (reference data). Their permissions live in code (§13).
INSERT INTO roles (id, organization_id, key, name) VALUES
  ('01a0f24f-2e47-7096-87c2-3a8404bc1243', NULL, 'owner',  'Owner'),
  ('01a0f24f-2e48-7167-86ed-71219ebeaa68', NULL, 'admin',  'Admin'),
  ('01a0f24f-2e48-7167-86ed-71229c8a8fd1', NULL, 'editor', 'Editor'),
  ('01a0f24f-2e48-7167-86ed-7123ab9a2d36', NULL, 'author', 'Author'),
  ('01a0f24f-2e48-7167-86ed-7124e5e1cdc4', NULL, 'viewer', 'Viewer');
