-- M6-3: `trash.purge` (daily) deletes media that has been in the trash for 30
-- days, with its objects, in every organization. As `uploads.cleanup` does
-- (0007), it first asks which organizations have any, then works inside each
-- one's own tenant context; only organization ids cross tenants.
--
-- forge_lookup may already read unfinished rows (0007) and ready, untrashed
-- ones (0009); this lets it read trashed ones too, for this function only.
CREATE POLICY media_assets_trashed_lookup ON media_assets FOR SELECT TO forge_lookup USING (deleted_at IS NOT NULL);
--> statement-breakpoint
CREATE FUNCTION organizations_with_purgeable_media(p_before timestamptz, p_limit integer)
  RETURNS TABLE (organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT DISTINCT m.organization_id
    FROM media_assets m
    WHERE m.deleted_at IS NOT NULL AND m.deleted_at < p_before
    LIMIT p_limit
  $$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO forge_lookup;
--> statement-breakpoint
ALTER FUNCTION organizations_with_purgeable_media(timestamptz, integer) OWNER TO forge_lookup;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM forge_lookup;
--> statement-breakpoint
REVOKE ALL ON FUNCTION organizations_with_purgeable_media(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION organizations_with_purgeable_media(timestamptz, integer) TO forge_app;
