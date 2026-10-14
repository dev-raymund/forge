-- M6-2: `/media/{key}` serves an object only through the record that owns it.
-- The request has no session and no tenant context (the URL is public), and
-- RLS hides every organization's rows from such a context. This lookup
-- answers one question for one media id: is this key one of that item's
-- public objects? It says so only for an item that is `ready` and not
-- trashed, and only for an image's variants or a document's file (an image's
-- original keeps its metadata, GPS included, and is never served).
--
-- Same arrangement as the other lookups (0002 section 5, 0007): owned by
-- forge_lookup (NOLOGIN), which may read ready, untrashed rows (this policy)
-- and unfinished ones (0007's); forge_app may execute it but cannot become
-- forge_lookup.
CREATE POLICY media_assets_public_lookup ON media_assets FOR SELECT TO forge_lookup USING (status = 'ready' AND deleted_at IS NULL);
--> statement-breakpoint
CREATE FUNCTION public_media_object(p_media_id uuid, p_key text)
  RETURNS TABLE (organization_id uuid, site_id uuid, content_type text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.organization_id, m.site_id,
           CASE WHEN m.kind = 'document' AND m.storage_key = p_key THEN m.mime_type ELSE 'image/' || v.format END
    FROM media_assets m
    LEFT JOIN LATERAL (
      SELECT e->>'format' AS format FROM jsonb_array_elements(m.variants) e WHERE e->>'storageKey' = p_key LIMIT 1
    ) v ON true
    WHERE m.id = p_media_id AND m.status = 'ready' AND m.deleted_at IS NULL
      AND ((m.kind = 'document' AND m.storage_key = p_key) OR (m.kind = 'image' AND v.format IS NOT NULL))
  $$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO forge_lookup;
--> statement-breakpoint
ALTER FUNCTION public_media_object(uuid, text) OWNER TO forge_lookup;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM forge_lookup;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public_media_object(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public_media_object(uuid, text) TO forge_app;
