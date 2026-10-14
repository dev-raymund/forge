-- M6-1: `uploads.cleanup` (daily) expires uploads that were never completed,
-- and removes refused ones, in every organization. RLS hides each
-- organization's rows from the others and from a context with no
-- organization, so the job first asks which organizations have any, then
-- works inside each one's own tenant context (withTenant). The only thing that
-- crosses tenants is this list of organization ids.
--
-- Same arrangement as the token lookups (0002, section 5): the function is
-- owned by forge_lookup (NOLOGIN), which may read only media_assets rows that
-- are not `ready`; forge_app may execute it but cannot become forge_lookup.
GRANT SELECT ON media_assets TO forge_lookup;
--> statement-breakpoint
CREATE POLICY media_assets_unfinished_lookup ON media_assets FOR SELECT TO forge_lookup USING (status <> 'ready');
--> statement-breakpoint
CREATE FUNCTION organizations_with_unfinished_uploads(p_before timestamptz, p_limit integer)
  RETURNS TABLE (organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT DISTINCT m.organization_id
    FROM media_assets m
    WHERE m.status <> 'ready' AND m.created_at < p_before
    LIMIT p_limit
  $$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO forge_lookup;
--> statement-breakpoint
ALTER FUNCTION organizations_with_unfinished_uploads(timestamptz, integer) OWNER TO forge_lookup;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM forge_lookup;
--> statement-breakpoint
REVOKE ALL ON FUNCTION organizations_with_unfinished_uploads(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION organizations_with_unfinished_uploads(timestamptz, integer) TO forge_app;
