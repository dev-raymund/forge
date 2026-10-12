import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { createEntry, getEntryForEditor, publishEntry, saveDraft } from "@/modules/content";
import { createSite } from "@/modules/sites";
import { inTenant, resolveSiteContext, type SiteContext } from "@/modules/tenancy";
import * as t from "@/platform/db/schema";
import { createMedia } from "../fixtures/factories";
import { addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

/**
 * M5-5 against real Postgres: documents with the custom blocks are saved and
 * read back whole, and what they point at (images, pages and posts) must be
 * the site's own. The ids in a document come from the browser: never trusted.
 */

type Tenant = Awaited<ReturnType<typeof newTenant>>;

async function newSite(tenant: Tenant, name = "Blocks") {
  const { site } = await createSite(tenant.ctx, { name, address: newSlug("blocks"), language: "en", timezone: "UTC" });
  return { site, ctx: await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug) };
}
const homeOf = async (ctx: SiteContext) =>
  (await inTenant(ctx, (tx) => tx.select({ id: t.siteSettings.homepageEntryId }).from(t.siteSettings).where(eq(t.siteSettings.siteId, ctx.site.id))))[0]!.id!;
const mediaOf = async (tenant: Tenant, ctx: SiteContext) => (await createMedia({ orgId: tenant.org.id, siteId: ctx.site.id, userId: tenant.user.id })).media;
const versionOf = async (ctx: SiteContext, id: string) => (await getEntryForEditor(ctx, id, "page")).draft.version;

const block = {
  paragraph: (text: string) => ({ type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text }] }),
  button: (href: string) => ({ type: "button", attrs: { id: uuidv7(), v: 1, label: "Go", href, style: "primary", align: "start", newTab: false } }),
  image: (mediaId: string) => ({ type: "image", attrs: { id: uuidv7(), v: 1, mediaId, alt: "A photo", caption: null, size: "content", link: null } }),
  link: (href: string) => ({ type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text: "a link", marks: [{ type: "link", attrs: { href } }] }] }),
};
const doc = (...content: unknown[]) => ({ v: 1, doc: { type: "doc", content } });

/** Every custom block the editor makes, and an internal link in a button inside columns. */
function everyBlock(entryId: string) {
  return doc(
    { type: "heading", attrs: { id: uuidv7(), level: 2 }, content: [{ type: "text", text: "Welcome" }] },
    {
      type: "columns",
      attrs: { id: uuidv7(), v: 1, count: 3, ratio: "1:2:1", stackOnMobile: false },
      content: [
        { type: "column", attrs: { id: uuidv7() }, content: [block.paragraph("Left")] },
        { type: "column", attrs: { id: uuidv7() }, content: [block.button(`entry:${entryId}`), { type: "spacer", attrs: { id: uuidv7(), v: 1, size: "sm" } }] },
        { type: "column", attrs: { id: uuidv7() }, content: [block.paragraph("Right")] },
      ],
    },
    { type: "embed", attrs: { id: uuidv7(), v: 1, provider: "youtube", url: "https://youtu.be/dQw4w9WgXcQ", aspect: "16:9" } },
    { type: "embed", attrs: { id: uuidv7(), v: 1, provider: "vimeo", url: "https://vimeo.com/76979871", aspect: "4:3" } },
    { type: "embed", attrs: { id: uuidv7(), v: 1, provider: "generic", url: "https://www.openstreetmap.org/export/embed.html", aspect: "1:1" } },
    { type: "spacer", attrs: { id: uuidv7(), v: 1, size: "xl" } },
    block.button("https://example.org/book"),
  );
}

describe("saving and reading back documents with custom blocks", () => {
  it("every block is stored and read back exactly; a stale save after it is a conflict and changes nothing", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const home = await homeOf(ctx);
    const about = (await createEntry(ctx, { type: "page", title: "About" })).entry;
    const content = everyBlock(about.id);
    const { version } = await saveDraft(ctx, home, 1, { content });
    expect(version).toBe(2);
    expect((await getEntryForEditor(ctx, home, "page")).draft.content).toEqual(content);

    // Autosave from a second tab that still has version 1.
    const stale = await refusalOf(() => saveDraft(ctx, home, 1, { content: doc(block.paragraph("Older")) }));
    expect(stale.kind).toBe("Conflict");
    expect((await getEntryForEditor(ctx, home, "page")).draft).toMatchObject({ version: 2, content });

    // And it publishes.
    expect(await publishEntry(ctx, home, 2)).toMatchObject({ changed: true });
  });

  it("refuses unknown blocks, nested columns and unsafe attributes with the person-facing message, and stores nothing", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const home = await homeOf(ctx);
    const inner = { type: "columns", attrs: { id: uuidv7(), v: 1, count: 2, ratio: "1:1", stackOnMobile: true }, content: [] };
    for (const content of [
      doc({ type: "html", attrs: { id: uuidv7(), html: "<script>alert(1)</script>" } }),
      doc({ type: "columns", attrs: { id: uuidv7(), v: 1, count: 2, ratio: "1:1", stackOnMobile: true }, content: [{ type: "column", attrs: { id: uuidv7() }, content: [inner] }, { type: "column", attrs: { id: uuidv7() }, content: [block.paragraph("x")] }] }),
      doc(block.button("javascript:alert(1)")),
      doc({ type: "embed", attrs: { id: uuidv7(), v: 1, provider: "generic", url: "https://localhost/admin", aspect: "16:9" } }),
      doc({ type: "embed", attrs: { id: uuidv7(), v: 1, provider: "youtube", url: "https://evil.example.org/watch?v=dQw4w9WgXcQ", aspect: "16:9" } }),
    ]) {
      const refusal = await refusalOf(() => saveDraft(ctx, home, 1, { content }));
      expect(refusal, JSON.stringify(content)).toMatchObject({ kind: "Validation", fieldErrors: { content: ["This content contains something Forge cannot save."] } });
    }
    expect(await versionOf(ctx, home)).toBe(1);
  });

  it("only those who may edit the entry save it: a Viewer cannot", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const viewer = await addMember(a.org, "viewer");
    const viewerCtx = await resolveSiteContext(viewer.actor, a.org.slug, site.slug);
    const home = await homeOf(ctx);
    expect((await refusalOf(() => saveDraft(viewerCtx, home, 1, { content: doc(block.button("/")) }))).kind).toBe("Forbidden");
  });
});

describe("images in a document are this site's media", () => {
  it("a ready image of this site is accepted", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const media = await mediaOf(a, ctx);
    expect(await saveDraft(ctx, await homeOf(ctx), 1, { content: doc(block.image(media.id)) })).toEqual({ version: 2 });
  });

  it("refused: another site's of the organization, another organization's, an id of nothing, a deleted one, one not uploaded yet", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const sibling = await newSite(a, "Sibling");
    const b = await newTenant();
    const other = await newSite(b, "Other");
    const deleted = await mediaOf(a, ctx);
    const pending = await mediaOf(a, ctx);
    await inTenant(ctx, async (tx) => {
      await tx.update(t.mediaAssets).set({ deletedAt: new Date() }).where(eq(t.mediaAssets.id, deleted.id));
      await tx.update(t.mediaAssets).set({ status: "pending" }).where(eq(t.mediaAssets.id, pending.id));
    });
    const home = await homeOf(ctx);
    const cases = { sibling: (await mediaOf(a, sibling.ctx)).id, otherOrg: (await mediaOf(b, other.ctx)).id, nothing: uuidv7(), deleted: deleted.id, pending: pending.id };
    for (const [name, mediaId] of Object.entries(cases)) {
      const refusal = await refusalOf(() => saveDraft(ctx, home, 1, { content: doc(block.paragraph("Hi"), block.image(mediaId)) }));
      expect(refusal, name).toMatchObject({ kind: "Validation", fieldErrors: { content: ["An image is not one of this site's."] } });
    }
    expect(await versionOf(ctx, home)).toBe(1);
  });

  it("an image already in the draft is not checked again: deleting it later never makes an unrelated edit unsavable", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const home = await homeOf(ctx);
    const media = await mediaOf(a, ctx);
    const image = block.image(media.id);
    await saveDraft(ctx, home, 1, { content: doc(image) });
    await inTenant(ctx, (tx) => tx.update(t.mediaAssets).set({ deletedAt: new Date() }).where(eq(t.mediaAssets.id, media.id)));
    expect(await saveDraft(ctx, home, 2, { content: doc(image, block.paragraph("Edited")) })).toEqual({ version: 3 });
  });
});

describe("links in a document go to this site's pages and posts", () => {
  it("a button or a text link to an entry of this site is accepted, drafted or published", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const draft = (await createEntry(ctx, { type: "page", title: "Draft page" })).entry;
    const post = (await createEntry(ctx, { type: "post", title: "A post" })).entry;
    expect(await saveDraft(ctx, await homeOf(ctx), 1, { content: doc(block.button(`entry:${draft.id}`), block.link(`entry:${post.id.toUpperCase()}`)) })).toEqual({ version: 2 });
  });

  it("refused: another site's entry, another organization's, an id of nothing, one in the trash; in a button, a text link, or an image's link", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const sibling = await newSite(a, "Sibling");
    const other = await newSite(await newTenant(), "Other");
    const trashed = (await createEntry(ctx, { type: "page", title: "Trashed" })).entry;
    await inTenant(ctx, (tx) => tx.update(t.entries).set({ deletedAt: new Date() }).where(eq(t.entries.id, trashed.id)));
    const home = await homeOf(ctx);
    const media = await mediaOf(a, ctx);
    const targets = { sibling: await homeOf(sibling.ctx), otherOrg: await homeOf(other.ctx), nothing: uuidv7(), trashed: trashed.id };
    for (const [name, id] of Object.entries(targets)) {
      const imageLink = { ...block.image(media.id), attrs: { ...block.image(media.id).attrs, link: `entry:${id}` } };
      for (const node of [block.button(`entry:${id}`), block.link(`entry:${id}`), imageLink]) {
        const refusal = await refusalOf(() => saveDraft(ctx, home, 1, { content: doc(node) }));
        expect(refusal, `${name} ${node.type}`).toMatchObject({ kind: "Validation", fieldErrors: { content: ["A link points to a page or post that is not on this site."] } });
      }
    }
  });

  it("a link already in the draft is not checked again: trashing its page later never makes an unrelated edit unsavable", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const home = await homeOf(ctx);
    const about = (await createEntry(ctx, { type: "page", title: "About" })).entry;
    const button = block.button(`entry:${about.id}`);
    await saveDraft(ctx, home, 1, { content: doc(button) });
    await inTenant(ctx, (tx) => tx.update(t.entries).set({ deletedAt: new Date() }).where(eq(t.entries.id, about.id)));
    expect(await saveDraft(ctx, home, 2, { content: doc(button, block.paragraph("Edited")) })).toEqual({ version: 3 });
    expect(await publishEntry(ctx, home, 3)).toMatchObject({ changed: true }); // a link to a page in the trash renders as nothing (M5-6)
  });
});

describe("publishing never publishes a pointer to another site of the organization", () => {
  it("a draft that points at a sibling site's entry or image (written before these checks, or around them) is not published", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const sibling = await newSite(a, "Sibling");
    const home = await homeOf(ctx);
    const theirs = { entry: await homeOf(sibling.ctx), media: (await mediaOf(a, sibling.ctx)).id };
    const write = (content: unknown) =>
      inTenant(ctx, (tx) => tx.update(t.entryDrafts).set({ content: content as typeof t.entryDrafts.$inferInsert.content }).where(eq(t.entryDrafts.entryId, home)));

    await write(doc(block.button(`entry:${theirs.entry}`)));
    expect(await refusalOf(() => publishEntry(ctx, home, 1))).toMatchObject({ kind: "Validation", fieldErrors: { content: ["A link points to a page or post that is not on this site."] } });
    await write(doc(block.image(theirs.media)));
    expect(await refusalOf(() => publishEntry(ctx, home, 1))).toMatchObject({ kind: "Validation", fieldErrors: { content: ["An image is not one of this site's."] } });
    const live = await inTenant(ctx, (tx) => tx.select({ status: t.entries.status }).from(t.entries).where(eq(t.entries.id, home)));
    expect(live[0]!.status).toBe("draft");

    await write(doc(block.paragraph("Fine")));
    expect(await publishEntry(ctx, home, 1)).toMatchObject({ changed: true });
  });
});
