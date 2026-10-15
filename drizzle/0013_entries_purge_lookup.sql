-- M7-1: `trash.purge` (daily) also deletes entries that have been in the trash
-- for 30 days, in every organization. As for media (0011), it first asks which
-- organizations have any, then works inside each one's own tenant context; only
-- organization ids cross tenants.
--
-- forge_lookup (NOLOGIN) may read entries that are in the trash, for this
-- function only: nothing it returns names a site, an entry, a title or a path.
GRANT SELECT ON entries TO forge_lookup;
--> statement-breakpoint
CREATE POLICY entries_trashed_lookup ON entries FOR SELECT TO forge_lookup USING (deleted_at IS NOT NULL);
--> statement-breakpoint
CREATE FUNCTION organizations_with_purgeable_entries(p_before timestamptz, p_limit integer)
  RETURNS TABLE (organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT DISTINCT e.organization_id
    FROM entries e
    WHERE e.deleted_at IS NOT NULL AND e.deleted_at < p_before
    LIMIT p_limit
  $$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO forge_lookup;
--> statement-breakpoint
ALTER FUNCTION organizations_with_purgeable_entries(timestamptz, integer) OWNER TO forge_lookup;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM forge_lookup;
--> statement-breakpoint
REVOKE ALL ON FUNCTION organizations_with_purgeable_entries(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION organizations_with_purgeable_entries(timestamptz, integer) TO forge_app;
