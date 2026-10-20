import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { uuidv7 } from "uuidv7";
import { asUniqueVisitor } from "./helpers/auth";
import { axeViolations } from "./helpers/axe";
import { seedPublishedEntry, seedTerm } from "./helpers/content";
import { markEmailVerified, seedOrganization, sitesIn } from "./helpers/orgs";
import { createSite, expectSiteCreated, memberOf } from "./helpers/site-ui";
import { addMember, inTenant, seedSite, seedUser } from "./helpers/sites";

/**
 * M8-4 end to end against the production build (sites indexable, as in production: `SEARCH_INDEXING=allowed`): what a
 * live page of either theme tells search engines (title, description, canonical, robots, Open Graph, Twitter, one
 * escaped JSON-LD block), the site's sitemap (live and indexable only, valid XML; none before the site is public), the
 * host's robots.txt; the SEO page and the editor's SEO tab, set by an Owner and live at once; discouraging indexing;
 * who may; a phone; the keyboard; no axe violation.
 */

test.skip(!!process.env.E2E_BASE_URL, "a deployment decides its own indexing (SEARCH_INDEXING), and uploads here go to the local storage driver");
test.describe.configure({ timeout: 120_000 });

const tail = () => randomBytes(3).toString("hex");
const id = () => uuidv7();
const doc = (...texts: string[]) => ({ v: 1, doc: { type: "doc", content: texts.map((text) => ({ type: "paragraph", attrs: { id: id() }, content: [{ type: "text", text }] })) } });
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const picker = (page: Page) => page.getByTestId("media-picker");
const png = async (width: number, height: number, background: string) => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();

type Head = {
  title: string; description: (string | null)[]; robots: (string | null)[]; canonical: (string | null)[]; og: Record<string, string>; twitter: Record<string, string>;
  verification: (string | null)[]; jsonLd: { "@context": string; "@graph": Record<string, unknown>[] }[];
};
/** A public page's head as a crawler reads it: its title, its meta tags, its canonical link, its structured data (parsed). */
const headOf = (page: Page): Promise<Head> =>
  page.evaluate(() => {
    const contents = (selector: string) => [...document.querySelectorAll(selector)].map((element) => element.getAttribute("content"));
    const pairs = (selector: string, key: string) => Object.fromEntries([...document.querySelectorAll(selector)].map((element) => [element.getAttribute(key)!, element.getAttribute("content")!]));
    return {
      title: document.title,
      description: contents('meta[name="description"]'),
      robots: contents('meta[name="robots"]'),
      canonical: [...document.querySelectorAll('link[rel="canonical"]')].map((element) => element.getAttribute("href")),
      og: pairs('meta[property^="og:"]', "property"),
      twitter: pairs('meta[name^="twitter:"]', "name"),
      verification: contents('meta[name="google-site-verification"]'),
      jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map((element) => JSON.parse(element.textContent ?? "null")),
    };
  });
/** The `<loc>`s of a sitemap, parsed as XML by the browser; null if it is not well-formed. */
const locsOf = (page: Page, xml: string) =>
  page.evaluate((text) => {
    const parsed = new DOMParser().parseFromString(text, "application/xml");
    if (parsed.getElementsByTagName("parsererror").length) return null;
    return [...parsed.getElementsByTagNameNS("http://www.sitemaps.org/schemas/sitemap/0.9", "loc")].map((element) => element.textContent);
  }, xml);
const typesOf = (head: Head) => head.jsonLd[0]!["@graph"].map((node) => node["@type"]);
const nodeOf = (head: Head, type: string) => head.jsonLd[0]!["@graph"].find((node) => node["@type"] === type)!;

/** A member with a live site made through the form (Studio). */
async function withLiveSite(page: Page) {
  const org = await seedOrganization("seo");
  await addMember(org.id, (await seedUser("Olive Owner")).email, "owner");
  const member = await memberOf(page, "owner", org);
  await markEmailVerified(member.email);
  const address = `seo-${tail()}`;
  await page.goto(`/${org.slug}/sites/new`);
  await createSite(page, { name: "Harbour Bakery", address });
  await expectSiteCreated(page, org.slug, address);
  const [site] = await sitesIn(org.id);
  const base = `/${org.slug}/sites/${site!.slug}`;
  await page.goto(base);
  await page.getByRole("button", { name: "Publish site…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish site" }).click();
  await expect(page.getByTestId("site-status").filter({ visible: true })).toHaveText("Live", { timeout: 15_000 });
  return { org, site: site!, base, address };
}
/** Uploads through the library's dropzone and waits until the server says each file is ready. */
async function uploadInLibrary(page: Page, base: string, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.goto(`${base}/media`);
  const input = page.getByTestId("dropzone").getByLabel("Choose files");
  await expect(input).toBeEnabled();
  await input.setInputFiles(files);
  await expect(page.getByTestId("upload").and(page.locator('[data-status="ready"]'))).toHaveCount(files.length, { timeout: 30_000 });
}
const mediaIdOf = async (orgId: string, filename: string) =>
  (await inTenant(orgId, (c) => c.query<{ id: string }>("select id from media_assets where original_filename = $1 order by created_at desc limit 1", [filename]))).rows[0]!.id;

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("a live page of either theme tells search engines what it is: title, description, canonical, robots, Open Graph, Twitter, one JSON-LD block that no title can break out of; the sitemap lists only what is live and indexable", async ({ page, request, baseURL }) => {
  for (const theme of ["studio", "journal"] as const) {
    const site = await seedSite(`seo-${theme}`, "Bread from the harbour", { status: "live", theme });
    const base = `${baseURL}/s/${site.address}`;
    const bread = await seedTerm(site.orgId, site.siteId, "category", "bread", "Bread");
    await seedTerm(site.orgId, site.siteId, "tag", "empty", "Empty");
    const hostile = "Rye </script><script>window.__xss = 1</script> & more";
    const seed = (path: string, entry: Omit<Parameters<typeof seedPublishedEntry>[2], "id" | "slug" | "path">) =>
      seedPublishedEntry(site.orgId, site.siteId, { id: id(), slug: path.split("/").at(-1)!, path, ...entry });
    await seed("/blog/rye", { type: "post", title: hostile, content: doc("Dark rye, sour and dense."), excerpt: "Dark rye is back.", termIds: [bread] });
    await seed("/about-us", { type: "page", title: "About us", content: doc("We bake every night before the first ferry leaves.") });
    await seed("/hidden", { type: "page", title: "Hidden", content: doc("Not for search."), seo: { noindex: true } });
    await seed("/copy", { type: "page", title: "Copy", content: doc("A copy."), seo: { canonical: "https://elsewhere.example/original" } });
    await seed("/draft", { type: "page", title: "Draft", content: doc("Not yet."), draftOnly: true });

    await page.goto(`/s/${site.address}/blog/rye`);
    const post = await headOf(page);
    expect(post, theme).toMatchObject({
      title: `${hostile} · ${site.name}`,
      description: ["Dark rye is back."],
      robots: ["index, follow"],
      canonical: [`${base}/blog/rye`],
      og: { "og:type": "article", "og:title": `${hostile} · ${site.name}`, "og:url": `${base}/blog/rye`, "og:site_name": site.name, "og:locale": "en", "og:description": "Dark rye is back." },
      twitter: { "twitter:card": "summary", "twitter:title": `${hostile} · ${site.name}` },
      verification: [],
    });
    expect(post.jsonLd, theme).toHaveLength(1);
    expect(typesOf(post), theme).toEqual(["WebSite", "Organization", "BlogPosting", "BreadcrumbList"]);
    expect(nodeOf(post, "BlogPosting"), theme).toMatchObject({ headline: hostile, url: `${base}/blog/rye`, description: "Dark rye is back.", inLanguage: "en" });
    expect(nodeOf(post, "BreadcrumbList").itemListElement, theme).toEqual([
      { "@type": "ListItem", position: 1, name: site.name, item: base },
      { "@type": "ListItem", position: 2, name: "Blog", item: `${base}/blog` },
      { "@type": "ListItem", position: 3, name: hostile, item: `${base}/blog/rye` },
    ]);
    expect(await page.evaluate(() => (window as { __xss?: number }).__xss), theme).toBeUndefined();
    // As sent: the one block holds `<` only escaped, so no title can close it.
    const html = await (await request.get(`/s/${site.address}/blog/rye`)).text();
    const blocks = html.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g) ?? [];
    expect(blocks, theme).toHaveLength(1);
    expect(blocks[0], theme).toContain("\\u003c/script\\u003e\\u003cscript\\u003e");
    expect(html, theme).not.toContain("<script>window.__xss");

    // A page: its description from its text; the home page: the site's name, its tagline.
    await page.goto(`/s/${site.address}/about-us`);
    expect(await headOf(page), theme).toMatchObject({
      title: `About us · ${site.name}`, description: ["We bake every night before the first ferry leaves."], canonical: [`${base}/about-us`], og: { "og:type": "website" },
    });
    expect(typesOf(await headOf(page)), theme).toEqual(["WebSite", "Organization", "WebPage", "BreadcrumbList"]);
    await page.goto(`/s/${site.address}`);
    expect(await headOf(page), theme).toMatchObject({ title: site.name, description: ["Bread from the harbour"], canonical: [base], robots: ["index, follow"] });
    expect(typesOf(await headOf(page)), theme).toEqual(["WebSite", "Organization", "WebPage"]);
    await page.goto(`/s/${site.address}/hidden`);
    expect((await headOf(page)).robots, theme).toEqual(["noindex, follow"]);
    await page.goto(`/s/${site.address}/copy`);
    expect((await headOf(page)).canonical, theme).toEqual(["https://elsewhere.example/original"]);

    // The sitemap: well-formed XML, never indexed itself; the live, indexable pages, the blog and the archives with posts.
    const response = await request.get(`/s/${site.address}/sitemap.xml`);
    expect(response.status(), theme).toBe(200);
    expect(response.headers()["content-type"], theme).toBe("application/xml; charset=utf-8");
    expect(response.headers()["x-robots-tag"], theme).toBe("noindex");
    expect(await locsOf(page, await response.text()), theme).toEqual([base, `${base}/about-us`, `${base}/blog/rye`, `${base}/blog`, `${base}/blog/category/bread`]);
  }

  // Coming soon, suspended, unknown: no sitemap and nothing of the content in the page's head.
  const soon = await seedSite("seo-soon", "Soon");
  await seedPublishedEntry(soon.orgId, soon.siteId, { id: id(), type: "page", title: "Secret plans", slug: "secret-plans", path: "/secret-plans", content: doc("Secret plans.") });
  const suspended = await seedSite("seo-suspended", "Paused", { status: "suspended" });
  for (const address of [soon.address, suspended.address, `missing-${tail()}`]) {
    const response = await request.get(`/s/${address}/sitemap.xml`);
    expect(response.status(), address).toBe(404);
    expect(response.headers()["x-robots-tag"], address).toBe("noindex");
    expect(await response.text(), address).toBe("Not found");
  }
  await page.goto(`/s/${soon.address}/secret-plans`);
  expect(await headOf(page)).toMatchObject({ robots: ["noindex, nofollow"], canonical: [], og: {}, jsonLd: [] });
  // The address asked for is in the response (it is the request); the entry's title and text are not.
  expect(await page.content()).not.toContain("Secret plans");
});

test("an Owner sets the site's SEO defaults and a post's own SEO (title, description, social image) by keyboard and pointer; the live site, its sitemap and the host's robots.txt follow at once", async ({ page, browser, request, baseURL }) => {
  const { org, site, base, address } = await withLiveSite(page);
  const siteBase = `${baseURL}/s/${address}`;
  const sitemapUrl = `${siteBase}/sitemap.xml`;
  // The new live site is listed at once; the API is not for crawlers.
  const robots = async () => (await request.get("/robots.txt")).text();
  const listed = await robots();
  expect(listed).toMatch(/^User-Agent: \*$/m);
  expect(listed).toMatch(/^Allow: \/s\/$/m);
  expect(listed).toMatch(/^Disallow: \/api\/$/m);
  expect(listed).toContain(`Sitemap: ${sitemapUrl}`);

  await uploadInLibrary(page, base, [
    { name: "Default.png", mimeType: "image/png", buffer: await png(1600, 900, "#246") },
    { name: "Own.png", mimeType: "image/png", buffer: await png(1200, 630, "#a63") },
    { name: "Cover.png", mimeType: "image/png", buffer: await png(1600, 900, "#358") },
  ]);
  const post = id();
  await seedPublishedEntry(org.id, site.id, {
    id: post, type: "post", title: "Rye season", slug: "rye-season", path: "/blog/rye-season", content: doc("Rye season starts the night before."), excerpt: "Our dark rye returns.",
    featuredMediaId: await mediaIdOf(org.id, "Cover.png"),
  });
  await seedPublishedEntry(org.id, site.id, { id: id(), type: "page", title: "About us", slug: "about-us", path: "/about-us", content: doc("We bake.") });

  // The SEO page, from the site's links.
  await page.goto(base);
  await page.getByRole("navigation", { name: /^Site:/ }).getByRole("link", { name: "SEO" }).click();
  await expect(page.getByRole("heading", { name: "SEO", level: 1 })).toBeVisible();
  const form = page.getByTestId("seo-form");
  await form.getByLabel("Title template").fill("%title% | %site%");
  await expect(form.getByTestId("seo-title-example")).toHaveText("For example: About us | Harbour Bakery");
  await form.getByLabel("Default description").fill("Bread from the harbour, baked every night.");
  await form.getByTestId("seo-default-image").getByRole("button", { name: "Choose an image" }).click();
  await expect(picker(page).getByRole("heading", { name: "Choose a default social image" })).toBeVisible();
  await picker(page).getByRole("button", { name: "Choose Default.png" }).click();
  await expect(form.getByTestId("seo-default-image-preview")).toHaveAttribute("src", /\/thumb\/default\.webp$/);
  await form.getByLabel("Google Search Console verification").fill('<meta name="google-site-verification" content="tok-123_abc" />');
  await expect(form.getByTestId("seo-unsaved")).toBeVisible();
  await form.getByRole("button", { name: "Save SEO settings" }).click();
  await expect(form.locator("[data-form-alert]")).toHaveText("SEO settings saved. The site uses them now.");
  await expect(form.getByTestId("seo-unsaved")).toHaveCount(0);

  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/s/${address}/blog`);
  expect(await headOf(visitor)).toMatchObject({
    title: "Blog | Harbour Bakery", description: ["Bread from the harbour, baked every night."], canonical: [`${siteBase}/blog`],
    og: { "og:image": expect.stringMatching(/^http:\/\/localhost:\d+\/media\/o\/[^"]+\/w\d+\/default\.webp$/) }, twitter: { "twitter:card": "summary_large_image" },
  });
  await visitor.goto(`/s/${address}/about-us`);
  expect(await headOf(visitor)).toMatchObject({ title: "About us | Harbour Bakery", description: ["We bake."], og: { "og:image": expect.stringMatching(/\/default\.webp$/) } });
  await visitor.goto(`/s/${address}`);
  expect((await headOf(visitor)).verification).toEqual(["tok-123_abc"]);
  await visitor.goto(`/s/${address}/blog/rye-season`);
  expect(await headOf(visitor)).toMatchObject({ title: "Rye season | Harbour Bakery", description: ["Our dark rye returns."], og: { "og:image": expect.stringMatching(/\/cover\.webp$/) } });

  // The post's SEO tab, reached by keyboard: what it inherits, then its own.
  await page.goto(`${base}/posts/${post}`);
  await expect(page.getByTestId("editor")).toBeVisible({ timeout: 15_000 });
  const tabs = page.getByRole("tablist", { name: "Post settings" });
  await tabs.getByRole("tab", { name: "Post" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "SEO" })).toBeFocused();
  await expect(tabs.getByRole("tab", { name: "SEO" })).toHaveAttribute("aria-selected", "true");
  const seo = page.getByTestId("entry-seo");
  await expect(seo.getByTestId("seo-title-hint")).toHaveText("Inherited from the site's SEO settings.");
  await expect(seo.getByTestId("seo-description-hint")).toHaveText("Inherited from the excerpt.");
  await expect(seo.getByTestId("seo-image-hint")).toHaveText("Inherited from the featured image.");
  await expect(seo.getByTestId("seo-preview")).toContainText(`${siteBase}/blog/rye-season`);
  await expect(seo.getByTestId("seo-preview")).toContainText("Rye season | Harbour Bakery");

  await seo.getByLabel("SEO title").fill("Rye is back: order by Friday");
  await seo.getByLabel("Description", { exact: true }).fill("Dark, sour rye, baked through the night.");
  await seo.getByRole("button", { name: "Choose an image" }).click();
  await expect(picker(page).getByRole("heading", { name: "Choose a social image" })).toBeVisible();
  await picker(page).getByRole("button", { name: "Choose Own.png" }).click();
  await expect(seo.getByTestId("seo-image-preview")).toHaveAttribute("src", /\/thumb\/own\.webp$/);
  await expect(seo.getByTestId("seo-preview")).toContainText("Rye is back: order by Friday");
  await expect(seo.getByTestId("seo-title-hint")).toHaveText("This page's own title, as it is.");
  await expect(page.getByTestId("autosave-status")).toHaveText(/^Saved at/, { timeout: 15_000 });
  // Saved is not published: the site still says what it said.
  await visitor.reload();
  expect((await headOf(visitor)).title).toBe("Rye season | Harbour Bakery");

  await page.getByRole("button", { name: "Publish changes" }).click();
  await expect
    .poll(async () => {
      await visitor.reload();
      return (await headOf(visitor)).title;
    }, { timeout: 15_000 })
    .toBe("Rye is back: order by Friday");
  expect(await headOf(visitor)).toMatchObject({
    description: ["Dark, sour rye, baked through the night."], canonical: [`${siteBase}/blog/rye-season`], robots: ["index, follow"],
    og: { "og:type": "article", "og:title": "Rye is back: order by Friday", "og:image": expect.stringMatching(/\/w\d+\/own\.webp$/) },
    twitter: { "twitter:card": "summary_large_image", "twitter:image": expect.stringMatching(/\/own\.webp$/) },
  });
  expect(Object.values((await headOf(visitor)).og).join(" ")).not.toMatch(/original/);
  expect(nodeOf(await headOf(visitor), "BlogPosting")).toMatchObject({ headline: "Rye season", image: { "@type": "ImageObject", url: expect.stringMatching(/\/own\.webp$/) } });

  // A canonical must be a full https address: said at the field.
  await seo.getByLabel("Canonical address").fill("http://example.com/rye");
  await expect(seo.getByRole("alert")).toHaveText("Use a full address starting with https://.");
  await seo.getByLabel("Canonical address").fill("");
  await expect(seo.getByRole("alert")).toHaveCount(0);
  await expect(page.getByTestId("autosave-status")).toHaveText(/^(Saved at|All changes saved)/, { timeout: 15_000 });

  // Discouraging indexing: every page says noindex, the sitemap is gone, robots.txt leaves the site out; and back.
  await page.goto(`${base}/seo`);
  await form.getByLabel("Ask search engines not to index this site").check();
  await form.getByRole("button", { name: "Save SEO settings" }).click();
  await expect(form.locator("[data-form-alert]")).toHaveText("SEO settings saved. The site uses them now.");
  await visitor.reload();
  expect((await headOf(visitor)).robots).toEqual(["noindex, follow"]);
  expect((await request.get(sitemapUrl)).status()).toBe(404);
  expect(await robots()).not.toContain(sitemapUrl);
  await form.getByLabel("Ask search engines not to index this site").uncheck();
  await form.getByRole("button", { name: "Save SEO settings" }).click();
  await expect(form.locator("[data-form-alert]")).toHaveText("SEO settings saved. The site uses them now.");
  await visitor.reload();
  expect((await headOf(visitor)).robots).toEqual(["index, follow"]);
  expect(await locsOf(visitor, await (await request.get(sitemapUrl)).text())).toEqual([siteBase, `${siteBase}/about-us`, `${siteBase}/blog/rye-season`, `${siteBase}/blog`]);
  expect(await robots()).toContain(sitemapUrl);

  // Back to Coming soon: noindex, nofollow; no sitemap; not in robots.txt.
  await page.goto(base);
  await page.getByRole("button", { name: "Switch to Coming soon…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Switch to Coming soon" }).click();
  await expect(page.getByTestId("site-status").filter({ visible: true })).toHaveText("Coming soon", { timeout: 15_000 });
  await visitor.reload();
  expect((await headOf(visitor)).robots).toEqual(["noindex, nofollow"]);
  expect((await request.get(sitemapUrl)).status()).toBe(404);
  expect(await robots()).not.toContain(sitemapUrl);
  await visitor.context().close();

  // A social image is a use of the file: the trash says so before anything is moved.
  for (const [name, said] of [
    ["Own.png", "1 published page or post shows it: Rye season. They stop showing it at once."],
    ["Default.png", "It is the site’s default social image: pages shared without an image of their own go without one."],
  ] as const) {
    await page.goto(`${base}/media`);
    await page.locator(`[data-testid="media-item"][data-name="${name}"]`).getByRole("button").first().click();
    const drawer = page.getByTestId("media-drawer");
    await drawer.getByRole("button", { name: "Move to trash…" }).click();
    await expect(drawer.getByTestId("media-usage"), name).toContainText(said);
  }
});

test("Owners, Admins and Editors manage SEO; Authors and Viewers have no link to it, and the page says so; it fits a phone with no axe violation", async ({ page, browser }) => {
  const site = await seedSite("seo-roles", "Who may", { status: "live" });
  const org = { id: site.orgId, slug: `org-${site.address}`, name: `Org ${site.address}` };
  const base = `/${org.slug}/sites/${site.address}`;
  const post = id();
  await seedPublishedEntry(site.orgId, site.siteId, { id: post, type: "post", title: "Rye", slug: "rye", path: "/blog/rye", content: doc("Rye.") });

  const editor = await memberOf(page, "editor", org);
  await markEmailVerified(editor.email);
  await page.goto(base);
  await page.getByRole("navigation", { name: /^Site:/ }).getByRole("link", { name: "SEO" }).click();
  const form = page.getByTestId("seo-form");
  await form.getByLabel("Default description").fill("Set by an Editor.");
  await form.getByRole("button", { name: "Save SEO settings" }).click();
  await expect(form.locator("[data-form-alert]")).toHaveText("SEO settings saved. The site uses them now.");
  expect(await axeViolations(page)).toEqual([]);

  for (const role of ["author", "viewer"] as const) {
    const context = await browser.newContext();
    const other = await context.newPage();
    await asUniqueVisitor(other);
    await memberOf(other, role, org);
    await other.goto(base);
    await expect(other.getByRole("navigation", { name: /^Site:/ }), role).toBeVisible();
    await expect(other.getByRole("navigation", { name: /^Site:/ }).getByRole("link", { name: "SEO" }), role).toHaveCount(0);
    await other.goto(`${base}/seo`);
    await expect(other.getByText(`A site’s SEO settings are for Owners, Admins and Editors of ${org.name}.`), role).toBeVisible();
    await expect(other.getByTestId("seo-form"), role).toHaveCount(0);
    await context.close();
  }

  // A phone: the SEO page, the editor's SEO tab and the public post fit, with no axe violation.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(form).toBeVisible();
  expect(await sideways(page)).toBeLessThanOrEqual(0);
  await page.goto(`${base}/posts/${post}`);
  await expect(page.getByTestId("editor")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("tablist", { name: "Post settings" }).getByRole("tab", { name: "SEO" }).click();
  await expect(page.getByTestId("entry-seo")).toBeVisible();
  await expect(page.getByTestId("seo-description-hint")).toHaveText("Inherited from the first words of the text.");
  expect(await sideways(page)).toBeLessThanOrEqual(0);
  await page.goto(`/s/${site.address}/blog/rye`);
  expect((await headOf(page)).description).toEqual(["Rye."]);
  expect(await axeViolations(page)).toEqual([]);
});
