import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { uuidv7 } from "uuidv7";
import { asUniqueVisitor } from "./helpers/auth";
import { markEmailVerified, seedOrganization, sitesIn } from "./helpers/orgs";
import { createSite, expectSiteCreated, memberOf } from "./helpers/site-ui";
import { addMember, inTenant, seedUser } from "./helpers/sites";

/**
 * M7-3 end to end against the production build: "Save" and the history, restoring a revision into the draft (by
 * keyboard; the public page keeps the published version until Publish), a Viewer reading the history, and the conflict
 * dialog's overwrite (it names the newer save, keeps it in the history, and refuses one saved after it said so).
 */

test.describe.configure({ timeout: 120_000 });

const tail = () => randomBytes(3).toString("hex");
const editor = (page: Page) => page.getByTestId("editor");
const saved = (page: Page) => expect(page.getByTestId("autosave-status")).toHaveText(/^Saved at/, { timeout: 15_000 });
const notice = (page: Page) => page.locator('[data-form-alert][role="status"]').filter({ visible: true });
const history = (page: Page) => page.getByTestId("history-dialog");
const revision = (page: Page, number: number) => history(page).locator(`[data-testid="revision"][data-number="${number}"]`);

async function withLiveSite(page: Page) {
  const org = await seedOrganization("revs");
  await addMember(org.id, (await seedUser("Olive Owner")).email, "owner");
  const member = await memberOf(page, "owner", org);
  await markEmailVerified(member.email);
  const address = `revs-${tail()}`;
  await page.goto(`/${org.slug}/sites/new`);
  await createSite(page, { name: "Harbour Bakery", address });
  await expectSiteCreated(page, org.slug, address);
  const [site] = await sitesIn(org.id);
  const base = `/${org.slug}/sites/${site!.slug}`;
  await page.goto(base);
  await page.getByRole("button", { name: "Publish site…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish site" }).click();
  await expect(page.getByTestId("site-status").filter({ visible: true })).toHaveText("Live", { timeout: 15_000 });
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
const revisionTexts = async (orgId: string, id: string) =>
  (await inTenant(orgId, (c) => c.query<{ number: number; kind: string; content: unknown }>("select number, kind, content from entry_revisions where entry_id = $1 order by number", [id]))).rows.map(
    (row) => ({ number: row.number, kind: row.kind, text: JSON.stringify(row.content) }),
  );

async function typeAtEnd(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(text);
}

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("Save keeps a revision; the history lists them; restoring one by keyboard puts it in the draft, and visitors keep the published version until Publish", async ({ page, browser }) => {
  const { org, site, base, address, member } = await withLiveSite(page);
  const id = await seedPost(org.id, site.id, "Rye season", "rye-season", "First words.");
  await page.goto(`${base}/posts/${id}`);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });

  // Save: revision 1 ("First words."). Saving again with nothing changed is the same revision.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(notice(page)).toHaveText("Saved as revision 1.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(notice(page)).toHaveText("Already in the history as revision 1.");
  // Published: revision 2 ("First words. More."). Then a change kept only in the draft.
  await typeAtEnd(page, " More.");
  await saved(page);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Published", { timeout: 15_000 });
  await typeAtEnd(page, " Draft only.");
  await saved(page);

  // The history, opened with the keyboard: newest first, the live one marked; a labelled save from inside it.
  await page.getByRole("button", { name: "History" }).focus();
  await page.keyboard.press("Enter");
  await expect(history(page)).toBeVisible();
  await expect(history(page).getByTestId("revision")).toHaveCount(2);
  await expect(revision(page, 2)).toContainText("Published");
  await expect(revision(page, 2).getByTestId("live-marker")).toHaveText("Live");
  await expect(revision(page, 1)).toContainText("Saved");
  await expect(revision(page, 1)).toContainText("Rye season · You");
  await history(page).getByLabel("Save the draft as it is now, with a label (optional)").fill("Before the rewrite");
  await history(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(revision(page, 3).getByTestId("revision-label")).toHaveText("Before the rewrite");

  // Restore revision 1, by keyboard: the confirmation says what it does; the editor loads the draft again.
  await history(page).getByRole("button", { name: "Restore revision 1" }).focus();
  await page.keyboard.press("Enter");
  await expect(history(page).getByTestId("restore-confirm")).toContainText("What the draft holds now is kept in the history first. Nothing is published");
  await history(page).getByTestId("restore-confirm").getByRole("button", { name: "Restore revision 1" }).focus();
  await page.keyboard.press("Enter");
  await expect(notice(page)).toHaveText("Revision 1 is in the draft now. Nothing is published until you publish it.", { timeout: 15_000 });
  await expect(editor(page)).toHaveText("First words.");
  await expect(page.getByTestId("entry-status")).toHaveText("Published, with unpublished changes");
  expect(await draftText(org.id, id)).not.toContain("More.");
  expect((await revisionTexts(org.id, id)).map(({ number, kind }) => ({ number, kind }))).toEqual([
    { number: 1, kind: "save" },
    { number: 2, kind: "publish" },
    { number: 3, kind: "save" },
    { number: 4, kind: "restore" },
  ]);

  // Visitors still get the published version, until Publish.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/s/${address}/blog/rye-season`);
  await expect(visitor.getByRole("main")).toContainText("First words. More.");
  await expect(visitor.getByRole("main")).not.toContainText("Draft only.");
  await page.getByRole("button", { name: "Publish changes" }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Published", { timeout: 15_000 });
  await visitor.reload();
  await expect(visitor.getByRole("main")).not.toContainText("More.");
  await visitor.context().close();

  // A Viewer reads the history, and is offered nothing to change.
  await addMember(org.id, member.email, "viewer");
  await page.reload();
  await page.getByRole("button", { name: "History" }).click();
  await expect(history(page).getByTestId("revision")).toHaveCount(5);
  await expect(history(page).getByRole("button", { name: /^Restore/ })).toHaveCount(0);
  await expect(history(page).getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
});

test("a conflict: the dialog names the newer save; overwrite keeps it in the history, refuses one saved after the dialog said so, and the editor goes on", async ({ page }) => {
  const { org, site, base } = await withLiveSite(page);
  const id = await seedPost(org.id, site.id, "Shared", "shared", "Base.");
  const other = await page.context().newPage();
  await page.goto(`${base}/posts/${id}`);
  await other.goto(`${base}/posts/${id}`);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await expect(editor(other)).toBeVisible({ timeout: 15_000 });

  // The other tab saves first; this one's next save is a conflict.
  await typeAtEnd(other, " Theirs.");
  await saved(other);
  await typeAtEnd(page, " Mine.");
  const dialog = page.getByTestId("conflict-dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByTestId("conflict-head")).toHaveText(/^The newer version was saved by you, in another tab or window, at .+\.$/);
  await expect(dialog.getByRole("button", { name: "Copy my changes" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Load the latest version" })).toBeVisible();

  await dialog.getByRole("button", { name: "Overwrite with my version…" }).click();
  await expect(dialog.getByTestId("overwrite-confirm")).toContainText("is kept in the history first, so it can be restored");
  // Saved again in the other tab while this dialog is open: refused, and the dialog shows the newer save.
  await typeAtEnd(other, " Again.");
  await saved(other);
  await dialog.getByRole("button", { name: "Overwrite", exact: true }).click();
  await expect(dialog.getByTestId("overwrite-confirm")).toContainText("The draft was saved again while you were deciding.");
  expect(await draftText(org.id, id)).toContain("Again.");
  await dialog.getByRole("button", { name: "Overwrite", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(notice(page)).toHaveText(/^Your version is saved\. The one it replaced is revision 1 in the history\.$/);
  expect(await draftText(org.id, id)).toContain("Base. Mine.");
  expect(await draftText(org.id, id)).not.toContain("Theirs.");
  const [kept] = await revisionTexts(org.id, id);
  expect(kept).toMatchObject({ number: 1, kind: "save" });
  expect(kept!.text).toContain("Base. Theirs. Again.");

  // The editor is editable again and saves from the new version.
  await typeAtEnd(page, " Onwards.");
  await saved(page);
  expect(await draftText(org.id, id)).toContain("Base. Mine. Onwards.");
  await other.close();
});
