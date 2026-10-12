import { inTenant } from "./sites";

/** Content as the database holds it (M5-4), read inside the organization's context. */

export type DraftRecord = { title: string; slug: string; version: number; content: { v: number; doc: { type: string; content?: unknown[] } } };
export type EntryRecord = { id: string; type: string; status: string; path: string; title: string };

export async function homePageOf(orgId: string, siteId: string): Promise<string | null> {
  const { rows } = await inTenant(orgId, (c) => c.query<{ id: string | null }>("select homepage_entry_id as id from site_settings where site_id = $1", [siteId]));
  return rows[0]?.id ?? null;
}

export async function draftOf(orgId: string, entryId: string): Promise<DraftRecord> {
  const { rows } = await inTenant(orgId, (c) => c.query<DraftRecord>("select title, slug, version, content from entry_drafts where entry_id = $1", [entryId]));
  return rows[0]!;
}

export async function entryOf(orgId: string, entryId: string): Promise<EntryRecord & { revisions: number }> {
  const { rows } = await inTenant(orgId, (c) =>
    c.query<EntryRecord & { revisions: number }>(
      "select id, type, status, path, title, (select count(*)::int from entry_revisions r where r.entry_id = e.id) as revisions from entries e where id = $1",
      [entryId],
    ),
  );
  return rows[0]!;
}

/** A draft entry made behind the app's back, as M5-7's forms will make them: the row and its draft (an empty paragraph). */
export async function seedEntry(
  orgId: string,
  siteId: string,
  entry: { id: string; type: "page" | "post"; title: string; slug: string; path: string; paragraphId: string; extraBlocks?: unknown[] },
) {
  await inTenant(orgId, async (c) => {
    await c.query("insert into entries (id, organization_id, site_id, type, locale, title, slug, path) values ($1, $2, $3, $4, 'en', $5, $6, $7)", [
      entry.id, orgId, siteId, entry.type, entry.title, entry.slug, entry.path,
    ]);
    const content = { v: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: entry.paragraphId } }, ...(entry.extraBlocks ?? [])] } };
    await c.query("insert into entry_drafts (entry_id, organization_id, site_id, title, slug, content) values ($1, $2, $3, $4, $5, $6)", [
      entry.id, orgId, siteId, entry.title, entry.slug, JSON.stringify(content),
    ]);
  });
}

/** Removes the site's Home page, as a site made before M5-3 is. */
export async function removeHomePage(orgId: string, siteId: string) {
  await inTenant(orgId, (c) => c.query("delete from entries where site_id = $1 and path = '/'", [siteId]));
}
