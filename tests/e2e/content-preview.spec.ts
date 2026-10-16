import { createHmac, randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { uuidv7 } from "uuidv7";
import { asUniqueVisitor } from "./helpers/auth";
import { markEmailVerified, seedOrganization, sitesIn } from "./helpers/orgs";
import { createSite, expectSiteCreated, memberOf } from "./helpers/site-ui";
import { addMember, inTenant, seedUser } from "./helpers/sites";

/**
 * M7-4 end to end against the production build: the editor's preview of the draft (what is typed is saved first; the
 * site's theme; a coming-soon site; a new tab; the headers; a tampered or expired link), and the history's preview of a
 * revision (read-only, named, beside the editor that keeps what is typed; restoring from it is a separate step).
 */

test.describe.configure({ timeout: 120_000 });

const tail = () => randomBytes(3).toString("hex");
const editor = (page: Page) => page.getByTestId("editor");
const saved = (page: Page) => expect(page.getByTestId("autosave-status")).toHaveText(/^Saved at/, { timeout: 15_000 });
const notice = (page: Page) => page.locator('[data-form-alert][role="status"]').filter({ visible: true });
const history = (page: Page) => page.getByTestId("history-dialog");
const frame = (page: Page) => page.frameLocator('[data-testid="preview-frame"]');

async function withSite(page: Page, { live }: { live: boolean }) {
  const org = await seedOrganization("prev");
  await addMember(org.id, (await seedUser("Olive Owner")).email, "owner");
  const member = await memberOf(page, "owner", org);
  await markEmailVerified(member.email);
  const address = `prev-${tail()}`;
  await page.goto(`/${org.slug}/sites/new`);
  await createSite(page, { name: "Harbour Bakery", address });
  await expectSiteCreated(page, org.slug, address);
  const [site] = await sitesIn(org.id);
  const base = `/${org.slug}/sites/${site!.slug}`;
  if (live) {
    await page.goto(base);
    await page.getByRole("button", { name: "Publish site…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Publish site" }).click();
    await expect(page.getByTestId("site-status").filter({ visible: true })).toHaveText("Live", { timeout: 15_000 });
  }
  return { org, site: site!, base, address, member };
}

async function seedPost(orgId: string, siteId: string, title: string, slug: string, text: string) {
  const id = uuidv7();
  const content = { v: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text }] }] } };
  await inTenant(orgId, async (c) => {
    await c.query("insert into entries (id, organization_id, site_id, type, locale, title, slug, path) values ($1, $2, $3, 'post', 'en', $4, $5, $6)", [id, orgId, siteId, title, slug, `/blog/${slug}`]);
    await c.query("insert into entry_drafts (entry_id, organization_id, site_id, title, slug, content) values ($1, $2, $3, $4, $5, $6)", [id, orgId, siteId, title, slug, JSON.stringify(content)]);
  });
  return id;
}
const draftText = async (orgId: string, id: string) =>
  JSON.stringify((await inTenant(orgId, (c) => c.query<{ content: unknown }>("select content from entry_drafts where entry_id = $1", [id]))).rows[0]!.content);
const revisionCount = async (orgId: string, id: string) =>
  Number((await inTenant(orgId, (c) => c.query<{ n: string }>("select count(*) as n from entry_revisions where entry_id = $1", [id]))).rows[0]!.n);

async function typeAtEnd(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(text);
}

/** The same token, re-signed with the server's (local) development secret after its expiry is moved into the past. */
function expired(path: string): string {
  const [payload] = path.split("/").at(-1)!.split(".") as [string];
  const body = { ...JSON.parse(Buffer.from(payload, "base64url").toString()), x: Math.floor(Date.now() / 1000) - 60 };
  const moved = Buffer.from(JSON.stringify(body)).toString("base64url");
  const signature = createHmac("sha256", "forge-local-development-preview-secret-not-for-production").update(`forge-preview:v1:${moved}`).digest("base64url");
  return `/_forge/preview/${moved}.${signature}`;
}

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("preview the draft: what is typed is saved first, the site's theme draws it on a Coming soon site, in a new tab too; private headers; a changed or expired link is a 404", async ({ page, browser }) => {
  const { org, site, base, address } = await withSite(page, { live: false });
  const id = await seedPost(org.id, site.id, "Rye season", "rye-season", "Saved words.");
  await page.goto(`${base}/posts/${id}`);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });

  // Typed and previewed at once: the preview waits for the save, so it shows what is typed.
  await typeAtEnd(page, " Typed just now.");
  await page.getByRole("button", { name: "Preview" }).click();
  const dialog = page.getByTestId("preview-dialog");
  await expect(dialog.getByRole("heading", { name: "Preview of the draft" })).toBeVisible();
  await expect(frame(page).getByTestId("preview-banner")).toContainText("Preview of the draft", { timeout: 15_000 });
  await expect(frame(page).getByTestId("preview-banner")).toContainText("The site is not live yet: visitors see its Coming soon page.");
  await expect(frame(page).getByRole("heading", { level: 1 })).toHaveText("Rye season");
  await expect(frame(page).getByRole("main")).toContainText("Saved words. Typed just now.");
  expect(await draftText(org.id, id)).toContain("Typed just now.");
  const before = await revisionCount(org.id, id);

  // The link: private, never indexed or stored, framed by the admin only, no cookie set or read.
  const href = (await dialog.getByRole("link", { name: "Open in a new tab" }).getAttribute("href"))!;
  expect(href).toMatch(/^\/_forge\/preview\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  const response = await page.request.get(href);
  expect(response.status()).toBe(200);
  const headers = response.headers();
  expect(headers["cache-control"]).toContain("private");
  expect(headers["cache-control"]).toContain("no-store");
  expect(headers["x-robots-tag"]).toBe("noindex, nofollow");
  expect(headers["x-frame-options"]).toBe("SAMEORIGIN");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'self'");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["set-cookie"]).toBeUndefined();
  expect(await response.text()).toMatch(/<meta name="robots" content="noindex, nofollow"/);

  // In a new tab.
  const [tab] = await Promise.all([page.context().waitForEvent("page"), dialog.getByRole("link", { name: "Open in a new tab" }).click()]);
  await expect(tab.getByTestId("preview-banner")).toContainText("Preview of the draft");
  await expect(tab.getByRole("main")).toContainText("Typed just now.");
  await tab.close();

  // Visitors still see Coming soon; a changed or expired link is nothing; the internal route is not reachable.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/s/${address}/blog/rye-season`);
  await expect(visitor.locator("body")).not.toContainText("Typed just now.");
  const changed = `${href.slice(0, -1)}${href.endsWith("A") ? "B" : "A"}`;
  for (const path of [changed, expired(href), href.replace("/_forge/preview/", "/render/preview/")]) {
    const answer = await visitor.request.get(path);
    expect(answer.status(), path).toBe(404);
    expect(await answer.text()).not.toContain("Typed just now.");
  }
  await visitor.context().close();

  // Looking added nothing to the history.
  await page.keyboard.press("Escape");
  expect(await revisionCount(org.id, id)).toBe(before);
});

test("preview a revision from the history: named and read-only beside an editor that keeps what is typed; Live marked; restoring is a separate, confirmed step; a Viewer only looks", async ({ page, browser }) => {
  const { org, site, base, member } = await withSite(page, { live: true });
  const id = await seedPost(org.id, site.id, "Rye season", "rye-season", "First words.");
  await page.goto(`${base}/posts/${id}`);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(notice(page)).toHaveText("Saved as revision 1.");
  await typeAtEnd(page, " Published words.");
  await saved(page);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Published", { timeout: 15_000 });

  // Typed, and the history opened before it is saved: previewing does not touch it.
  await typeAtEnd(page, " Unsaved yet.");
  await page.getByRole("button", { name: "History" }).click();
  await history(page).getByRole("button", { name: "Preview revision 1" }).click();
  const shown = history(page).getByTestId("revision-preview");
  await expect(shown).toContainText("Revision 1");
  await expect(shown).toContainText("Saved");
  await expect(shown.getByTestId("revision-preview-note")).toContainText("Viewing it changes nothing: it is not restored or published, and your draft is as you left it.");
  await expect(frame(page).getByTestId("preview-banner")).toContainText("Preview of revision 1 · Saved", { timeout: 15_000 });
  await expect(frame(page).getByTestId("preview-banner")).toContainText("Visitors do not see this revision.");
  await expect(frame(page).getByRole("main")).toContainText("First words.");
  await expect(frame(page).getByRole("main")).not.toContainText("Published words.");

  // Back to the history, then the Live one.
  await shown.getByRole("button", { name: "Back to the history" }).click();
  await history(page).getByRole("button", { name: "Preview revision 2" }).click();
  await expect(history(page).getByTestId("revision-preview").getByTestId("live-marker")).toHaveText("Live");
  await expect(history(page).getByTestId("revision-preview-note")).toContainText("which is what visitors see now");
  await expect(frame(page).getByTestId("preview-banner")).toContainText("Visitors see this revision now.", { timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(history(page)).toBeHidden();

  // The editor kept what was typed, and saved it; looking made no revision.
  await expect(editor(page)).toContainText("First words. Published words. Unsaved yet.");
  await saved(page);
  expect(await draftText(org.id, id)).toContain("Unsaved yet.");
  expect(await revisionCount(org.id, id)).toBe(2);

  // Restoring from a preview: refused while another tab has saved since (nothing changes), then done once current.
  const other = await page.context().newPage();
  await other.goto(`${base}/posts/${id}`);
  await expect(editor(other)).toBeVisible({ timeout: 15_000 });
  await typeAtEnd(other, " Elsewhere.");
  await saved(other);
  await page.getByRole("button", { name: "History" }).click();
  await history(page).getByRole("button", { name: "Preview revision 1" }).click();
  await history(page).getByRole("button", { name: "Restore this revision…" }).click();
  await history(page).getByTestId("restore-confirm").getByRole("button", { name: "Restore revision 1" }).click();
  await expect(history(page).getByTestId("revision-preview")).toContainText("The draft has changed since this was opened");
  expect(await draftText(org.id, id)).toContain("Elsewhere.");
  expect(await revisionCount(org.id, id)).toBe(2);
  await other.close();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(editor(page)).toContainText("Elsewhere.", { timeout: 15_000 });
  await page.getByRole("button", { name: "History" }).click();
  await history(page).getByRole("button", { name: "Preview revision 1" }).click();
  await history(page).getByRole("button", { name: "Restore this revision…" }).click();
  await history(page).getByTestId("restore-confirm").getByRole("button", { name: "Restore revision 1" }).click();
  await expect(notice(page)).toHaveText("Revision 1 is in the draft now. Nothing is published until you publish it.", { timeout: 15_000 });
  await expect(editor(page)).toHaveText("First words.");

  // A Viewer previews, and is offered nothing to restore.
  await addMember(org.id, member.email, "viewer");
  await page.reload();
  await page.getByRole("button", { name: "History" }).click();
  await history(page).getByRole("button", { name: "Preview revision 2" }).click();
  await expect(frame(page).getByTestId("preview-banner")).toContainText("Preview of revision 2", { timeout: 15_000 });
  await expect(history(page).getByRole("button", { name: "Restore this revision…" })).toHaveCount(0);
  void browser;
});
