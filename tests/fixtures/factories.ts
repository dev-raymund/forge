import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import * as t from "@/platform/db/schema";
import { withPlatform, withTenant, type TenantTx } from "@/platform/db/tenant";

/**
 * Test factories. Everything is created the way application code will create
 * it: as forge_app, through the pooled connection, inside withTenant() — so the
 * fixtures themselves exercise RLS WITH CHECK and the composite foreign keys.
 */

const unique = () => randomBytes(4).toString("hex");

export async function createUser(overrides: Partial<typeof t.users.$inferInsert> = {}) {
  const [user] = await withPlatform((tx) =>
    tx
      .insert(t.users)
      .values({ name: "Test User", email: `user-${unique()}@example.test`, emailVerified: true, ...overrides })
      .returning(),
  );
  return user!;
}

export async function roleId(tx: TenantTx, key: t.RoleKey): Promise<string> {
  const [role] = await tx.select({ id: t.roles.id }).from(t.roles).where(eq(t.roles.key, key));
  if (!role) throw new Error(`system role ${key} missing (migration 0002 seeds it)`);
  return role.id;
}

export async function createOrganization(ownerId: string, name = `Org ${unique()}`) {
  const orgId = uuidv7();
  return withTenant({ orgId, userId: ownerId }, async (tx) => {
    const [org] = await tx
      .insert(t.organizations)
      .values({ id: orgId, name, slug: `org-${unique()}`, createdBy: ownerId })
      .returning();
    await tx.insert(t.organizationMembers).values({
      organizationId: orgId,
      userId: ownerId,
      roleId: await roleId(tx, "owner"),
    });
    await tx.insert(t.subscriptions).values({ organizationId: orgId, planKey: "pro", status: "trialing" });
    return org!;
  });
}

export async function createSite(orgId: string, userId: string, slug = `site-${unique()}`) {
  return withTenant({ orgId, userId }, async (tx) => {
    const [site] = await tx
      .insert(t.sites)
      .values({ organizationId: orgId, name: slug, slug, createdBy: userId })
      .returning();
    await tx.insert(t.siteSettings).values({ siteId: site!.id, organizationId: orgId });
    await tx.insert(t.domains).values({
      organizationId: orgId,
      siteId: site!.id,
      hostname: `${slug}.sites.localhost`,
      kind: "subdomain",
      isPrimary: true,
      status: "active",
    });
    return site!;
  });
}

type Ids = { orgId: string; siteId: string; userId: string };

export async function createMedia({ orgId, siteId, userId }: Ids) {
  return withTenant({ orgId, userId }, async (tx) => {
    const [folder] = await tx
      .insert(t.mediaFolders)
      .values({ organizationId: orgId, siteId, name: `Folder ${unique()}` })
      .returning();
    const [media] = await tx
      .insert(t.mediaAssets)
      .values({
        organizationId: orgId,
        siteId,
        folderId: folder!.id,
        kind: "image",
        status: "ready",
        storageKey: `o/${orgId}/s/${siteId}/m/${uuidv7()}/v1/original.jpg`,
        originalFilename: "photo.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1234,
        uploadedBy: userId,
      })
      .returning();
    return { folder: folder!, media: media! };
  });
}

/** A published page with a draft, a publish revision, a category, and its term link. */
export async function createPublishedEntry({ orgId, siteId, userId }: Ids, mediaId?: string) {
  return withTenant({ orgId, userId }, async (tx) => {
    const slug = `page-${unique()}`;
    const [term] = await tx
      .insert(t.terms)
      .values({ organizationId: orgId, siteId, taxonomy: "category", name: "News", slug: `news-${unique()}` })
      .returning();
    const [entry] = await tx
      .insert(t.entries)
      .values({
        organizationId: orgId,
        siteId,
        type: "page",
        locale: "en",
        title: "Hello",
        slug,
        path: `/${slug}`,
        authorId: userId,
        featuredMediaId: mediaId ?? null,
      })
      .returning();
    const content = { v: 1, doc: { type: "doc", content: [] } };
    await tx.insert(t.entryDrafts).values({
      entryId: entry!.id,
      organizationId: orgId,
      siteId,
      title: "Hello",
      slug,
      content,
      termIds: [term!.id],
    });
    const [revision] = await tx
      .insert(t.entryRevisions)
      .values({
        organizationId: orgId,
        siteId,
        entryId: entry!.id,
        number: 1,
        kind: "publish",
        title: "Hello",
        slug,
        content,
        termIds: [term!.id],
        contentHash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
        sourceDraftVersion: 1,
      })
      .returning();
    await tx
      .update(t.entries)
      .set({ status: "published", publishedRevisionId: revision!.id, publishedAt: new Date(), firstPublishedAt: new Date() })
      .where(eq(t.entries.id, entry!.id));
    await tx.insert(t.entryTerms).values({ organizationId: orgId, siteId, entryId: entry!.id, termId: term!.id });
    return { entry: entry!, revision: revision!, term: term! };
  });
}

/**
 * A complete tenant: one row in every tenant-class table, so the isolation
 * suite can prove each table individually.
 */
export async function createTenantGraph() {
  const user = await createUser();
  const org = await createOrganization(user.id);
  const site = await createSite(org.id, user.id);
  const ids = { orgId: org.id, siteId: site.id, userId: user.id };
  const { folder, media } = await createMedia(ids);
  const { entry, revision, term } = await createPublishedEntry(ids, media.id);
  const apiKeySecret = `fk_test_${randomBytes(24).toString("hex")}`;
  const invitationToken = randomBytes(24).toString("hex");
  const extras = await withTenant({ orgId: org.id, userId: user.id }, async (tx) => {
    const [menu] = await tx
      .insert(t.menus)
      .values({ organizationId: org.id, siteId: site.id, location: "header", items: [] })
      .returning();
    const [redirect] = await tx
      .insert(t.redirects)
      .values({ organizationId: org.id, siteId: site.id, sourcePath: `/old-${unique()}`, destination: entry.path })
      .returning();
    const [apiKey] = await tx
      .insert(t.apiKeys)
      .values({
        organizationId: org.id,
        siteId: site.id,
        name: "Test key",
        prefix: apiKeySecret.slice(0, 12),
        secretHash: createHash("sha256").update(apiKeySecret).digest("hex"),
        scope: "read",
        createdBy: user.id,
      })
      .returning();
    const [invitation] = await tx
      .insert(t.organizationInvitations)
      .values({
        organizationId: org.id,
        email: `invitee-${unique()}@example.test`,
        roleId: await roleId(tx, "editor"),
        tokenHash: createHash("sha256").update(invitationToken).digest("hex"),
        invitedBy: user.id,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      })
      .returning();
    const [audit] = await tx
      .insert(t.auditLogs)
      .values({ organizationId: org.id, siteId: site.id, actorType: "user", actorId: user.id, action: "entry.published" })
      .returning();
    return { menu: menu!, redirect: redirect!, apiKey: apiKey!, invitation: invitation!, audit: audit! };
  });
  return { user, org, site, folder, media, entry, revision, term, apiKeySecret, invitationToken, ...extras };
}
