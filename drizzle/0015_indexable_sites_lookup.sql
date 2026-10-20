-- M8-4: the app host's robots.txt (path mode, V1) lists the sitemap of every
-- site that is live and allows indexing, whichever organization it belongs to.
-- Only public addresses cross tenants: the address is what `/s/{address}`
-- already shows to anyone, and nothing else is returned.
--
-- forge_lookup (NOLOGIN) may read, for this function only: live sites that are
-- not deleted (their id, organization and status), their SEO settings (the
-- discourage-indexing flag is all that is used), and their active platform
-- addresses.
GRANT SELECT (id, organization_id, status, deleted_at) ON sites TO forge_lookup;
--> statement-breakpoint
CREATE POLICY sites_live_lookup ON sites FOR SELECT TO forge_lookup USING (status = 'live' AND deleted_at IS NULL);
--> statement-breakpoint
GRANT SELECT (site_id, organization_id, seo) ON site_settings TO forge_lookup;
--> statement-breakpoint
CREATE POLICY site_settings_seo_lookup ON site_settings FOR SELECT TO forge_lookup USING (true);
--> statement-breakpoint
GRANT SELECT (site_id, organization_id, hostname, kind, status) ON domains TO forge_lookup;
--> statement-breakpoint
CREATE FUNCTION indexable_site_addresses(p_limit integer)
  RETURNS TABLE (address text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT d.hostname
    FROM sites s
    JOIN domains d ON d.site_id = s.id AND d.organization_id = s.organization_id
    LEFT JOIN site_settings ss ON ss.site_id = s.id AND ss.organization_id = s.organization_id
    WHERE s.status = 'live' AND s.deleted_at IS NULL
      AND d.kind = 'subdomain' AND d.status = 'active'
      AND coalesce(ss.seo ->> 'discourageIndexing', 'false') <> 'true'
    ORDER BY d.hostname
    LIMIT p_limit
  $$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO forge_lookup;
--> statement-breakpoint
ALTER FUNCTION indexable_site_addresses(integer) OWNER TO forge_lookup;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM forge_lookup;
--> statement-breakpoint
REVOKE ALL ON FUNCTION indexable_site_addresses(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION indexable_site_addresses(integer) TO forge_app;
