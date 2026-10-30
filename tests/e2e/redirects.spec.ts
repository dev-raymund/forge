import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { uuidv7 } from "uuidv7";
import { asUniqueVisitor } from "./helpers/auth";
import { axeViolations } from "./helpers/axe";
import { seedPublishedEntry } from "./helpers/content";
import { markEmailVerified, seedOrganization, sitesIn } from "./helpers/orgs";
import { createSite, expectSiteCreated, memberOf } from "./helpers/site-ui";
import { addMember, inTenant, seedSite, seedUser } from "./helpers/sites";

/**
 * M8-5 end to end against the production build: what a visitor's browser is sent (the status, `Location`) when a
 * published address changes in the admin (a post's slug, a page moved with the page below it, the blog's path) and for
 * redirects added on `/…/seo/redirects` (permanent, temporary, elsewhere; flattened; off; changed; deleted); unpublish's
 * "send visitors to…"; the site's own not-found page with a real 404; who may; a phone; no axe violation.
 */

test.describe.configure({ timeout: 120_000 });

const tail = () => randomBytes(3).toString("hex");
const id = () => uuidv7();
const doc = (text: string) => ({ v: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: id() }, content: [{ type: "text", text }] }] } });
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const editor = (page: Page) => page.getByTestId("editor");

/**
 * What a visitor of `path` is answered, without following a redirect. Next 16 writes a fresh (uncached) render's headers
 * twice (`link` is doubled on every page as well): every `Location` it sends must be the same address, and that is it.
 */
async function answer(request: APIRequestContext, path: string) {
  const response = await request.get(path, { maxRedirects: 0 });
  const locations = [...new Set(response.headersArray().filter((header) => header.name.toLowerCase() === "location").map((header) => header.value))];
  expect(locations.length, `${path}: ${locations.join(" | ")}`).toBeLessThanOrEqual(1);
  return { status: response.status(), location: locations[0] ?? null };
}
/** Until the answer is this one (a publish's flush is done by the time the editor says so, but the editor says it first). */
const answers = (request: APIRequestContext, path: string, expected: { status: number; location: string | null }) =>
  expect.poll(() => answer(request, path), { timeout: 15_000 }).toEqual(expected);

/** A member with a live site made through the form (Studio). */
async function withLiveSite(page: Page) {
  const org = await seedOrganization("redir");
  await addMember(org.id, (await seedUser("Olive Owner")).email, "owner");
  const member = await memberOf(page, "owner", org);
  await markEmailVerified(member.email);
  const address = `redir-${tail()}`;
  await page.goto(`/${org.slug}/sites/new`);
  await createSite(page, { name: "Harbour Bakery", address });
  await expectSiteCreated(page, org.slug, address);
  const [site] = await sitesIn(org.id);
  const base = `/${org.slug}/sites/${site!.slug}`;
  await page.goto(base);
  await page.getByRole("button", { name: "Publish site…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish site" }).click();
  await expect(page.getByTestId("site-status").filter({ visible: true })).toHaveText("Live", { timeout: 15_000 });
  return { org, site: site!, base, address, siteBase: `/s/${address}` };
}

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("a post's new slug and a moved page leave 308s from their old addresses (no query carried); canonical and sitemap name the new ones; renamed again, still one hop", async ({ page, request, baseURL }) => {
  const { org, site, base, siteBase } = await withLiveSite(page);
  const post = id();
  await seedPublishedEntry(org.id, site.id, { id: post, type: "post", title: "Rye", slug: "rye", path: "/blog/rye", content: doc("Rye is back.") });
  const [company, about, team] = [id(), id(), id()];
  await seedPublishedEntry(org.id, site.id, { id: company, type: "page", title: "Company", slug: "company", path: "/company", content: doc("Us.") });
  await seedPublishedEntry(org.id, site.id, { id: about, type: "page", title: "About", slug: "about", path: "/about", content: doc("About us.") });
  await seedPublishedEntry(org.id, site.id, { id: team, type: "page", title: "Team", slug: "team", path: "/about/team", parentId: about, content: doc("The team.") });
  expect(await answer(request, `${siteBase}/blog/rye`)).toEqual({ status: 200, location: null });

  // A new slug, published from the editor.
  await page.goto(`${base}/posts/${post}`);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("entry-settings").getByLabel("Slug").fill("rye-bread");
  await expect(page.getByTestId("autosave-status")).toHaveText(/^Saved at/, { timeout: 15_000 });
  await page.getByRole("button", { name: "Publish changes" }).click();
  await expect(page.getByText("Its old address /blog/rye redirects to /blog/rye-bread.")).toBeVisible({ timeout: 15_000 });
  await answers(request, `${siteBase}/blog/rye?utm_source=news#top`, { status: 308, location: `${siteBase}/blog/rye-bread` });
  expect((await request.head(`${siteBase}/blog/rye`, { maxRedirects: 0 })).status()).toBe(308);

  // A visitor lands on the new address; its canonical is the new one; the sitemap lists only the new one.
  const visitor = await (await page.context().browser()!.newContext()).newPage();
  await visitor.goto(`${siteBase}/blog/rye`);
  expect(new URL(visitor.url()).pathname).toBe(`${siteBase}/blog/rye-bread`);
  await expect(visitor.locator('link[rel="canonical"]')).toHaveAttribute("href", `${baseURL}${siteBase}/blog/rye-bread`);
  const sitemap = await (await request.get(`${siteBase}/sitemap.xml`)).text();
  expect(sitemap).toContain(`<loc>${baseURL}${siteBase}/blog/rye-bread</loc>`);
  expect(sitemap).not.toContain(`<loc>${baseURL}${siteBase}/blog/rye</loc>`);

  // Renamed again: the first address goes straight to the newest (one hop), as does the second.
  await page.getByTestId("entry-settings").getByLabel("Slug").fill("rye-loaf");
  await expect(page.getByTestId("autosave-status")).toHaveText(/^Saved at/, { timeout: 15_000 });
  await page.getByRole("button", { name: "Publish changes" }).click();
  await expect(page.getByText("Its old address /blog/rye-bread redirects to /blog/rye-loaf.")).toBeVisible({ timeout: 15_000 });
  await answers(request, `${siteBase}/blog/rye`, { status: 308, location: `${siteBase}/blog/rye-loaf` });
  await answers(request, `${siteBase}/blog/rye-bread`, { status: 308, location: `${siteBase}/blog/rye-loaf` });

  // A page moved under another, from its editor: it and the page below it redirect.
  await page.goto(`${base}/pages/${about}`);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("entry-settings").getByRole("button", { name: "Move…" }).click();
  const move = page.getByRole("dialog", { name: "Move About" });
  await move.getByLabel("Under").selectOption({ label: "Company (/company)" });
  await move.getByRole("button", { name: "Move page" }).click();
  await expect(page.getByTestId("entry-parent")).toHaveText("Company");
  await answers(request, `${siteBase}/about`, { status: 308, location: `${siteBase}/company/about` });
  await answers(request, `${siteBase}/about/team`, { status: 308, location: `${siteBase}/company/about/team` });
  expect((await visitor.goto(`${siteBase}/about/team`))!.status()).toBe(200);
  await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Team");

  // All listed on the redirects page, made by Forge.
  await page.goto(`${base}/seo/redirects`);
  const listed = page.getByTestId("redirect");
  await expect(listed).toHaveCount(4);
  await expect(listed.filter({ has: page.locator('[data-testid="redirect-destination"]', { hasText: "/blog/rye-loaf" }) })).toHaveCount(2);
  await expect(listed.first()).toContainText("Automatic: the address changed");
  await visitor.context().close();
});

test("redirects by hand on the SEO page: permanent (308) and temporary (307), to elsewhere; refused at the field; flattened; off and on; changed; deleted; the not-found page; a phone; axe", async ({ page, request }) => {
  const { org, site, base, siteBase } = await withLiveSite(page);
  for (const [title, slug] of [["Offers", "offers"], ["Contact", "contact"], ["Lost", "lost"]] as const) {
    await seedPublishedEntry(org.id, site.id, { id: id(), type: "page", title, slug, path: `/${slug}`, content: doc(`${title} page.`) });
  }
  await page.goto(base);
  await page.getByRole("navigation", { name: /^Site:/ }).getByRole("link", { name: "SEO" }).click();
  await page.getByRole("link", { name: "Redirects and the not-found page" }).click();
  await expect(page.getByRole("heading", { name: "Redirects", level: 1 })).toBeVisible();
  await expect(page.getByTestId("redirects-empty")).toBeVisible();
  const addForm = page.getByTestId("add-redirect");
  const addRedirect = async (source: string, destination: string, status?: string) => {
    await addForm.getByLabel("Old address").fill(source);
    await addForm.getByLabel("Goes to").fill(destination);
    if (status) await addForm.getByLabel("Status code").selectOption(status);
    await addForm.getByRole("button", { name: "Add redirect" }).click();
  };

  // Refused at the field: an address the site publishes; a destination that could run script.
  await addRedirect("/offers", "/contact");
  await expect(addForm.getByText("A published page or post is at /offers. Unpublish it or change its address first.")).toBeVisible();
  await addRedirect("/old-offer", "javascript:alert(1)");
  await expect(addForm.getByText("Use a path on this site (starting with /) or a full address starting with https://.")).toBeVisible();

  await addRedirect("/old-offer", "/offers");
  await expect(addForm.locator("[data-form-alert]")).toHaveText("Redirect added: /old-offer now goes to /offers.");
  await answers(request, `${siteBase}/old-offer`, { status: 308, location: `${siteBase}/offers` });
  await addRedirect("/shop", "https://shop.example.com/rye", "302");
  // The server's answer first: a visitor's request still in flight when the change commits may keep the old answer.
  await expect(addForm.locator("[data-form-alert]")).toHaveText("Redirect added: /shop now goes to https://shop.example.com/rye.");
  await answers(request, `${siteBase}/shop`, { status: 307, location: "https://shop.example.com/rye" });
  // A redirect to a redirected address goes straight to the end.
  await addRedirect("/older-offer", "/old-offer");
  await expect(addForm.locator("[data-form-alert]")).toHaveText("Redirect added: /older-offer now goes to /offers. It goes straight to /offers: /old-offer redirects there.");
  await answers(request, `${siteBase}/older-offer`, { status: 308, location: `${siteBase}/offers` });

  // Off: not found; on again.
  const row = (source: string) => page.locator(`[data-testid="redirect"][data-source="${source}"]`);
  await row("/old-offer").getByRole("button", { name: "Turn off" }).click();
  await expect(row("/old-offer")).toHaveAttribute("data-active", "false");
  await answers(request, `${siteBase}/old-offer`, { status: 404, location: null });
  await row("/old-offer").getByRole("button", { name: "Turn on" }).click();
  await expect(row("/old-offer")).toHaveAttribute("data-active", "true");
  await answers(request, `${siteBase}/old-offer`, { status: 308, location: `${siteBase}/offers` });
  // Changed: another page, temporary.
  await row("/old-offer").getByRole("button", { name: "Change" }).click();
  await row("/old-offer").getByLabel("Goes to").fill("/contact");
  await row("/old-offer").getByLabel("Status code").selectOption("307");
  await row("/old-offer").getByRole("button", { name: "Save" }).click();
  await expect(row("/old-offer").getByTestId("redirect-destination")).toHaveText("/contact");
  await answers(request, `${siteBase}/old-offer`, { status: 307, location: `${siteBase}/contact` });
  // Deleted.
  await row("/shop").getByRole("button", { name: "Delete…" }).click();
  await page.getByRole("dialog", { name: "Delete the redirect from /shop?" }).getByRole("button", { name: "Delete redirect" }).click();
  await expect(row("/shop")).toHaveCount(0);
  await answers(request, `${siteBase}/shop`, { status: 404, location: null });

  // The not-found page: a published page of the site, with a real 404.
  const notFound = page.getByTestId("not-found-page");
  await expect(notFound.getByTestId("not-found-current")).toHaveText("The theme’s own not-found page.");
  await notFound.getByLabel("Use another page").fill("Lost");
  await notFound.getByRole("button", { name: "Use Lost" }).click();
  await expect(notFound.getByTestId("not-found-current")).toContainText("Lost (/lost)");
  const visitor = await (await page.context().browser()!.newContext()).newPage();
  await expect
    .poll(async () => {
      const response = await visitor.goto(`${siteBase}/no-such-page`);
      return [response!.status(), (await visitor.getByRole("heading", { level: 1 }).textContent())?.trim()];
    }, { timeout: 15_000 })
    .toEqual([404, "Lost"]);
  // Never indexed: every robots tag says so (the page's own, and the one Next adds to a not-found answer).
  const robots = await visitor.locator('meta[name="robots"]').evaluateAll((tags) => tags.map((tag) => tag.getAttribute("content")));
  expect(robots.length).toBeGreaterThan(0);
  expect(robots.every((content) => content?.includes("noindex"))).toBe(true);
  await notFound.getByRole("button", { name: "Use the theme’s not-found page" }).click();
  await expect(notFound.getByTestId("not-found-current")).toHaveText("The theme’s own not-found page.");
  await expect
    .poll(async () => {
      const response = await visitor.goto(`${siteBase}/no-such-page`);
      return [response!.status(), (await visitor.getByRole("heading", { level: 1 }).textContent())?.trim()];
    }, { timeout: 15_000 })
    .toEqual([404, "Page not found"]);
  await visitor.context().close();

  // A phone, and axe.
  expect(await axeViolations(page)).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByTestId("redirect")).toHaveCount(2);
  expect(await sideways(page)).toBeLessThanOrEqual(0);
});

test("unpublishing sends visitors where the dialog says, or answers not found; a new blog path redirects the old index, the posts stay; Authors and Viewers have no redirects page", async ({ page, request, browser }) => {
  const { org, site, base, siteBase } = await withLiveSite(page);
  const [offer, gone] = [id(), id()];
  await seedPublishedEntry(org.id, site.id, { id: id(), type: "page", title: "Offers", slug: "offers", path: "/offers", content: doc("Offers.") });
  await seedPublishedEntry(org.id, site.id, { id: offer, type: "post", title: "Summer offer", slug: "summer-offer", path: "/blog/summer-offer", content: doc("Summer.") });
  await seedPublishedEntry(org.id, site.id, { id: gone, type: "post", title: "Gone", slug: "gone", path: "/blog/gone", content: doc("Gone.") });

  await page.goto(`${base}/posts/${offer}`);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Unpublish" }).click();
  const dialog = page.getByRole("dialog", { name: "Unpublish Summer offer?" });
  await dialog.getByLabel("Send visitors of /blog/summer-offer to (optional)").fill("/nowhere");
  await dialog.getByRole("button", { name: "Unpublish" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Nothing is published at /nowhere on this site.");
  await dialog.getByLabel("Send visitors of /blog/summer-offer to (optional)").fill("/offers");
  await dialog.getByRole("button", { name: "Unpublish" }).click();
  await expect(page.getByText("Unpublished: it is no longer on the site. Visitors of /blog/summer-offer go to /offers.")).toBeVisible();
  await answers(request, `${siteBase}/blog/summer-offer`, { status: 308, location: `${siteBase}/offers` });

  await page.goto(`${base}/posts/${gone}`);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Unpublish" }).click();
  await page.getByRole("dialog", { name: "Unpublish Gone?" }).getByRole("button", { name: "Unpublish" }).click();
  await expect(page.getByText("Unpublished: it is no longer on the site.")).toBeVisible();
  await answers(request, `${siteBase}/blog/gone`, { status: 404, location: null });

  // The blog moves to /news: the old index redirects; a post stays at the address it was published at.
  const live = id();
  await seedPublishedEntry(org.id, site.id, { id: live, type: "post", title: "Still here", slug: "still-here", path: "/blog/still-here", content: doc("Here.") });
  await page.goto(`${base}/settings`);
  const reading = page.getByRole("form", { name: "Reading settings" });
  await reading.getByLabel("Blog path").fill("news");
  await reading.getByRole("button", { name: "Save reading settings" }).click();
  await expect(page.getByText(/The blog's old address \/blog and its archives redirect to the new ones/)).toBeVisible();
  await answers(request, `${siteBase}/blog`, { status: 308, location: `${siteBase}/news` });
  expect((await answer(request, `${siteBase}/blog/still-here`)).status).toBe(200);
  expect((await answer(request, `${siteBase}/news`)).status).toBe(200);

  // Who may: Authors and Viewers have no page; the notice says who has.
  for (const role of ["author", "viewer"] as const) {
    const context = await browser.newContext();
    const other = await context.newPage();
    await asUniqueVisitor(other);
    await memberOf(other, role, org);
    await other.goto(`${base}/seo/redirects`);
    await expect(other.getByText(`A site’s redirects are for Owners, Admins and Editors of ${org.name}.`), role).toBeVisible();
    await expect(other.getByTestId("add-redirect"), role).toHaveCount(0);
    await context.close();
  }
});

test("a coming-soon site redirects nothing; another site's redirect is not this site's", async ({ request }) => {
  const soon = await seedSite("redir-soon", "Soon");
  const live = await seedSite("redir-live", "Live", { status: "live" });
  const other = await seedSite("redir-other", "Other", { status: "live" });
  for (const site of [soon, live]) {
    await seedPublishedEntry(site.orgId, site.siteId, { id: id(), type: "page", title: "Target", slug: "target", path: "/target", content: doc("Target.") });
    await inTenant(site.orgId, (c) =>
      c.query("insert into redirects (id, organization_id, site_id, source_path, destination, status_code) values ($1, $2, $3, '/old', '/target', 301)", [id(), site.orgId, site.siteId]),
    );
  }
  await seedPublishedEntry(other.orgId, other.siteId, { id: id(), type: "page", title: "Target", slug: "target", path: "/target", content: doc("Target.") });
  expect(await answer(request, `/s/${live.address}/old`)).toEqual({ status: 308, location: `/s/${live.address}/target` });
  expect((await answer(request, `/s/${soon.address}/old`)).status).toBe(200); // the coming-soon page, at every path
  expect(await answer(request, `/s/${other.address}/old`)).toEqual({ status: 404, location: null });
});
