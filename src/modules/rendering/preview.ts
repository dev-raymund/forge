import "server-only";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { contentType, parseDocument, referencesOf, roleMaySeeEntry } from "@/modules/content/shared";
import { publicImages } from "@/modules/media";
import { withTenant } from "@/platform/db";
import { domains, entries, entryDrafts, entryRevisions, organizationMembers, roles, terms } from "@/platform/db/schema";
import { previewSecret, verifyPreviewToken } from "@/platform/routing/preview-token";
import type { SiteLocator } from "@/platform/routing/hosts";
import { livePaths, type PublishedEntry } from "./content";
import { renderDocument, type SkipReason } from "./document";
import { loadPublicSite, type PublicSite } from "./queries";
import { isShowable } from "./render-state";

/**
 * Previews (M7-4; plan §9 "Preview"; ADR 0027): an entry's draft, or one of its revisions, drawn as its site would draw
 * it, for the person a preview token names. Read-only, and never cached:
 *
 *   the token     checked again here (the proxy checked it first): signed, not expired, naming an organization, a
 *                 site, an entry, a user and maybe a revision
 *   who           that user, as a member now, may see that entry (`roleMaySeeEntry`: an Author only their own posts, no
 *                 pages); a member removed or demoted since gets nothing
 *   what          the entry, not in the trash, of that site; its draft, or that revision of it; the site not deleted and
 *                 not suspended. Coming soon does not stop a preview: that is what a preview is for (ADR 0013)
 *   how           the same pieces as a published page: the closed renderer (`renderDocument`), the theme's templates
 *                 through `PublicPageView`, usable images of this site only (variants, never an original), and
 *                 `entry:` links to what is live on this site
 *
 * The draft, the revision, the person's role, the terms and the images are read here on every request, in the
 * organization's tenant transaction: nothing private is stored in a cache. What is public anyway is read through the
 * public cached reads: the site's settings and the live paths links go to.
 */

export type PreviewSubject =
  | { kind: "draft"; savedAt: string; /** The draft is the version visitors see. */ live: boolean }
  | {
      kind: "revision";
      number: number;
      revisionKind: string;
      label: string | null;
      createdAt: string;
      /** It is the revision visitors see now. */
      live: boolean;
      /** It is the frozen revision of the schedule under way: when it publishes. */
      scheduledFor: string | null;
    };

export type Preview = {
  site: PublicSite;
  locator: SiteLocator;
  entry: PublishedEntry;
  links: Record<string, string>;
  status: string;
  subject: PreviewSubject;
  /** What the preview cannot show, counted (the document as stored, drawn by the closed renderer). */
  gaps: PreviewGaps;
};

export type PreviewGaps = {
  /** Nodes the renderer does not draw because they are unknown, invalid, out of place or past its limits. */
  broken: number;
  /** Images (blocks and the featured image) that are not usable images of this site now. */
  missingImages: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The preview a token opens, or null for anything it may not show (one answer: nothing says why). */
export async function loadPreview(token: string, now: number = Date.now()): Promise<Preview | null> {
  const secret = previewSecret();
  const claims = secret ? verifyPreviewToken(token, secret, now) : null;
  if (!claims) return null;
  const site = await loadPublicSite(claims.orgId, claims.siteId);
  if (!site || !isShowable(site)) return null;

  const found = await withTenant({ orgId: claims.orgId }, async (tx) => {
    const [member] = await tx
      .select({ role: roles.key })
      .from(organizationMembers)
      .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
      .where(and(eq(organizationMembers.organizationId, claims.orgId), eq(organizationMembers.userId, claims.userId)));
    if (!member) return null;
    const [entry] = await tx
      .select()
      .from(entries)
      .where(and(eq(entries.organizationId, claims.orgId), eq(entries.siteId, claims.siteId), eq(entries.id, claims.entryId), isNull(entries.deletedAt)));
    if (!entry || !roleMaySeeEntry(member.role, claims.userId, { type: entry.type, authorId: entry.authorId })) return null;
    const definition = contentType(entry.type);
    if (!definition) return null;

    let source: { title: string; template: string | null; content: unknown; featuredMediaId: string | null; termIds: string[] };
    let subject: PreviewSubject;
    const liveRevision = entry.publishedRevisionId
      ? (await tx.select({ id: entryRevisions.id, sourceDraftVersion: entryRevisions.sourceDraftVersion }).from(entryRevisions).where(and(eq(entryRevisions.organizationId, claims.orgId), eq(entryRevisions.siteId, claims.siteId), eq(entryRevisions.id, entry.publishedRevisionId))))[0]
      : undefined;
    if (claims.revisionId === null) {
      const [draft] = await tx
        .select()
        .from(entryDrafts)
        .where(and(eq(entryDrafts.organizationId, claims.orgId), eq(entryDrafts.siteId, claims.siteId), eq(entryDrafts.entryId, entry.id)));
      if (!draft) return null;
      source = draft;
      subject = { kind: "draft", savedAt: draft.updatedAt.toISOString(), live: entry.status === "published" && liveRevision?.sourceDraftVersion === draft.version };
    } else {
      const [revision] = await tx
        .select()
        .from(entryRevisions)
        .where(and(eq(entryRevisions.organizationId, claims.orgId), eq(entryRevisions.siteId, claims.siteId), eq(entryRevisions.entryId, entry.id), eq(entryRevisions.id, claims.revisionId)));
      if (!revision) return null;
      const [frozen] =
        entry.status === "scheduled"
          ? await tx
              .select({ id: entryRevisions.id })
              .from(entryRevisions)
              .where(and(eq(entryRevisions.organizationId, claims.orgId), eq(entryRevisions.siteId, claims.siteId), eq(entryRevisions.entryId, entry.id), eq(entryRevisions.kind, "scheduled")))
              .orderBy(desc(entryRevisions.number))
              .limit(1)
          : [];
      source = revision;
      subject = {
        kind: "revision", number: revision.number, revisionKind: revision.kind, label: revision.label, createdAt: revision.createdAt.toISOString(),
        live: revision.id === entry.publishedRevisionId,
        scheduledFor: frozen?.id === revision.id && entry.scheduledAt ? entry.scheduledAt.toISOString() : null,
      };
    }

    // What it shows, checked as a published page is: the document migrated and checked if it passes (the renderer checks
    // every node again either way), the terms that are still this site's, the images that are usable images of this site.
    const parsed = parseDocument(source.content);
    const content = parsed.ok ? parsed.document : source.content;
    const termIds = definition.supports.taxonomies.length ? source.termIds.filter((id) => UUID.test(id)) : [];
    const assigned = termIds.length
      ? await tx
          .select({ taxonomy: terms.taxonomy, name: terms.name, slug: terms.slug, description: terms.description })
          .from(terms)
          .where(and(eq(terms.organizationId, claims.orgId), eq(terms.siteId, claims.siteId), inArray(terms.id, termIds), inArray(terms.taxonomy, [...definition.supports.taxonomies])))
          .orderBy(terms.taxonomy, terms.name)
      : [];
    const featuredMediaId = definition.supports.featuredImage ? source.featuredMediaId : null;
    const mediaIds = [...new Set([...referencesOf(content).mediaIds, ...(featuredMediaId ? [featuredMediaId] : [])])];
    const images = await publicImages(tx, claims.orgId, claims.siteId, mediaIds);
    const [address] = await tx
      .select({ hostname: domains.hostname })
      .from(domains)
      .where(and(eq(domains.siteId, claims.siteId), eq(domains.kind, "subdomain"), eq(domains.status, "active")));
    const published: PublishedEntry = {
      type: entry.type,
      title: source.title,
      path: entry.path,
      template: definition.supports.templates ? source.template : null,
      content,
      publishedAt: entry.publishedAt?.toISOString() ?? null,
      terms: assigned,
      images,
      featuredImage: featuredMediaId ? (images[featuredMediaId] ?? null) : null,
    };
    return { entry: published, status: entry.status, subject, address: address?.hostname ?? null, missingImages: mediaIds.filter((id) => !Object.hasOwn(images, id)).length };
  });
  if (!found || !found.address) return null;

  // `entry:` links go where they go on the live site; a page that is not live has no address there.
  const links = await livePaths(claims.orgId, claims.siteId, site.language, [...referencesOf(found.entry.content).entryIds].sort());
  return {
    site,
    locator: { kind: "address", address: found.address },
    entry: found.entry,
    links,
    status: found.status,
    subject: found.subject,
    gaps: { broken: brokenNodes(found.entry), missingImages: found.missingImages },
  };
}

/** How many nodes the closed renderer leaves out because of the document itself (not because what they point at is gone). */
function brokenNodes(entry: PublishedEntry): number {
  let broken = 0;
  renderDocument(entry.content, {
    resolveEntryHref: () => "/",
    resolveImage: (id) => (Object.hasOwn(entry.images, id) ? entry.images[id] : undefined),
    onSkip: (_type, reason: SkipReason) => {
      if (reason !== "not drawn") broken++;
    },
  });
  return broken;
}
